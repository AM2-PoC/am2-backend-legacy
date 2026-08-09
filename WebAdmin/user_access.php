<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];



if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['action']) && $_POST['action'] == 'db_force_logout') {
    $uid_to_kick = $_POST['user_id'];
    if (!am2_admin_owns_user($pdo, $current_admin_id, $role_user, $uid_to_kick)) {
        header('Content-Type: application/json');
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Akses ditolak']);
        exit;
    }
    try {
        $pdo->beginTransaction();

        $stmtU = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtU->execute([$uid_to_kick]);
        $target_name = $stmtU->fetchColumn() ?: "ID: $uid_to_kick";

        $sqlKick = "UPDATE public.users
                    SET force_logout = TRUE, 
                        status = 'offline', 
                        current_device_id = NULL 
                    WHERE id = ?";
        $stmtKick = $pdo->prepare($sqlKick);
        $stmtKick->execute([$uid_to_kick]);

        $stmtLog = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, ?, ?, NOW())");
        $stmtLog->execute([$current_admin_id, 'FORCE_LOGOUT', "Memutus paksa koneksi user: $target_name"]);

        $pdo->commit();

        notifyForceLogout($uid_to_kick);

        header('Content-Type: application/json');
        echo json_encode(['success' => true]);
        exit;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        header('Content-Type: application/json', true, 500);
        echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'user_access')]);
        exit;
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['update_multi_access'])) {
    $user_id = $_POST['user_id'];

    /*
     * The same guard the force-logout path above carries, and the one this page
     * most needed: this block deletes the target's entire channel membership,
     * writes a new one, moves last_channel_id, and pushes the result to the
     * relay. Without it a branch admin could post another branch's user id --
     * from their own page, with their own valid CSRF token -- and take that
     * unit off every channel it belongs to, or graft it onto one of theirs.
     *
     * The API twin of this action was guarded and the panel original was not,
     * which is the harder half to notice: the endpoint that looks like the
     * dangerous one had the check.
     */
    if (!am2_admin_owns_user($pdo, $current_admin_id, $role_user, $user_id)) {
        http_response_code(403);
        exit('Akses ditolak');
    }

    $selected_channels = $_POST['channels'] ?? [];
    $default_channel_id = $_POST['default_channel'] ?? null;
    $permissions_input = $_POST['permissions'] ?? [];

    // The form is rendered from this admin's own units and channels, but a
    // form is not an authorization: the ids arrive over POST and had never
    // been checked against who is asking.
    if (!am2_admin_owns_user($pdo, $current_admin_id, $role_user, (string) $user_id)) {
        $error_msg = t('common.denied');
    } elseif (am2_first_foreign_channel($pdo, $current_admin_id, $role_user, $selected_channels) !== null) {
        $error_msg = t('common.denied');
    } else {
        try {
            $pdo->beginTransaction();

            $stmtUser = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtUser->execute([$user_id]);
            $target_name = $stmtUser->fetchColumn() ?: "ID: $user_id";

            // The one surface that states permissions and the default outright.
            $result = am2_set_user_channels(
                $pdo, (string) $user_id, $selected_channels, $default_channel_id, $permissions_input
            );

            if ($selected_channels) {
                $stmtChName = $pdo->prepare("SELECT display_name FROM public.channels WHERE id = ?");
                $channel_names_added = [];
                foreach ($selected_channels as $ch_id) {
                    $stmtChName->execute([$ch_id]);
                    $c_name = $stmtChName->fetchColumn();
                    $is_default = ((string) $ch_id === (string) $result['default']);
                    $perm = $result['permissions'][(string) $ch_id] ?? 'FULL DUPLEX';
                    $channel_names_added[] = $c_name . ($is_default ? " (Main)" : "") . " [$perm]";
                }
                $keterangan_log = "Update akses $target_name ke: " . implode(", ", $channel_names_added);
            } else {
                $keterangan_log = "Mencabut semua akses channel dari user: $target_name";
            }

            $stmtLogAccess = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, ?, ?, NOW())");
            $stmtLogAccess->execute([$current_admin_id, 'UPDATE_ACCESS', $keterangan_log]);

            $pdo->commit();
            syncUserChannels($user_id);
            $success_msg = "Otoritas akses user berhasil diperbarui.";
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            $error_msg = "Gagal memperbarui database: " . am2_safe_error($e, 'user_access');
        }
    }
}

