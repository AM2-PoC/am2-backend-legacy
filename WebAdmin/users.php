<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$admin_role = $_SESSION['admin_role'];



$stmt_auth = $pdo->prepare("SELECT can_manage_maps, can_manage_p2p, can_manage_video FROM public.admin WHERE id = ?");
$stmt_auth->execute([$current_admin_id]);
$auth = $stmt_auth->fetch();

if ($admin_role === 'superadmin') {
    $auth = ['can_manage_maps' => true, 'can_manage_p2p' => true, 'can_manage_video' => true];
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['add_user'])) {
    $id = trim($_POST['id']);
    $name = strtoupper(trim($_POST['name']));
    $pass = password_hash($_POST['password'], PASSWORD_BCRYPT);
    
    try {
        $pdo->beginTransaction();
        
        $stmt = $pdo->prepare("INSERT INTO public.users (id, name, password, role, status, admin_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'user', 'offline', ?, ?, NOW(), NOW())");
        $stmt->execute([$id, $name, $pass, $current_admin_id, $current_admin_id]);
        
        $stmt_p = $pdo->prepare("INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, updated_at) VALUES (?, false, false, false, NOW())");
        $stmt_p->execute([$id]);

        $stmtLog = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'CREATE_USER', ?, NOW())");
        $stmtLog->execute([$current_admin_id, "Mendaftarkan user baru: $name (ID: $id)"]);
        
        $pdo->commit();
        $success_msg = "User $name (User: $id) berhasil didaftarkan.";
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = ($e->getCode() == '23505') ? "ID $id sudah terdaftar." : "Database Error: " . am2_safe_error($e, 'users');
    }
}

if (isset($_GET['get_user_channels'])) {
    header('Content-Type: application/json');
    $stmt = $pdo->prepare("SELECT channel_id FROM public.user_channels WHERE user_id = ?");
    $stmt->execute([$_GET['u_id']]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
    exit;
}

if (isset($_POST['save_user_channels'])) {
    header('Content-Type: application/json');
    $u_id = $_POST['u_id'];
    if (!am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $u_id)) {
        echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
        exit;
    }
    $channels = json_decode($_POST['channels'], true) ?: [];
    try {
        $foreign = am2_first_foreign_channel($pdo, $current_admin_id, $admin_role, $channels);
        if ($foreign !== null) {
            echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
            exit;
        }
        $pdo->beginTransaction();
        // This page sends a membership list and nothing else, so the
        // permission on each surviving channel and the unit's default both
        // stand. It used to recreate every row as FULL DUPLEX, which handed
        // transmit rights to receive-only units, and moved the default to
        // whichever channel happened to come first in the JSON.
        am2_set_user_channels($pdo, (string) $u_id, $channels);
        $pdo->commit();
        syncUserChannels($u_id);
        echo json_encode(['success' => true]);
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        echo json_encode(['success' => false, 'msg' => am2_safe_error($e, 'users')]);
    }
    exit;
}

