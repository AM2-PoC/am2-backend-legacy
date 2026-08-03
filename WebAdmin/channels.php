<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];


if (isset($_GET['ajax_action'])) {
    header('Content-Type: application/json');
    if ($_GET['ajax_action'] === 'get_channel_users') {
        $ch_id = (int)$_GET['channel_id'];
        $stmt = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt->execute([$ch_id]);
        echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['add_channel'])) {
    $display_name = strtoupper(trim($_POST['display_name']));
    $name = strtolower(str_replace(' ', '_', $display_name));
    $category = 'public';

    try {
        $stmt = $pdo->prepare("INSERT INTO public.channels (name, display_name, category, created_by) VALUES (?, ?, ?, ?)");
        $stmt->execute([$name, $display_name, $category, $current_admin_id]);
        $success_msg = "Channel <strong>$display_name</strong> berhasil dibuat.";
    } catch (PDOException $e) {
        $error_msg = ($e->getCode() == 23505) ? "Gagal: Nama channel sudah terdaftar." : "Error: " . am2_safe_error($e, 'channels');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['save_channel_access'])) {
    $ch_id = (int)$_POST['manage_ch_id'];
    $selected_users = $_POST['users'] ?? [];

    try {
        $pdo->beginTransaction();

        $stmt_old = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt_old->execute([$ch_id]);
        $old_users = $stmt_old->fetchAll(PDO::FETCH_COLUMN);

        // Only the units this admin owns may be added or dropped; a shared
        // channel keeps another tenant's units on it either way.
        $scope = null;
        if (strtolower($role_user) !== 'superadmin') {
            $stmtScope = $pdo->prepare("SELECT id FROM public.users WHERE admin_id = ?");
            $stmtScope->execute([$current_admin_id]);
            $scope = array_map('strval', array_column($stmtScope->fetchAll(), 'id'));

            $foreign = array_diff(array_map('strval', $selected_users), $scope);
            if ($foreign) {
                throw new RuntimeException('Akses ditolak');
            }
        }

        // Recreating the roster used to write is_default = 'false' for every
        // member, so editing a channel stripped the default from every unit
        // on it while users.last_channel_id went on pointing here.
        am2_set_channel_members($pdo, (string) $ch_id, $selected_users, $scope);

        $pdo->commit();

        $all_affected_users = array_unique(array_merge($old_users, $selected_users));
        foreach ($all_affected_users as $uid) {
            syncUserChannels($uid);
        }

        $success_msg = "Izin akses channel berhasil diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menyimpan akses: " . am2_safe_error($e, 'channels');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_channel'])) {
    $edit_id = (int)$_POST['edit_id'];
    $edit_display = strtoupper(trim($_POST['edit_display_name']));
    $edit_category = 'public';

    try {
        if (strtolower($role_user) === 'superadmin') {
            $stmt = $pdo->prepare("UPDATE public.channels SET display_name = ?, category = ? WHERE id = ?");
            $stmt->execute([$edit_display, $edit_category, $edit_id]);
        } else {
            $stmt = $pdo->prepare("UPDATE public.channels SET display_name = ?, category = ? WHERE id = ? AND created_by = ?");
            $stmt->execute([$edit_display, $edit_category, $edit_id, $current_admin_id]);
        }
        $success_msg = "Perubahan channel berhasil disimpan.";
    } catch (PDOException $e) {
        $error_msg = "Gagal memperbarui channel: " . am2_safe_error($e, 'channels');
    }
}

if (isset($_POST['delete_channel'])) {
    $id = (int)$_POST['delete_channel'];
    try {
        $pdo->beginTransaction();
        $stmt_get = $pdo->prepare("SELECT name FROM public.channels WHERE id = ?");
        $stmt_get->execute([$id]);
        $channel_info = $stmt_get->fetch(PDO::FETCH_ASSOC);
        if ($channel_info) {
            $channel_name = $channel_info['name'];
            $pdo->prepare("UPDATE public.users SET current_channel = NULL WHERE current_channel = ?")->execute([$channel_name]);
            $pdo->prepare("DELETE FROM public.ptt_logs WHERE channel_id = ?")->execute([$id]);
            $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE channel_id = ?")->execute([$id]);
            $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ?")->execute([$id]);

            if (strtolower($role_user) === 'superadmin') {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ?");
                $stmt_del->execute([$id]);
            } else {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ? AND created_by = ?");
                $stmt_del->execute([$id, $current_admin_id]);
            }

            if ($stmt_del->rowCount() > 0) {
                $pdo->commit();
                header("Location: channels.php?success=deleted"); exit;
            }
        }
        $pdo->rollBack();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menghapus: " . am2_safe_error($e, 'channels');
    }
}

try {
    if (strtolower($role_user) === 'superadmin') {
        $stmt = $pdo->prepare("
            SELECT c.*, a.username as creator_name, 'OWNER' as ownership_type,
            (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
            (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id) as total_access
            FROM public.channels c 
            LEFT JOIN public.admin a ON c.created_by = a.id
            ORDER BY c.display_name ASC
        ");
        $stmt->execute();
    } else {
        $stmt = $pdo->prepare("
            SELECT c.*, a.username as creator_name, 
            CASE WHEN c.created_by = ? THEN 'OWNER' ELSE 'DELEGATED' END as ownership_type,
            (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
            (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id AND uc.user_id IN (SELECT id FROM public.users WHERE admin_id = ?)) as total_access
            FROM public.channels c
            LEFT JOIN public.admin a ON c.created_by = a.id
            LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
            WHERE c.created_by = ? OR amc.admin_id = ?
            ORDER BY ownership_type DESC, c.display_name ASC
        ");
        $stmt->execute([$current_admin_id, $current_admin_id, $current_admin_id, $current_admin_id]);
    }
    $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $count_owned = 0; $count_delegated = 0;
    foreach ($channels as $c) {
        if ($c['ownership_type'] === 'OWNER') $count_owned++; else $count_delegated++;
    }
} catch (PDOException $e) { $channels = []; $count_owned = 0; $count_delegated = 0; }

$role_check = strtolower($role_user);
if ($role_check === 'superadmin') {
    $stmt_u = $pdo->query("SELECT id, name FROM public.users WHERE role = 'user' ORDER BY name ASC");
} else {
    $stmt_u = $pdo->prepare("SELECT id, name FROM public.users WHERE role = 'user' AND admin_id = ? ORDER BY name ASC");
    $stmt_u->execute([$current_admin_id]);
}
$managed_users = $stmt_u->fetchAll(PDO::FETCH_ASSOC);
?>
<?php
$pageTitle = t('ch.heading');
$pageLede  = t('ch.lede', ['n' => count($channels)]);

// Still Alpine-driven; shell_end.php loads the runtime only for these.
$pageUsesAlpine = true;

include 'partials/head.php';
include 'partials/shell.php';
?>

<?php if ($success_msg !== ''): ?>
    <p role="status" class="mb-5 rounded-control border-l-2 border-ok bg-ok/5 py-3 pl-3 pr-3 text-sm">
        <?= $success_msg ?>
    </p>
<?php endif; ?>
<?php if ($error_msg !== ''): ?>
    <p role="alert" class="mb-5 rounded-control border-l-2 border-bad bg-bad/5 py-3 pl-3 pr-3 text-sm">
        <?= htmlspecialchars($error_msg) ?>
    </p>
<?php endif; ?>

<section class="rounded-card border border-edge bg-card"
         x-data="channelPage()">

    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <div class="relative min-w-0 flex-1 sm:max-w-xs">
            <input id="searchInput" x-model="query" type="search" autocomplete="off"
                   class="w-full rounded-control border border-edge bg-card px-3 py-1.5 text-sm text-ink
                          transition-colors hover:border-edge-strong focus:border-brand focus:outline-none"
                   placeholder="<?= e('ch.search') ?>">
        </div>
        <p class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
            <span class="tabular-nums text-ink-muted"><?= (int) $count_owned ?></span> <?= e('ch.owned') ?>
            <?php if ($count_delegated > 0): ?>
                · <span class="tabular-nums text-ink-muted"><?= (int) $count_delegated ?></span> <?= e('ch.delegated') ?>
            <?php endif; ?>
        </p>

        <form method="POST" class="ml-auto flex flex-wrap items-center gap-2">
            <?= am2_csrf_field() ?>
            <label for="display_name" class="sr-only"><?= e('ch.new_name') ?></label>
            <input id="display_name" name="display_name" type="text" required
                   class="w-44 rounded-control border border-edge bg-card px-3 py-1.5 text-sm
                          transition-colors hover:border-edge-strong focus:border-brand focus:outline-none"
                   placeholder="<?= e('ch.new_placeholder') ?>">
            <button type="submit" name="add_channel" value="1"
                    class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px]
                           uppercase tracking-[0.15em] text-slate-950 transition-colors hover:bg-brand-hover">
                <?= e('ch.add') ?>
            </button>
        </form>
    </div>

    <?php if (empty($channels)): ?>
        <p class="px-5 py-12 text-center text-sm text-ink-muted"><?= e('ch.empty') ?></p>
    <?php else: ?>
    <div class="overflow-x-auto">
        <table class="data-table w-full text-sm">
            <thead>
                <tr class="border-b border-edge text-left font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('ch.name') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('ch.access') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('ch.owner') ?></th>
                    <th scope="col" class="px-4 py-2.5 text-right font-normal"><?= e('ch.actions') ?></th>
                </tr>
            </thead>
            <tbody class="divide-y divide-edge">
                <?php foreach ($channels as $c): ?>
                    <tr class="channel-row transition-colors hover:bg-card-muted"
                        data-name="<?= htmlspecialchars(strtolower($c['display_name'] . ' ' . $c['name']), ENT_QUOTES, 'UTF-8') ?>"
                        x-show="matches($el)">
                        <td data-label="<?= e('ch.name') ?>" class="px-4 py-2.5 align-top lg:px-5">
                            <span class="block font-medium"><?= htmlspecialchars($c['display_name']) ?></span>
                            <span class="block font-mono text-[10px] text-ink-subtle"><?= htmlspecialchars($c['name']) ?></span>
                        </td>
                        <td data-label="<?= e('ch.access') ?>" class="px-4 py-2.5 align-top">
                            <span class="font-mono tabular-nums"><?= (int) $c['total_access'] ?></span>
                            <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('ch.units') ?></span>
                        </td>
                        <td data-label="<?= e('ch.owner') ?>" class="px-4 py-2.5 align-top">
                            <span class="text-ink-muted"><?= htmlspecialchars($c['creator_name'] ?? 'System') ?></span>
                            <?php if (($c['ownership_type'] ?? '') !== 'OWNER'): ?>
                                <span class="ml-1 rounded-control bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-accent">
                                    <?= e('ch.delegated_tag') ?>
                                </span>
                            <?php endif; ?>
                        </td>
                        <td data-label="<?= e('ch.actions') ?>" class="px-4 py-2.5 text-right align-top">
                            <div class="inline-flex gap-1.5">
                                <button type="button"
                                        @click="openAccess(<?= (int) $c['id'] ?>, <?= htmlspecialchars(json_encode($c['display_name']), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted transition-colors hover:border-brand hover:text-brand">
                                    <?= e('ch.manage_access') ?>
                                </button>
                                <button type="button"
                                        @click="openEdit(<?= (int) $c['id'] ?>, <?= htmlspecialchars(json_encode($c['display_name']), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted transition-colors hover:border-brand hover:text-brand">
                                    <?= e('ch.edit') ?>
                                </button>
                                <form method="POST" class="inline"
                                      onsubmit="return confirm(<?= htmlspecialchars(json_encode(t('ch.delete_confirm')), ENT_QUOTES) ?>)">
                                    <?= am2_csrf_field() ?>
                                    <input type="hidden" name="delete_channel" value="<?= (int) $c['id'] ?>">
                                    <button type="submit"
                                            class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle transition-colors hover:border-bad hover:text-bad">
                                        <?= e('ch.delete') ?>
                                    </button>
                                </form>
                            </div>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php endif; ?>

    <!-- Access modal. The user list is rendered server-side and ticked from the
         endpoint, the same shape the page has always used. -->
    <div id="accessModal" x-cloak x-show="access.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="access.open = false" @keydown.window.escape="access.open = false"
         role="dialog" aria-modal="true">
        <form x-show="access.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" method="POST" class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="manage_ch_id" id="target_ch_id" :value="access.id">

            <div class="border-b border-edge px-5 py-4">
                <h2 class="text-sm font-semibold"><?= e('ch.manage_access') ?></h2>
                <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand"
                   id="target_ch_name" x-text="access.name"></p>
            </div>

            <div class="flex items-center justify-between border-b border-edge px-5 py-2.5">
                <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" id="selectAllUsers" @change="toggleAll($event.target.checked)"
                           class="h-4 w-4 rounded-sm border-edge-strong accent-brand focus:ring-brand">
                    <?= e('ch.select_all') ?>
                </label>
                <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <span class="tabular-nums text-ink-muted" x-text="access.checked"></span> / <?= count($managed_users) ?>
                </span>
            </div>

            <div class="flex-1 overflow-y-auto px-5 py-3">
                <?php foreach ($managed_users as $u): ?>
                    <label class="user-item flex items-center gap-3 rounded-control px-2 py-1.5 text-sm hover:bg-card-muted">
                        <input type="checkbox" class="user-checkbox h-4 w-4 rounded-sm border-edge-strong accent-brand focus:ring-brand"
                               name="users[]" value="<?= htmlspecialchars($u['id'], ENT_QUOTES, 'UTF-8') ?>"
                               @change="recount()">
                        <span class="min-w-0 flex-1 truncate"><?= htmlspecialchars($u['name']) ?></span>
                        <span class="font-mono text-[10px] text-ink-subtle"><?= htmlspecialchars($u['id']) ?></span>
                    </label>
                <?php endforeach; ?>
            </div>

            <div class="flex justify-end gap-2 border-t border-edge px-5 py-3">
                <button type="button" @click="access.open = false"
                        class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink">
                    <?= e('ch.cancel') ?>
                </button>
                <button type="submit" name="save_channel_access" value="1"
                        class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover">
                    <?= e('ch.save') ?>
                </button>
            </div>
        </form>
    </div>

    <div id="editModal" x-cloak x-show="edit.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="edit.open = false" @keydown.window.escape="edit.open = false"
         role="dialog" aria-modal="true">
        <form x-show="edit.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" method="POST" class="w-full max-w-sm overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="edit_id" :value="edit.id">
            <div class="border-b border-edge px-5 py-4">
                <h2 class="text-sm font-semibold"><?= e('ch.edit_title') ?></h2>
            </div>
            <div class="px-5 py-4">
                <label for="edit_display_name" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <?= e('ch.display_name') ?>
                </label>
                <input id="edit_display_name" name="edit_display_name" type="text" required x-model="edit.name"
                       class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2 text-sm
                              transition-colors hover:border-edge-strong focus:border-brand focus:outline-none">
            </div>
            <div class="flex justify-end gap-2 border-t border-edge px-5 py-3">
                <button type="button" @click="edit.open = false"
                        class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink">
                    <?= e('ch.cancel') ?>
                </button>
                <button type="submit" name="edit_channel" value="1"
                        class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover">
                    <?= e('ch.save') ?>
                </button>
            </div>
        </form>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
    function channelPage() {
        return {
            query: '',
            access: { open: false, id: null, name: '', checked: 0 },
            edit:   { open: false, id: null, name: '' },

            // Filters on a data attribute rather than the rendered text, so
            // adding or removing a column cannot change what a search finds.
            matches(el) {
                const q = this.query.trim().toLowerCase();
                return !q || (el.dataset.name || '').includes(q);
            },

            async openAccess(id, name) {
                this.access = { open: true, id, name, checked: 0 };
                document.querySelectorAll('.user-checkbox').forEach((c) => { c.checked = false; });
                document.getElementById('selectAllUsers').checked = false;
                try {
                    const res = await fetch(`channels.php?ajax_action=get_channel_users&channel_id=${id}`);
                    const ids = await res.json();
                    const wanted = new Set((ids ?? []).map(String));
                    document.querySelectorAll('.user-checkbox').forEach((c) => {
                        c.checked = wanted.has(String(c.value));
                    });
                } catch (err) {
                    console.error('Could not load channel access:', err);
                }
                this.recount();
            },

            openEdit(id, name) { this.edit = { open: true, id, name }; },

            toggleAll(on) {
                document.querySelectorAll('.user-checkbox').forEach((c) => { c.checked = on; });
                this.recount();
            },

            recount() {
                this.access.checked = document.querySelectorAll('.user-checkbox:checked').length;
            },
        };
    }
</script>
</body>
</html>