if ($role_user !== 'superadmin') {
    $sql_ch = "SELECT DISTINCT c.id, c.display_name
               FROM public.channels c
               LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
               WHERE c.created_by = ? OR amc.admin_id = ?
               ORDER BY c.display_name ASC";
    $stmt_ch = $pdo->prepare($sql_ch);
    $stmt_ch->execute([$current_admin_id, $current_admin_id]);
} else {
    $stmt_ch = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC");
}
$all_channels = $stmt_ch->fetchAll(PDO::FETCH_ASSOC);

$search = isset($_GET['search']) ? trim($_GET['search']) : '';
$params = [];

$sql_access = "SELECT u.id, u.name, 
               STRING_AGG(CASE WHEN uc.is_default THEN '*' || c.display_name ELSE c.display_name END, ', ' ORDER BY uc.is_default DESC) as allowed_channels,
               json_agg(c.id ORDER BY uc.is_default DESC) as channel_ids_json,
               json_agg(uc.permission ORDER BY uc.is_default DESC) as permissions_json,
               MAX(CASE WHEN uc.is_default THEN uc.channel_id END) as default_id
               FROM public.users u
               LEFT JOIN public.user_channels uc ON u.id = uc.user_id
               LEFT JOIN public.channels c ON uc.channel_id = c.id
               WHERE u.role = 'user'";

if ($role_user !== 'superadmin') {
    $sql_access .= " AND u.admin_id = ?";
    $params[] = $current_admin_id;
}

if ($search !== '') {
    $sql_access .= " AND (u.name ILIKE ? OR u.id::text ILIKE ?)";
    $params[] = "%$search%";
    $params[] = "%$search%";
}

$sql_access .= " GROUP BY u.id, u.name ORDER BY u.name ASC";

$stmt_acc = $pdo->prepare($sql_access);
$stmt_acc->execute($params);
$access_list = $stmt_acc->fetchAll(PDO::FETCH_ASSOC);
?>
<?php
$pageTitle = t('acc.heading');
$pageLede  = t('acc.lede');

// Still Alpine-driven; shell_end.php loads the runtime only for these.
$pageUsesAlpine = true;

include 'partials/head.php';
include 'partials/shell.php';
?>

<?php if ($success_msg !== ''): ?>
    <p role="status" class="mb-5 rounded-control border-l-2 border-ok bg-ok/5 py-3 pl-3 pr-3 text-sm"><?= $success_msg ?></p>
<?php endif; ?>
<?php if ($error_msg !== ''): ?>
    <p role="alert" class="mb-5 rounded-control border-l-2 border-bad bg-bad/5 py-3 pl-3 pr-3 text-sm"><?= htmlspecialchars($error_msg) ?></p>
<?php endif; ?>