if (isset($_POST['update_feature'])) {
    header('Content-Type: application/json');
    if (!am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['u_id'] ?? '')) {
        echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
        exit;
    }
    $u_id = $_POST['u_id'];
    $feature = $_POST['feature'];

    if ($feature === 'duplex_mode') {
        $val = $_POST['val'];
        $sql_val = $pdo->quote($val);
        $status_label = "MENGUBAH MODE KE $val";
    } else {
        $val = ($_POST['val'] === 'true') ? 'true' : 'false';
        $sql_val = $val;
        $status_label = ($val === 'true') ? 'MENGAKTIFKAN' : 'MENONAKTIFKAN';
    }

    $feature_names = [
        'enable_maps' => 'Fitur Lokasi/Maps',
        'enable_p2p' => 'Fitur P2P Chat',
        'enable_ptt_video' => 'Fitur PTT Video',
        'duplex_mode' => 'Mode Duplex'
    ];

    if (!array_key_exists($feature, $feature_names)) {
        echo json_encode(['success' => false, 'msg' => 'Fitur tidak valid']); exit;
    }

    $can_change = false;
    if ($feature == 'enable_maps' && $auth['can_manage_maps']) $can_change = true;
    if ($feature == 'enable_p2p' && $auth['can_manage_p2p']) $can_change = true;
    if ($feature == 'enable_ptt_video' && $auth['can_manage_video']) $can_change = true;
    if ($feature == 'duplex_mode') $can_change = true;

    if ($can_change) {
        try {
            $pdo->beginTransaction();
            $stmtTarget = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtTarget->execute([$u_id]);
            $target_name = $stmtTarget->fetchColumn() ?: $u_id;

            $sql_upsert = "INSERT INTO public.user_app_permissions (user_id, $feature, updated_at)
                           VALUES (?, $sql_val, NOW())
                           ON CONFLICT (user_id)
                           DO UPDATE SET $feature = EXCLUDED.$feature, updated_at = NOW()";
            $pdo->prepare($sql_upsert)->execute([$u_id]);

            $stmtLogFeat = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'UPDATE_FEATURE', ?, NOW())");
            $stmtLogFeat->execute([$current_admin_id, "$status_label " . $feature_names[$feature] . " untuk: $target_name ($u_id)"]);

            $p = $pdo->prepare("SELECT * FROM public.user_app_permissions WHERE user_id = ?");
            $p->execute([$u_id]);
            $row = $p->fetch();

            $pdo->commit();
            notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'msg' => am2_safe_error($e, 'users')]);
        }
        exit;
    }
    echo json_encode(['success' => false, 'msg' => 'Akses ditolak']); exit;
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_user'])
        && !am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['edit_id'] ?? '')) {
    $error_msg = "Akses ditolak.";
    unset($_POST['edit_user']);
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_user'])) {
    $edit_id = $_POST['edit_id'];
    $edit_name = strtoupper(trim($_POST['edit_name']));
    try {
        $pdo->beginTransaction();
        if (!empty($_POST['edit_password'])) {
            $hashed = password_hash($_POST['edit_password'], PASSWORD_BCRYPT);
            $pdo->prepare("UPDATE public.users SET name = ?, password = ?, created_by = ?, updated_at = NOW() WHERE id = ?")->execute([$edit_name, $hashed, $current_admin_id, $edit_id]);
            $ket = "Update nama & password user: $edit_id ($edit_name)";
        } else {
            $pdo->prepare("UPDATE public.users SET name = ?, created_by = ?, updated_at = NOW() WHERE id = ?")->execute([$edit_name, $current_admin_id, $edit_id]);
            $ket = "Update nama user: $edit_id ke $edit_name";
        }

        $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'UPDATE_USER', ?, NOW())")->execute([$current_admin_id, $ket]);

        $pdo->commit();
        $success_msg = "Data $edit_id diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = am2_safe_error($e, 'users');
    }
}

if (isset($_POST['delete_user'])
        && !am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['delete_user'])) {
    $error_msg = "Akses ditolak.";
    unset($_POST['delete_user']);
}

if (isset($_POST['delete_user'])) {
    $del_id = $_POST['delete_user'];
    try {
        $pdo->beginTransaction();
        $stmtN = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtN->execute([$del_id]);
        $old_name = $stmtN->fetchColumn();

        $pdo->prepare("UPDATE public.users SET created_by = ? WHERE id = ?")->execute([$current_admin_id, $del_id]);
        $pdo->prepare("DELETE FROM public.users WHERE id = ? AND role = 'user'")->execute([$del_id]);

        $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'DELETE_USER', ?, NOW())")->execute([$current_admin_id, "Menghapus user: $old_name ($del_id)"]);

        $pdo->commit();
        header("Location: users.php?success=deleted"); exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error_msg = "Gagal menghapus user.";
    }
}

$search = isset($_GET['search']) ? trim($_GET['search']) : '';
$params = [];
$sql = "SELECT u.*, p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode FROM public.users u
        LEFT JOIN public.user_app_permissions p ON u.id = p.user_id 
        WHERE u.role = 'user'";

if ($admin_role !== 'superadmin') {
    $sql .= " AND u.admin_id = ?";
    $params[] = $current_admin_id;
}

if ($search !== '') {
    $sql .= " AND (u.name ILIKE ? OR u.id ILIKE ?)";
    $params[] = "%$search%";
    $params[] = "%$search%";
}

$stmt_users = $pdo->prepare($sql . " ORDER BY u.created_at DESC");
$stmt_users->execute($params);
$users = $stmt_users->fetchAll();