<section class="rounded-card border border-edge bg-card" x-data="accessPage()">

    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <form method="GET" class="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
            <input name="search" type="search" value="<?= htmlspecialchars($search ?? '') ?>"
                   class="w-full rounded-control border border-edge bg-card px-3 py-1.5 text-sm
                          transition-colors hover:border-edge-strong focus:border-brand focus:outline-none"
                   placeholder="<?= e('acc.search') ?>">
            <button type="submit"
                    class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:border-brand hover:text-brand">
                <?= e('usr.find') ?>
            </button>
        </form>
        <p class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
            <span class="tabular-nums text-ink-muted"><?= count($access_list) ?></span> <?= e('acc.units') ?>
        </p>
    </div>

    <?php if (empty($access_list)): ?>
        <p class="px-5 py-12 text-center text-sm text-ink-muted"><?= e('usr.empty') ?></p>
    <?php else: ?>
    <div class="overflow-x-auto">
        <table class="data-table w-full text-sm">
            <thead>
                <tr class="border-b border-edge text-left font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('usr.unit') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('acc.channels') ?></th>
                    <th scope="col" class="px-4 py-2.5 text-right font-normal"><?= e('usr.actions') ?></th>
                </tr>
            </thead>
            <tbody class="divide-y divide-edge">
                <?php foreach ($access_list as $row):
                    $ids  = json_decode($row['channel_ids_json'] ?? '[]', true) ?: [];
                    $perm = json_decode($row['permissions_json'] ?? '[]', true) ?: [];
                    $permMap = [];
                    foreach ($ids as $i => $cid) { $permMap[(string) $cid] = $perm[$i] ?? 'FULL DUPLEX'; }
                    $uid = (string) $row['id'];
                ?>
                    <tr class="access-row transition-colors hover:bg-card-muted">
                        <td data-label="<?= e('usr.unit') ?>" class="px-4 py-2.5 align-top lg:px-5">
                            <span class="block font-medium"><?= htmlspecialchars($row['name']) ?></span>
                            <span class="block font-mono text-[10px] text-ink-subtle"><?= htmlspecialchars($uid) ?></span>
                        </td>
                        <td data-label="<?= e('acc.channels') ?>" class="px-4 py-2.5 align-top">
                            <?php if (empty($ids)): ?>
                                <!-- Without a default channel server.js refuses app_login outright. -->
                                <span class="rounded-control bg-warn/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-warn">
                                    <?= e('acc.none') ?>
                                </span>
                            <?php else: ?>
                                <div class="flex flex-wrap gap-1.5">
                                    <?php foreach ($ids as $cid):
                                        $isDefault = (string) $cid === (string) ($row['default_id'] ?? '');
                                        $isRx      = ($permMap[(string) $cid] ?? '') === 'RX';
                                        $label     = '';
                                        foreach ($all_channels as $c) { if ((string) $c['id'] === (string) $cid) { $label = $c['display_name']; break; } }
                                    ?>
                                        <span class="rounded-control border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]
                                                     <?= $isDefault ? 'border-brand bg-brand/10 text-brand' : 'border-edge text-ink-subtle' ?>">
                                            <?= htmlspecialchars($label ?: $cid) ?><?= $isRx ? ' · RX' : '' ?>
                                        </span>
                                    <?php endforeach; ?>
                                </div>
                            <?php endif; ?>
                        </td>
                        <td data-label="<?= e('usr.actions') ?>" class="px-4 py-2.5 text-right align-top">
                            <div class="inline-flex gap-1.5">
                                <button type="button"
                                        @click="open(<?= htmlspecialchars(json_encode([
                                            'id' => $uid, 'name' => $row['name'],
                                            'ids' => array_map('strval', $ids),
                                            'def' => (string) ($row['default_id'] ?? ''),
                                            'perm' => $permMap,
                                        ]), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted transition-colors hover:border-brand hover:text-brand">
                                    <?= e('acc.edit') ?>
                                </button>
                                <button type="button"
                                        @click="kick(<?= htmlspecialchars(json_encode($uid), ENT_QUOTES, 'UTF-8') ?>, <?= htmlspecialchars(json_encode($row['name']), ENT_QUOTES, 'UTF-8') ?>)"
                                        class="rounded-control border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle transition-colors hover:border-bad hover:text-bad">
                                    <?= e('acc.kick') ?>
                                </button>
                            </div>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
    <?php endif; ?>

    <div id="accessModal" x-cloak x-show="m.open" x-transition:enter="transition-opacity duration-[var(--duration-modal)] ease-enter"
         x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100"
         x-transition:leave="transition-opacity duration-[var(--duration-exit)] ease-exit"
         x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0"
         class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
         @click.self="m.open = false" @keydown.window.escape="m.open = false" role="dialog" aria-modal="true">
        <form x-show="m.open"
              x-transition:enter="transition duration-[var(--duration-modal)] ease-enter"
              x-transition:enter-start="opacity-0 translate-y-2 scale-[0.99]"
              x-transition:enter-end="opacity-100 translate-y-0 scale-100"
              x-transition:leave="transition duration-[var(--duration-exit)] ease-exit"
              x-transition:leave-start="opacity-100 translate-y-0 scale-100"
              x-transition:leave-end="opacity-0 translate-y-2 scale-[0.99]" method="POST" class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-edge bg-card shadow-2xl">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="user_id" id="m_user_id" :value="m.id">
            <input type="hidden" name="default_channel" id="m_default_channel" :value="m.def">

            <div class="border-b border-edge px-5 py-4">
                <h2 class="text-sm font-semibold"><?= e('acc.modal_title') ?></h2>
                <p class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand" id="m_user_name" x-text="m.name"></p>
            </div>

            <p class="border-b border-edge px-5 py-2 text-xs text-ink-muted"><?= e('acc.modal_note') ?></p>

            <div class="flex-1 overflow-y-auto px-5 py-3">
                <?php foreach ($all_channels as $ch): $cid = (string) $ch['id']; ?>
                    <div id="item_<?= $cid ?>"
                         class="channel-item mb-1 flex items-center gap-3 rounded-control px-2 py-2 transition-colors"
                         :class="m.ids.includes('<?= $cid ?>') && 'bg-card-muted'">
                        <input type="checkbox" id="check_<?= $cid ?>" name="channels[]" value="<?= $cid ?>"
                               class="ch-checkbox h-4 w-4 rounded-sm border-edge-strong accent-brand"
                               :checked="m.ids.includes('<?= $cid ?>')"
                               @change="pick('<?= $cid ?>', $event.target.checked)">
                        <label for="check_<?= $cid ?>" class="min-w-0 flex-1 truncate text-sm"><?= htmlspecialchars($ch['display_name']) ?></label>

                        <!-- Receive-only. The relay reads exactly one value here:
                             anything that is not RX means the unit may transmit. -->
                        <label class="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-subtle">
                            <input type="checkbox" id="rx_<?= $cid ?>" name="permissions[<?= $cid ?>]" value="RX"
                                   class="h-3.5 w-3.5 rounded-sm border-edge-strong accent-accent"
                                   :checked="m.perm['<?= $cid ?>'] === 'RX'"
                                   :disabled="!m.ids.includes('<?= $cid ?>')"
                                   @change="m.perm['<?= $cid ?>'] = $event.target.checked ? 'RX' : 'FULL DUPLEX'">
                            RX
                        </label>

                        <button type="button" id="def_label_<?= $cid ?>"
                                @click="m.def = '<?= $cid ?>'"
                                x-show="m.ids.includes('<?= $cid ?>')"
                                :class="m.def === '<?= $cid ?>'
                                    ? 'border-brand bg-brand/10 text-brand'
                                    : 'border-edge text-ink-subtle hover:border-brand'"
                                class="rounded-control border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] transition-colors">
                            <?= e('acc.default') ?>
                        </button>
                    </div>
                <?php endforeach; ?>
            </div>

            <div class="flex items-center justify-between gap-2 border-t border-edge px-5 py-3">
                <p class="font-mono text-[9px] uppercase tracking-[0.15em]"
                   :class="m.ids.length && !m.def ? 'text-warn' : 'text-ink-subtle'"
                   x-text="m.ids.length && !m.def ? <?= js('acc.pick_default') ?> : ''"></p>
                <div class="flex gap-2">
                    <button type="button" @click="m.open = false"
                            class="rounded-control border border-edge px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-muted hover:text-ink"><?= e('ch.cancel') ?></button>
                    <button type="submit" name="update_multi_access" value="1"
                            :disabled="m.ids.length > 0 && !m.def"
                            class="rounded-control border border-brand bg-brand px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-slate-950 hover:bg-brand-hover disabled:opacity-50"><?= e('ch.save') ?></button>
                </div>
            </div>
        </form>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
    const AM2_CSRF = <?= json_encode(am2_csrf_token()) ?>;
    const ACC_MSG = <?= json_encode([
        'kick_confirm' => t('acc.kick_confirm'),
        'kicked'       => t('acc.kicked'),
        'kick_failed'  => t('acc.kick_failed'),
    ]) ?>;

    function accessPage() {
        return {
            m: { open: false, id: null, name: '', ids: [], def: '', perm: {} },

            open(row) {
                this.m = {
                    open: true, id: row.id, name: row.name,
                    ids: [...row.ids], def: row.def, perm: { ...row.perm },
                };
            },

            pick(cid, on) {
                this.m.ids = on
                    ? [...this.m.ids, cid]
                    : this.m.ids.filter((x) => x !== cid);
                // Unticking the default leaves the unit unable to sign in, so
                // clear it rather than submit a default that is not granted.
                if (!on && this.m.def === cid) this.m.def = '';
                if (on && !this.m.def) this.m.def = cid;
            },

            async kick(uid, name) {
                if (!confirm(ACC_MSG.kick_confirm.replace(':name', name))) return;
                const fd = new FormData();
                fd.append('action', 'db_force_logout');
                fd.append('user_id', uid);
                fd.append('_csrf', AM2_CSRF);
                try {
                    // Posts to the current URL on purpose: the page has always
                    // done so, which carries any ?search= along with it.
                    const res = await fetch(window.location.href, { method: 'POST', body: fd });
                    const data = await res.json();
                    if (!data.success) throw new Error(data.message || 'failed');
                    alert(ACC_MSG.kicked);
                    location.reload();
                } catch (err) {
                    alert(ACC_MSG.kick_failed + ' — ' + (err.message || ''));
                }
            },
        };
    }
</script>
</body>
</html>