if ($admin_role === 'superadmin') {
    $all_channels = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC")->fetchAll();
} else {
    $stmt_ch = $pdo->prepare("SELECT DISTINCT c.id, c.display_name FROM public.channels c LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id WHERE c.created_by = ? OR amc.admin_id = ? ORDER BY c.display_name ASC");
    $stmt_ch->execute([$current_admin_id, $current_admin_id]);
    $all_channels = $stmt_ch->fetchAll();
}
?>
<?php
$pageTitle = t('usr.heading');
$pageLede  = t('usr.lede', ['n' => count($users)]);

/** Feature switches, in the order they appear on a row. */
$features = [
    ['enable_maps',      'usr.f_maps',  (bool) ($auth['can_manage_maps'] ?? false)],
    ['enable_p2p',       'usr.f_p2p',   (bool) ($auth['can_manage_p2p'] ?? false)],
    ['enable_ptt_video', 'usr.f_video', (bool) ($auth['can_manage_video'] ?? false)],
];

include 'partials/head.php';
include 'partials/shell.php';
?>

<?php if ($success_msg !== ''): ?>
    <p role="status" class="mb-5 rounded-control border-l-2 border-ok bg-ok/5 py-3 pl-3 pr-3 text-sm"><?= $success_msg ?></p>
<?php endif; ?>
<?php if ($error_msg !== ''): ?>
    <p role="alert" class="mb-5 rounded-control border-l-2 border-bad bg-bad/5 py-3 pl-3 pr-3 text-sm"><?= htmlspecialchars($error_msg) ?></p>
<?php endif; ?>

<section class="rounded-card border border-edge bg-card" x-data="usersPage()">

    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <!-- Search is a GET round trip because the list is paged by the server
             and always has been; filtering only what is on screen would lie. -->
        <form method="GET" class="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
            <input name="search" type="search" value="<?= htmlspecialchars($search ?? '') ?>"
                   class="w-full rounded-control border border-edge bg-card px-3 py-1.5 text-sm
                          transition-colors hover:border-edge-strong focus:border-brand focus:outline-none"
                   placeholder="<?= e('usr.search') ?>">
            <button type="submit"
                    class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:border-brand hover:text-brand">
                <?= e('usr.find') ?>
            </button>
            <?php if (!empty($search)): ?>
                <a href="users.php" class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle! no-underline! hover:text-ink!"><?= e('usr.clear') ?></a>
            <?php endif; ?>
        </form>

        <button type="button" @click="add.open = true"
                class="ml-auto rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px]
                       uppercase tracking-[0.15em] text-slate-950 transition-colors hover:bg-brand-hover">
            <?= e('usr.add') ?>
        </button>
    </div>

    <?php if (empty($users)): ?>
        <p class="px-5 py-12 text-center text-sm text-ink-muted"><?= e('usr.empty') ?></p>
    <?php else: ?>
    <div class="overflow-x-auto">
        <table class="data-table w-full text-sm">
            <thead>
                <tr class="border-b border-edge text-left font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('usr.unit') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('usr.features') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('usr.duplex') ?></th>
                    <th scope="col" class="px-4 py-2.5 text-right font-normal"><?= e('usr.actions') ?></th>
                </tr>
            </thead>
            <tbody class="divide-y divide-edge">
                <?php foreach ($users as $u): $uid = (string) $u['id']; ?>
                    <tr class="transition-colors hover:bg-card-muted">
                        <td data-label="<?= e('usr.unit') ?>" class="px-4 py-2.5 align-middle lg:px-5">
                            <span class="block font-medium"><?= htmlspecialchars($u['name']) ?></span>
                            <span class="block font-mono text-[10px] text-ink-subtle"><?= htmlspecialchars($uid) ?></span>
                        </td>

                        <td data-label="<?= e('usr.features') ?>" class="px-4 py-2.5 align-middle">
                            <div class="flex flex-wrap gap-1.5">
                                <?php foreach ($features as [$key, $labelKey, $allowed]):
                                    $on = (bool) ($u[$key] ?? false); ?>
                                    <button type="button"
                                            <?= $allowed ? '' : 'disabled' ?>
                                            @click="toggle($el, <?= htmlspecialchars(json_encode($uid), ENT_QUOTES, 'UTF-8') ?>, '<?= $key ?>')"
                                            data-on="<?= $on ? '1' : '0' ?>"
                                            :class="$el.dataset.on === '1'
                                                ? 'border-brand bg-brand/10 text-brand'
                                                : 'border-edge text-ink-subtle'"
                                            class="rounded-control border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em]
                                                   transition-colors enabled:hover:border-brand disabled:cursor-not-allowed disabled:opacity-40
                                                   <?= $on ? 'border-brand bg-brand/10 text-brand' : 'border-edge text-ink-subtle' ?>"
                                            title="<?= $allowed ? e($labelKey) : e('usr.not_permitted') ?>">
                                        <?= e($labelKey) ?>
                                    </button>
                                <?php endforeach; ?>
                            </div>
                        </td>

                        <td data-label="<?= e('usr.duplex') ?>" class="px-4 py-2.5 align-middle">
                            <?php $full = ($u['duplex_mode'] ?? 'HALF DUPLEX') === 'FULL DUPLEX'; ?>
                            <button type="button"
                                    @click="toggleDuplex($el, <?= htmlspecialchars(json_encode($uid), ENT_QUOTES, 'UTF-8') ?>)"
                                    data-full="<?= $full ? '1' : '0' ?>"
                                    :class="$el.dataset.full === '1' ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-ink-subtle'"
                                    class="rounded-control border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] transition-colors hover:border-accent
                                           <?= $full ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-ink-subtle' ?>"
                                    x-text="$el.dataset.full === '1' ? <?= js('usr.full') ?> : <?= js('usr.half') ?>"><?= $full ? e('usr.full') : e('usr.half') ?></button>
                        </td>

                        <td data-label="<?= e('usr.actions') ?>" class="px-4 py-2.5 text-right align-middle">
                            <div class="inline-flex gap-1.5">
                                <button type="button"
                                        @click="openChannels(<?= htmlspecialchars(json_encode($uid), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode($u['name']), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted transition-colors hover:border-brand hover:text-brand">
                                    <?= e('usr.channels') ?>
                                </button>
                                <button type="button"
                                        @click="openEdit(<?= htmlspecialchars(json_encode($uid), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode($u['name']), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted transition-colors hover:border-brand hover:text-brand">
                                    <?= e('usr.edit') ?>
                                </button>
                                <form method="POST" class="inline"
                                      onsubmit="return confirm(<?= htmlspecialchars(json_encode(t('usr.delete_confirm')), ENT_QUOTES) ?>)">
                                    <?= am2_csrf_field() ?>
                                    <input type="hidden" name="delete_user" value="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>">
                                    <button type="submit"
                                            class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle transition-colors hover:border-bad hover:text-bad">
                                        <?= e('usr.delete') ?>
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

    <!-- Toast. The old one showed the same sentence whatever happened; this one
         says what actually changed, and turns red when it did not. -->
    <div id="liveToast" x-cloak x-show="toast.text" x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0 translate-y-1"
         x-transition:enter-end="opacity-100 translate-y-0"
         x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100 translate-y-0"
         x-transition:leave-end="opacity-0 translate-y-1"
         class="fixed bottom-5 right-5 z-[80] rounded-card border px-4 py-2.5 text-sm shadow-lg"
         :class="toast.ok ? 'border-ok bg-card text-ink' : 'border-bad bg-card text-ink'"
         role="status" x-text="toast.text"></div>

    <!-- Add -->
    <div x-cloak x-show="add.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="add.open = false" @keydown.window.escape="add.open = false" role="dialog" aria-modal="true">
        <form x-show="add.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" method="POST" class="w-full max-w-sm overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <?= am2_csrf_field() ?>
            <div class="border-b border-edge px-5 py-4"><h2 class="text-sm font-semibold"><?= e('usr.add_title') ?></h2></div>
            <div class="space-y-4 px-5 py-4">
                <div>
                    <label for="id" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.id') ?></label>
                    <input id="id" name="id" type="text" required
                           class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none">
                </div>
                <div>
                    <label for="name" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.name') ?></label>
                    <input id="name" name="name" type="text" required
                           class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2 text-sm focus:border-brand focus:outline-none">
                </div>
                <div x-data="{ shown: false }">
                    <label for="pass_add" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.password') ?></label>
                    <div class="mt-2 flex gap-2">
                        <input id="pass_add" name="password" required :type="shown ? 'text' : 'password'"
                               class="w-full rounded-control border border-edge bg-card px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none">
                        <button type="button" @click="shown = !shown" :aria-pressed="shown ? 'true' : 'false'"
                                class="rounded-control border border-edge px-2 font-mono text-[10px] uppercase text-ink-subtle hover:text-ink"
                                x-text="shown ? <?= js('login.hide_password') ?> : <?= js('login.show_password') ?>"><?= e('login.show_password') ?></button>
                    </div>
                </div>
            </div>
            <div class="flex justify-end gap-2 border-t border-edge px-5 py-3">
                <button type="button" @click="add.open = false"
                        class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink"><?= e('ch.cancel') ?></button>
                <button type="submit" name="add_user" value="1"
                        class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover"><?= e('ch.save') ?></button>
            </div>
        </form>
    </div>

    <!-- Edit -->
    <div id="editModal" x-cloak x-show="edit.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="edit.open = false" @keydown.window.escape="edit.open = false" role="dialog" aria-modal="true">
        <form x-show="edit.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" method="POST" class="w-full max-w-sm overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="edit_id" id="edit_id" :value="edit.id">
            <div class="border-b border-edge px-5 py-4"><h2 class="text-sm font-semibold"><?= e('usr.edit_title') ?></h2></div>
            <div class="space-y-4 px-5 py-4">
                <div>
                    <label for="edit_name" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.name') ?></label>
                    <input id="edit_name" name="edit_name" type="text" required x-model="edit.name"
                           class="mt-2 w-full rounded-control border border-edge bg-card px-3 py-2 text-sm focus:border-brand focus:outline-none">
                </div>
                <div x-data="{ shown: false }">
                    <label for="pass_edit" class="block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.new_password') ?></label>
                    <div class="mt-2 flex gap-2">
                        <input id="pass_edit" name="edit_password" :type="shown ? 'text' : 'password'"
                               class="w-full rounded-control border border-edge bg-card px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none">
                        <button type="button" @click="shown = !shown" :aria-pressed="shown ? 'true' : 'false'"
                                class="rounded-control border border-edge px-2 font-mono text-[10px] uppercase text-ink-subtle hover:text-ink"
                                x-text="shown ? <?= js('login.hide_password') ?> : <?= js('login.show_password') ?>"><?= e('login.show_password') ?></button>
                    </div>
                    <p class="mt-1.5 text-xs text-ink-subtle"><?= e('usr.password_hint') ?></p>
                </div>
            </div>
            <div class="flex justify-end gap-2 border-t border-edge px-5 py-3">
                <button type="button" @click="edit.open = false"
                        class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink"><?= e('ch.cancel') ?></button>
                <button type="submit" name="edit_user" value="1"
                        class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover"><?= e('ch.save') ?></button>
            </div>
        </form>
    </div>

    <!-- Quick channel assignment -->
    <div id="channelModal" x-cloak x-show="ch.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="ch.open = false" @keydown.window.escape="ch.open = false" role="dialog" aria-modal="true">
        <div x-show="ch.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" class="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <div class="border-b border-edge px-5 py-4">
                <h2 class="text-sm font-semibold"><?= e('usr.channels_title') ?></h2>
                <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand" id="ch_user_name" x-text="ch.name"></p>
                <input type="hidden" id="ch_user_id" :value="ch.id">
            </div>
            <div class="flex items-center justify-between border-b border-edge px-5 py-2.5">
                <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" id="selectAllChannels" @change="toggleAllChannels($event.target.checked)"
                           class="h-4 w-4 rounded-sm border-edge-strong accent-brand">
                    <?= e('ch.select_all') ?>
                </label>
                <!-- The first ticked channel becomes the default, and without a
                     valid default the unit cannot sign in at all. -->
                <span class="font-mono text-[9px] uppercase tracking-[0.15em] text-ink-subtle"><?= e('usr.first_is_default') ?></span>
            </div>
            <div class="flex-1 overflow-y-auto px-5 py-3">
                <?php foreach ($all_channels as $c): ?>
                    <label class="flex items-center gap-3 rounded-control px-2 py-1.5 text-sm hover:bg-card-muted">
                        <input type="checkbox" class="quick-ch-checkbox h-4 w-4 rounded-sm border-edge-strong accent-brand"
                               value="<?= (int) $c['id'] ?>">
                        <span class="min-w-0 flex-1 truncate"><?= htmlspecialchars($c['display_name']) ?></span>
                    </label>
                <?php endforeach; ?>
            </div>
            <div class="flex justify-end gap-2 border-t border-edge px-5 py-3">
                <button type="button" @click="ch.open = false"
                        class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink"><?= e('ch.cancel') ?></button>
                <button type="button" @click="saveChannels()" :disabled="ch.saving"
                        class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover disabled:opacity-60"><?= e('ch.save') ?></button>
            </div>
        </div>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
    const AM2_CSRF = <?= json_encode(am2_csrf_token()) ?>;
    const USR_MSG = <?= json_encode([
        'saved'   => t('usr.saved'),
        'failed'  => t('usr.failed'),
        'offline' => t('usr.offline'),
    ]) ?>;

    function usersPage() {
        return {
            toast: { text: '', ok: true },
            add:  { open: false },
            edit: { open: false, id: null, name: '' },
            ch:   { open: false, id: null, name: '', saving: false },

            say(text, ok = true) {
                this.toast = { text, ok };
                setTimeout(() => { this.toast.text = ''; }, 3000);
            },

            async post(fields) {
                const fd = new FormData();
                Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
                fd.append('_csrf', AM2_CSRF);
                const res = await fetch('users.php', { method: 'POST', body: fd });
                return res.json();
            },

            // The button holds its own state in a data attribute, so a failed
            // request can put it back rather than leaving the row lying.
            async toggle(el, uid, feature) {
                const next = el.dataset.on !== '1';
                el.dataset.on = next ? '1' : '0';
                try {
                    const r = await this.post({ update_feature: '1', u_id: uid, feature, val: next ? 'true' : 'false' });
                    if (!r.success) throw new Error(r.msg || 'failed');
                    this.say(USR_MSG.saved);
                } catch (err) {
                    el.dataset.on = next ? '0' : '1';
                    this.say(String(err.message || USR_MSG.failed), false);
                }
            },

            async toggleDuplex(el, uid) {
                const next = el.dataset.full !== '1';
                el.dataset.full = next ? '1' : '0';
                try {
                    const r = await this.post({
                        update_feature: '1', u_id: uid, feature: 'duplex_mode',
                        val: next ? 'FULL DUPLEX' : 'HALF DUPLEX',
                    });
                    if (!r.success) throw new Error(r.msg || 'failed');
                    this.say(USR_MSG.saved);
                } catch (err) {
                    el.dataset.full = next ? '0' : '1';
                    this.say(String(err.message || USR_MSG.failed), false);
                }
            },

            openEdit(id, name) { this.edit = { open: true, id, name }; },

            async openChannels(id, name) {
                this.ch = { open: true, id, name, saving: false };
                document.querySelectorAll('.quick-ch-checkbox').forEach((c) => { c.checked = false; });
                document.getElementById('selectAllChannels').checked = false;
                try {
                    const res = await fetch(`users.php?get_user_channels=1&u_id=${encodeURIComponent(id)}`);
                    const ids = new Set((await res.json() ?? []).map(String));
                    document.querySelectorAll('.quick-ch-checkbox').forEach((c) => {
                        c.checked = ids.has(String(c.value));
                    });
                } catch {
                    this.say(USR_MSG.offline, false);
                }
            },

            toggleAllChannels(on) {
                document.querySelectorAll('.quick-ch-checkbox').forEach((c) => { c.checked = on; });
            },

            async saveChannels() {
                this.ch.saving = true;
                const picked = [...document.querySelectorAll('.quick-ch-checkbox:checked')]
                    .map((c) => Number(c.value));
                try {
                    const r = await this.post({
                        save_user_channels: '1', u_id: this.ch.id, channels: JSON.stringify(picked),
                    });
                    if (!r.success) throw new Error(r.msg || 'failed');
                    this.ch.open = false;
                    this.say(USR_MSG.saved);
                } catch (err) {
                    this.say(String(err.message || USR_MSG.failed), false);
                } finally {
                    this.ch.saving = false;
                }
            },
        };
    }
</script>
</body>
</html>
