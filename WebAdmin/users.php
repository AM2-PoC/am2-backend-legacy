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
    
    try {
        $entity_type = am2_entity_type($_POST['entity_type'] ?? 'user');
        $pdo->beginTransaction();
        
        am2_create_user($pdo, $id, $name, $_POST['password'], $current_admin_id, $entity_type);

        am2_log($pdo, $current_admin_id, 'CREATE_USER', 'user.create',
                ['name' => $name, 'id' => $id, 'entity_type' => $entity_type], 'users', $id);
        
        am2_audit_complete();
        $pdo->commit();
        $success_msg = "User $name (User: $id) berhasil didaftarkan.";
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
        $error_msg = ($e->getCode() == '23505') ? "ID $id sudah terdaftar." : "Database Error: " . am2_safe_error($e, 'users');
    }
}

if (isset($_POST['update_feature'])) {
    header('Content-Type: application/json');
    if (!am2_admin_owns_user($pdo, $current_admin_id, $admin_role, $_POST['u_id'] ?? '')) {
        echo json_encode(['success' => false, 'msg' => 'Akses ditolak']);
        exit;
    }
    $u_id = $_POST['u_id'];
    $feature = $_POST['feature'];

    // Which switches exist, which value each takes and who may move them all
    // live in user_features.php now. Both this page and the endpoint behind
    // the admin app read them from there, so the two cannot drift again.
    try {
        $pdo->beginTransaction();
        $stmtTarget = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
        $stmtTarget->execute([$u_id]);
        $target_name = $stmtTarget->fetchColumn() ?: $u_id;

        $val = am2_feature_value($feature, $_POST['val'] ?? '');
        $row = am2_set_user_feature($pdo, (string) $u_id, $feature, $_POST['val'] ?? '', $auth);

        [$logCode, $logParams] = am2_feature_log($feature, (string) $val, (string) $u_id, (string) $target_name);
        am2_log($pdo, $current_admin_id, 'UPDATE_FEATURE', $logCode, $logParams, 'users', $u_id);

        am2_audit_complete();
        $pdo->commit();
        notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
        echo json_encode(['success' => true]);
    } catch (InvalidArgumentException | RuntimeException $e) {
        if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
        echo json_encode(['success' => false, 'msg' => am2_feature_reason($e)]);
    } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
        echo json_encode(['success' => false, 'msg' => am2_safe_error($e, 'users')]);
    }
    exit;
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
        if (array_key_exists('edit_entity_type', $_POST)) {
            $edit_entity_type = am2_entity_type($_POST['edit_entity_type']);
        } else {
            // Preserve the classification for older callers that do not know
            // about this field yet; omission must never turn a tracker into a user.
            $stmtType = $pdo->prepare('SELECT entity_type FROM public.users WHERE id = ?');
            $stmtType->execute([$edit_id]);
            $edit_entity_type = am2_entity_type($stmtType->fetchColumn() ?: 'user');
        }
        $pdo->beginTransaction();
        $newPassword = (string) ($_POST['edit_password'] ?? '');
        am2_update_user($pdo, (string) $edit_id, $edit_name, $newPassword, $current_admin_id, $edit_entity_type);
        $logCode = $newPassword === '' ? 'user.rename' : 'user.password';

        am2_log($pdo, $current_admin_id, 'UPDATE_USER', $logCode,
                ['id' => $edit_id, 'name' => $edit_name, 'entity_type' => $edit_entity_type], 'users', $edit_id);

        am2_audit_complete();
        $pdo->commit();
        $success_msg = "Data $edit_id diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
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
        $old_name = am2_delete_user($pdo, (string) $del_id, $current_admin_id);

        am2_log($pdo, $current_admin_id, 'DELETE_USER', 'user.delete',
                ['name' => $old_name, 'id' => $del_id], 'users', $del_id);

        am2_audit_complete();
        $pdo->commit();
        // The bulk path asks over fetch and cannot follow a redirect into a
        // page it then throws away. Same guard, same query, different reply.
        if (!empty($_POST['ajax'])) {
            header('Content-Type: application/json');
            echo json_encode(['success' => true]);
            exit;
        }
        header("Location: users.php?success=deleted"); exit;
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
        $error_msg = "Gagal menghapus user.";
    }
}

/*
 * Export exactly the units that were selected, as CSV.
 *
 * Scoped by the same ownership rule the list uses, so a branch admin cannot
 * widen the selection by editing the ids it posts -- the ids narrow the query,
 * they never widen it.
 */
if (isset($_POST['export_selected']) && !empty($_POST['ids']) && is_array($_POST['ids'])) {
    $ids = array_values(array_filter(array_map('strval', $_POST['ids'])));
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $args = $ids;

    $sqlx = "SELECT u.id, u.name, u.status, p.duplex_mode,
                    p.enable_maps, p.enable_p2p, p.enable_ptt_video
             FROM public.users u
             LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
             WHERE u.role = 'user' AND u.id IN ({$marks})";
    if ($admin_role !== 'superadmin') {
        $sqlx .= " AND u.admin_id = ?";
        $args[] = $current_admin_id;
    }
    $stmt_x = $pdo->prepare($sqlx . " ORDER BY u.id");
    $stmt_x->execute($args);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="UNIT_' . date('Ymd_His') . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['id', 'nama', 'status', 'duplex', 'maps', 'p2p', 'video']);
    foreach ($stmt_x as $r) {
        fputcsv($out, [
            $r['id'], $r['name'], $r['status'], $r['duplex_mode'],
            $r['enable_maps'] ? '1' : '0',
            $r['enable_p2p'] ? '1' : '0',
            $r['enable_ptt_video'] ? '1' : '0',
        ]);
    }
    fclose($out);
    exit;
}

/** Page size. Twenty rows fill a screen without needing two scrolls. */
const AM2_USER_PAGE = 20;

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

/*
 * Chips are filters that mean something operationally. "Tanpa channel default"
 * is a unit that cannot talk to anyone, and nothing in this panel said so
 * before. There is deliberately no "memancar" chip: users.is_speaking is false
 * on all 218 rows because nothing maintains it, so the filter would match
 * nothing forever. Transmitting is shown live in the row instead, from the
 * poll that computes it from the logs.
 */
$chip = in_array($_GET['chip'] ?? '', ['online', 'nochannel', 'full'], true)
    ? (string) $_GET['chip'] : '';

// Whitelisted. Neither the column nor the direction is ever interpolated from
// what arrived in the query string.
$sortable = ['id' => 'u.id', 'name' => 'u.name', 'duplex' => 'p.duplex_mode', 'seen' => 'u.updated_at'];
$sortCol  = $sortable[$_GET['sort'] ?? ''] ?? 'u.created_at';
$sortDir  = ($_GET['dir'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';

$where  = ["u.role = 'user'"];
$params = [];

if ($admin_role !== 'superadmin') {
    $where[] = 'u.admin_id = ?';
    $params[] = $current_admin_id;
}
if ($search !== '') {
    $where[] = '(u.name ILIKE ? OR u.id ILIKE ?)';
    $params[] = "%$search%";
    $params[] = "%$search%";
}
if ($chip === 'online') {
    $where[] = "u.status = 'online'";
} elseif ($chip === 'nochannel') {
    $where[] = "NOT EXISTS (SELECT 1 FROM public.user_channels uc
                            WHERE uc.user_id = u.id AND uc.is_default)";
} elseif ($chip === 'full') {
    $where[] = "p.duplex_mode = 'FULL DUPLEX'";
}

$fromWhere = "FROM public.users u
              LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
              WHERE " . implode(' AND ', $where);

$stmt_count = $pdo->prepare("SELECT COUNT(*) {$fromWhere}");
$stmt_count->execute($params);
$total = (int) $stmt_count->fetchColumn();

$pages  = max(1, (int) ceil($total / AM2_USER_PAGE));
$page   = min(max(1, (int) ($_GET['p'] ?? 1)), $pages);
$offset = ($page - 1) * AM2_USER_PAGE;

$stmt_users = $pdo->prepare(
    "SELECT u.*, p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode
     {$fromWhere} ORDER BY {$sortCol} {$sortDir}, u.id ASC
     LIMIT " . AM2_USER_PAGE . " OFFSET {$offset}");
$stmt_users->execute($params);
$users = $stmt_users->fetchAll();

// Every id the filter matches, so "pilih semua yang cocok" can mean it rather
// than quietly meaning the twenty on screen. Two hundred call signs is under
// two kilobytes; the alternative is an endpoint that exists to answer a
// question this request already knows.
$stmt_all = $pdo->prepare("SELECT u.id {$fromWhere} ORDER BY u.id");
$stmt_all->execute($params);
$allIds = $stmt_all->fetchAll(PDO::FETCH_COLUMN);

// The channels each visible unit holds, default first. One query for the page,
// not one per row.
$rowChannels = [];
if ($users) {
    $ids = array_column($users, 'id');
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt_rc = $pdo->prepare(
        "SELECT uc.user_id, uc.is_default, c.display_name
         FROM public.user_channels uc
         JOIN public.channels c ON c.id = uc.channel_id
         WHERE uc.user_id IN ({$marks})
         ORDER BY uc.is_default DESC, c.display_name ASC");
    $stmt_rc->execute($ids);
    foreach ($stmt_rc as $r) {
        $rowChannels[$r['user_id']][] = $r;
    }
}

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
$pageLede  = t('usr.lede', ['n' => number_format($total)]);

/** Feature switches, in the order they appear on a row. */
$features = [
    ['enable_maps',      'usr.f_maps',  (bool) ($auth['can_manage_maps'] ?? false)],
    ['enable_p2p',       'usr.f_p2p',   (bool) ($auth['can_manage_p2p'] ?? false)],
    ['enable_ptt_video', 'usr.f_video', (bool) ($auth['can_manage_video'] ?? false)],
];

/** The table frame reads these. See partials/table_open.php. */
$tableId = 'am2-roster';
$searchPlaceholder = 'usr.search';
$countKey = 'usr.count';
$chips = [
    ['value' => '',          'key' => 'usr.chip_all'],
    ['value' => 'online',    'key' => 'usr.chip_online',    'dot' => 'bg-ok'],
    ['value' => 'nochannel', 'key' => 'usr.chip_nochannel', 'dot' => 'bg-warn'],
    ['value' => 'full',      'key' => 'usr.chip_full'],
];
$columns = [
    ['key' => 'usr.unit',     'sort' => 'name'],
    ['key' => 'usr.channel'],
    ['key' => 'usr.features'],
    ['key' => 'usr.duplex',   'sort' => 'duplex'],
    ['key' => 'usr.actions',  'align' => 'right'],
];
$pageSize = AM2_USER_PAGE;

/*
 * The page's own verb, handed to the table's toolbar.
 *
 * It was in the shell's header slot, which is where the application's
 * navigation lives -- theme, language, the account. A button that creates a
 * unit is not navigation, and putting it up there meant it sat beside the
 * search box on every page whether or not the page could create anything.
 */
$tableAction = '<button type="button" data-hs-overlay="#am2-add-unit"'
    . ' class="h-11 shrink-0 rounded-control bg-brand px-4 font-mono text-[11px] font-semibold'
    . ' uppercase tracking-[0.15em] text-slate-950 transition-colors'
    . ' duration-[var(--duration-micro)] hover:bg-brand-hover">'
    . e('usr.add') . '</button>';

// Every verb here is owned by this page: each one needs to ask something
// first -- which channels, which mode, which feature, are you sure -- so none
// of them can be declared as a single fixed request on a button.
$bulkActions = [
    ['verb' => 'duplex',   'key' => 'usr.bulk_duplex',   'toolbar_key' => 'usr.bulk_duplex_label', 'icon' => 'swap',
     'data' => ['hs-overlay' => '#am2-bulk-duplex']],
    ['verb' => 'feature',  'key' => 'usr.bulk_feature',  'toolbar_key' => 'usr.bulk_feature_label', 'icon' => 'sliders',
     'data' => ['hs-overlay' => '#am2-bulk-feature']],
    ['verb' => 'export',   'key' => 'usr.bulk_export',   'icon' => 'download', 'utility' => true],
    ['verb' => 'delete',   'key' => 'usr.bulk_delete',   'icon' => 'trash', 'danger' => true,
     'data' => ['hs-overlay' => '#am2-bulk-delete']],
];
$bulkUnitKey = 'tbl.units_selected';

include 'partials/head.php';
include 'partials/shell.php';
?>

<?php if ($success_msg !== ''): ?>
    <p role="status" class="mb-5 rounded-control border-l-2 border-ok bg-ok/5 py-3 pl-3 pr-3 text-sm"><?= $success_msg ?></p>
<?php endif; ?>
<?php if ($error_msg !== ''): ?>
    <p role="alert" class="mb-5 rounded-control border-l-2 border-bad bg-bad/5 py-3 pl-3 pr-3 text-sm"><?= htmlspecialchars($error_msg) ?></p>
<?php endif; ?>

<?php include 'partials/table_open.php'; ?>

            <tbody class="divide-y divide-edge">
                <?php if (!$users): ?>
                    <!-- Two empty states, not one. "Nothing yet" and "nothing
                         matched" are different problems and want different
                         next steps; the same blank panel for both is a dead
                         end half the time. -->
                    <tr>
                        <td colspan="6" class="px-5 py-16 text-center">
                            <?php $filtered = $search !== '' || $chip !== ''; ?>
                            <p class="text-sm text-ink-muted">
                                <?= $filtered ? e('usr.empty_filtered') : e('usr.empty') ?>
                            </p>
                            <?php if ($filtered): ?>
                                <a href="users.php"
                                   class="mt-3 inline-flex h-10 items-center rounded-control border border-edge
                                          px-4 font-mono text-[11px] uppercase tracking-[0.15em]
                                          text-ink-muted! no-underline! transition-colors
                                          duration-[var(--duration-micro)] hover:border-brand hover:text-brand!">
                                    <?= e('usr.clear_filter') ?>
                                </a>
                            <?php else: ?>
                                <button type="button" data-hs-overlay="#am2-add-unit"
                                        class="mt-3 h-10 rounded-control bg-brand px-4 font-mono text-[11px]
                                               font-semibold uppercase tracking-[0.15em] text-slate-950
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:bg-brand-hover">
                                    <?= e('usr.add') ?>
                                </button>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endif; ?>

                <?php foreach ($users as $u):
                    $uid    = (string) $u['id'];
                    $online = ($u['status'] ?? '') === 'online';
                    $chans  = $rowChannels[$uid] ?? [];
                    $primary = $chans[0] ?? null;
                    $full   = ($u['duplex_mode'] ?? 'HALF DUPLEX') === 'FULL DUPLEX';
                    $seen   = !empty($u['updated_at']) ? strtotime((string) $u['updated_at']) : null;
                ?>
                    <tr data-row-id="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                        class="transition-colors hover:bg-card-muted">

                        <td data-cell="select" data-label="<?= e('tbl.select') ?>" class="w-10 px-4 align-middle lg:ps-5">
                            <input type="checkbox" data-select
                                   aria-label="<?= e('usr.select_unit', ['unit' => $uid]) ?>"
                                   class="h-4 w-4 cursor-pointer rounded border-edge-strong text-brand
                                          focus:ring-brand/40">
                        </td>

                        <td data-cell="unit" data-label="<?= e('usr.unit') ?>" class="px-4 py-2.5 align-middle">
                            <span class="flex items-start gap-2.5 lg:gap-2.5">
                                <span data-presence
                                      class="mt-1.5 h-2 w-2 shrink-0 rounded-full <?= $online ? 'bg-ok' : 'bg-edge-strong' ?>"
                                      aria-hidden="true"></span>
                                <span class="min-w-0">
                                    <span class="flex items-center gap-2">
                                        <span class="truncate font-mono text-sm text-ink"><?= htmlspecialchars($uid) ?></span>
                                        <span data-tx hidden
                                              class="shrink-0 rounded-control bg-bad/10 px-1.5 font-mono
                                                     text-[11px] uppercase tracking-[0.1em] text-bad">TX</span>
                                    </span>
                                    <span class="block truncate text-sm text-ink-muted"><?= htmlspecialchars((string) $u['name']) ?></span>
                                    <!-- Desktop: the freshness, because channel
                                         has a column of its own. -->
                                    <span data-seen class="hidden font-mono text-[11px] text-ink-subtle lg:block">
                                        <?= $online
                                            ? e('usr.online_now')
                                            : ($seen ? e('usr.last_seen', ['when' => date('d M H:i', $seen)]) : '') ?>
                                    </span>

                                    <!--
                                        Narrow: one line, and a fault outranks a
                                        fact on it. A unit with no default
                                        channel cannot talk to anyone, so it says
                                        that rather than saying nothing where the
                                        channel would have been.
                                    -->
                                    <span data-summary class="block text-xs lg:hidden">
                                        <?php if (!$primary): ?>
                                            <span class="text-warn"><?= e('usr.no_channel_short') ?></span>
                                        <?php else: ?>
                                            <span class="text-ink-muted"><?= htmlspecialchars((string) $primary['display_name']) ?></span>
                                        <?php endif; ?>
                                        <span class="text-ink-subtle"> ·
                                            <?= $online
                                                ? e('usr.online_now')
                                                : ($seen ? htmlspecialchars(date('d M H:i', $seen)) : '—') ?>
                                        </span>
                                    </span>
                                </span>

                                <!--
                                    Everything else about this unit is one tap
                                    away, and the chevron is what says so.

                                    The button is 28px wide inside a row of
                                    around 356, and it used to be the only way
                                    in: a thumb had to find the chevron exactly.
                                    It stretches across the whole cell now
                                    (data-sheet-row), so anywhere on the row
                                    opens the sheet -- the chevron stays as the
                                    thing that says the row is tappable, and the
                                    text above it keeps its own selection
                                    because the stretched layer sits behind it.
                                -->
                                <button type="button" data-open-sheet data-sheet-row
                                        data-hs-overlay="#am2-unit-sheet"
                                        data-unit="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $u['name'], ENT_QUOTES, 'UTF-8') ?>"
                                        aria-haspopup="dialog"
                                        aria-label="<?= e('usr.open_detail', ['unit' => $uid]) ?>"
                                        class="ms-auto grid h-9 w-7 shrink-0 place-items-center rounded-control
                                               text-ink-subtle transition-colors
                                               duration-[var(--duration-micro)] hover:text-brand
                                               focus:outline-none focus-visible:ring-2
                                               focus-visible:ring-brand/60 lg:hidden">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
                                         class="h-4 w-4" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                                </button>
                            </span>
                        </td>

                        <td data-cell="channel" data-label="<?= e('usr.channel') ?>" class="px-4 py-2.5 align-middle">
                            <?php if ($primary): ?>
                                <!--
                                    The same chip as FITUR and DUPLEX, in brand:
                                    a default channel is a live setting, and the
                                    row now reads as one family of controls
                                    rather than one column of prose beside three
                                    of chips. max-w keeps a long channel name
                                    from widening the column past its share.
                                -->
                                <span class="am2-chip inline-flex max-w-full items-center border-brand
                                             bg-brand/10 text-brand">
                                    <span class="truncate"><?= htmlspecialchars((string) $primary['display_name']) ?></span>
                                </span>
                                <?php if (count($chans) > 1): ?>
                                    <span class="mt-1 block font-mono text-[11px] text-ink-subtle">
                                        <?= e('usr.more_channels', ['n' => count($chans) - 1]) ?>
                                    </span>
                                <?php endif; ?>
                            <?php else: ?>
                                <!--
                                    The shared chip, not a copy of it. This
                                    column reproduced the chip's padding and
                                    type scale by hand and had already drifted
                                    from the other three. Warning rather than
                                    brand: a unit with no default channel cannot
                                    talk to anyone, which is a fault, not a
                                    setting that happens to be off.
                                -->
                                <span class="am2-chip inline-flex items-center gap-1.5 border-warn/40
                                             bg-warn/5 text-warn">
                                    <?= am2_icon('alert', 'h-3 w-3') ?><?= e('usr.no_channel') ?>
                                </span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="features" data-label="<?= e('usr.features') ?>" class="px-4 py-2.5 align-middle">
                            <div class="flex flex-wrap gap-1.5">
                                <?php
                                $base = 'am2-chip';
                                $onCls  = 'border-brand bg-brand/10 text-brand';
                                $offCls = 'border-edge text-ink-subtle';
                                foreach ($features as [$key, $labelKey, $allowed]):
                                    $on = (bool) ($u[$key] ?? false); ?>
                                    <button type="button" data-toggle
                                            data-row-id="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                            data-endpoint="update_feature"
                                            data-field="<?= $key ?>"
                                            data-on="<?= $on ? '1' : '0' ?>"
                                            data-base-class="<?= htmlspecialchars($base, ENT_QUOTES) ?>"
                                            data-on-class="<?= $onCls ?>"
                                            data-off-class="<?= $offCls ?>"
                                            data-ok-message="<?= e('usr.saved') ?>"
                                            data-fail-message="<?= e('usr.failed') ?>"
                                            aria-pressed="<?= $on ? 'true' : 'false' ?>"
                                            <?= $allowed ? '' : 'disabled title="' . e('usr.not_permitted') . '"' ?>
                                            class="<?= $base . ' ' . ($on ? $onCls : $offCls) ?>">
                                        <?= e($labelKey) ?>
                                    </button>
                                <?php endforeach; ?>
                            </div>
                        </td>

                        <td data-cell="duplex" data-label="<?= e('usr.duplex') ?>" class="px-4 py-2.5 align-middle">
                            <?php
                            $dBase = 'am2-chip';
                            $dOn  = 'border-accent bg-accent/10 text-accent';
                            $dOff = 'border-edge text-ink-subtle';
                            ?>
                            <button type="button" data-toggle
                                    data-row-id="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                    data-endpoint="update_feature"
                                    data-field="duplex_mode"
                                    data-on="<?= $full ? '1' : '0' ?>"
                                    data-on-value="FULL DUPLEX"
                                    data-off-value="HALF DUPLEX"
                                    data-on-label="<?= e('usr.full') ?>"
                                    data-off-label="<?= e('usr.half') ?>"
                                    data-base-class="<?= htmlspecialchars($dBase, ENT_QUOTES) ?>"
                                    data-on-class="<?= $dOn ?>"
                                    data-off-class="<?= $dOff ?>"
                                    data-ok-message="<?= e('usr.saved') ?>"
                                    data-fail-message="<?= e('usr.failed') ?>"
                                    aria-pressed="<?= $full ? 'true' : 'false' ?>"
                                    class="<?= $dBase . ' ' . ($full ? $dOn : $dOff) ?>">
                                <?= $full ? e('usr.full') : e('usr.half') ?>
                            </button>
                        </td>

                        <!--
                            Same chip as the three status columns, so the row
                            reads as one family of controls rather than four
                            inventions. The colours stay different on purpose:
                            these are verbs, not states, so they are neutral
                            until hovered, and delete is the one thing here that
                            must never be mistaken for a status that happens to
                            be on.
                        -->
                        <td data-cell="actions" data-label="<?= e('usr.actions') ?>" class="px-4 py-2.5 text-right align-middle">
                            <span class="inline-flex flex-wrap items-center justify-end gap-2">
                                <span data-row-result class="w-3 font-mono text-xs"></span>

                                <?php $actCls = 'am2-chip inline-flex items-center border-edge text-ink-muted'; ?>
                                <?php
                                /*
                                 * A link, not a dialogue. The dialogue that
                                 * used to open here sent the ticked boxes as
                                 * the unit's complete channel set, and it
                                 * opened with every box cleared -- so granting
                                 * one channel revoked the others. Channel
                                 * access is decided on one screen, which paints
                                 * what the unit already holds before anyone
                                 * changes it.
                                 *
                                 * `search` rather than a new parameter: that
                                 * page already filters on it, and an id matches
                                 * exactly one unit.
                                 */
                                ?>
                                <a href="user_access.php?search=<?= urlencode($uid) ?>"
                                   class="<?= $actCls ?> hover:text-brand">
                                    <?= e('usr.channels') ?>
                                </a>

                                <button type="button" data-row-edit
                                        data-unit="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $u['name'], ENT_QUOTES, 'UTF-8') ?>"
                                        data-entity-type="<?= htmlspecialchars((string) $u['entity_type'], ENT_QUOTES, 'UTF-8') ?>"
                                        class="<?= $actCls ?> hover:text-brand">
                                    <?= e('usr.edit') ?>
                                </button>

                                <form method="POST" class="inline"
                                      onsubmit="return confirm(<?= htmlspecialchars(json_encode(t('usr.delete_confirm')), ENT_QUOTES) ?>)">
                                    <?= am2_csrf_field() ?>
                                    <input type="hidden" name="delete_user" value="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>">
                                    <button type="submit"
                                            class="am2-chip inline-flex items-center border-edge text-bad
                                                   hover:border-bad/50! hover:bg-bad/10">
                                        <?= e('usr.delete') ?>
                                    </button>
                                </form>
                            </span>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>

<?php include 'partials/table_close.php'; ?>

<?php
/*
 * The dialogues. Preline owns open, close, Escape and the focus trap; this
 * page only decides what a dialogue is about before Preline shows it. Nothing
 * here opens an overlay from script -- opening one that way is what left the
 * command palette unclosable once.
 */
$ovl = 'hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto bg-slate-950/50 backdrop-blur-sm';
$card = 'am2-surface mx-auto my-[8vh] w-[92%] max-w-md overflow-hidden rounded-card';
$fieldCls = 'mt-2 h-11 w-full rounded-control border border-edge bg-card px-3 text-sm text-ink'
          . ' transition-colors duration-[var(--duration-micro)] hover:border-edge-strong'
          . ' focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';
$labelCls = 'font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle';
$btnGhost = 'h-11 rounded-control border border-edge px-4 font-mono text-[11px] font-semibold'
          . ' uppercase tracking-[0.15em] text-ink-muted transition-colors'
          . ' duration-[var(--duration-micro)] hover:text-ink';
$btnBrand = 'h-11 rounded-control bg-brand px-4 font-mono text-[11px] font-semibold uppercase'
          . ' tracking-[0.15em] text-slate-950 transition-colors duration-[var(--duration-micro)]'
          . ' hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40';
?>

<!-- Add a unit. Field names are the contract: the handler reads id, name, password. -->
<div id="am2-add-unit" role="dialog" tabindex="-1" aria-labelledby="am2-add-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <form method="POST">
            <?= am2_csrf_field() ?>
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-add-label" class="text-base font-semibold text-ink"><?= e('usr.add_title') ?></h2>
            </header>
            <div class="space-y-4 p-5">
                <div>
                    <label for="id" class="<?= $labelCls ?>"><?= e('usr.id') ?></label>
                    <input id="id" name="id" type="text" required class="<?= $fieldCls ?> font-mono">
                </div>
                <div>
                    <label for="name" class="<?= $labelCls ?>"><?= e('usr.name') ?></label>
                    <input id="name" name="name" type="text" required class="<?= $fieldCls ?>">
                </div>
                <div>
                    <label for="entity_type" class="<?= $labelCls ?>"><?= e('usr.entity_type') ?></label>
                    <select id="entity_type" name="entity_type" required class="<?= $fieldCls ?>">
                        <option value="user"><?= e('usr.entity_user') ?></option>
                        <option value="tracker"><?= e('usr.entity_tracker') ?></option>
                    </select>
                </div>
                <div>
                    <label for="pass_add" class="<?= $labelCls ?>"><?= e('usr.password') ?></label>
                    <div class="relative">
                        <input id="pass_add" name="password" type="password" required
                               class="<?= $fieldCls ?> pe-12 font-mono">
                        <button type="button" data-hs-toggle-password='{"target": "#pass_add"}'
                                aria-label="<?= e('login.show_password') ?>"
                                class="absolute inset-y-0 end-0 top-2 grid w-12 place-items-center
                                       rounded-e-control text-ink-subtle transition-colors
                                       duration-[var(--duration-micro)] hover:text-brand">
                            <svg class="hs-password-active:hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                 stroke-linejoin="round" aria-hidden="true">
                                <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
                            </svg>
                            <svg class="hs-password-active:block hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                 stroke-linejoin="round" aria-hidden="true">
                                <path d="m2 2 20 20"/><path d="M10.7 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.2"/>
                                <path d="M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>
                                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-add-unit" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="add_user" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!--
    Edit, as a side panel rather than a modal, so the table stays visible and
    the row being changed is still in view. Below lg it becomes a sheet.
-->
<div id="am2-edit-unit" role="dialog" tabindex="-1" aria-labelledby="am2-edit-label" class="<?= $ovl ?>">
    <!-- A card in the middle, like the channel dialogue. A drawer for a
         two-field form put the controls where nothing else on this page puts
         them. -->
    <div data-am2-panel class="<?= $card ?>">
        <form method="POST">
            <?= am2_csrf_field() ?>
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-edit-label" class="text-base font-semibold text-ink"><?= e('usr.edit_title') ?></h2>
                <p data-edit-unit class="mt-0.5 font-mono text-[11px] uppercase tracking-[0.15em] text-brand"></p>
            </header>
            <div class="space-y-4 p-5">
                <input type="hidden" name="edit_id" id="edit_id" value="">
                <div>
                    <label for="edit_name" class="<?= $labelCls ?>"><?= e('usr.name') ?></label>
                    <input id="edit_name" name="edit_name" type="text" required class="<?= $fieldCls ?>">
                </div>
                <div>
                    <label for="edit_entity_type" class="<?= $labelCls ?>"><?= e('usr.entity_type') ?></label>
                    <select id="edit_entity_type" name="edit_entity_type" required class="<?= $fieldCls ?>">
                        <option value="user"><?= e('usr.entity_user') ?></option>
                        <option value="tracker"><?= e('usr.entity_tracker') ?></option>
                    </select>
                </div>
                <div>
                    <label for="pass_edit" class="<?= $labelCls ?>"><?= e('usr.password_optional') ?></label>
                    <input id="pass_edit" name="edit_password" type="password" class="<?= $fieldCls ?> font-mono"
                           placeholder="<?= e('usr.password_keep') ?>">
                </div>
            </div>
            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-edit-unit" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="edit_user" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!-- Channels. One dialogue for a single row and for a selection; the heading
     says which, so the two can never be confused. -->
<div id="am2-bulk-duplex" role="dialog" tabindex="-1" aria-labelledby="am2-duplex-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <header class="border-b border-edge px-5 py-4">
            <h2 id="am2-duplex-label" class="text-base font-semibold text-ink"><?= e('usr.bulk_duplex_title') ?></h2>
            <p data-duplex-scope class="mt-0.5 font-mono text-[11px] uppercase tracking-[0.15em] text-brand"></p>
        </header>
        <div class="flex gap-2 p-5">
            <button type="button" data-apply-duplex="HALF DUPLEX"
                    class="h-12 flex-1 rounded-control border border-edge font-mono text-[11px] uppercase
                           tracking-[0.15em] text-ink transition-colors duration-[var(--duration-micro)]
                           hover:border-accent hover:text-accent"><?= e('usr.half') ?></button>
            <button type="button" data-apply-duplex="FULL DUPLEX"
                    class="h-12 flex-1 rounded-control border border-edge font-mono text-[11px] uppercase
                           tracking-[0.15em] text-ink transition-colors duration-[var(--duration-micro)]
                           hover:border-accent hover:text-accent"><?= e('usr.full') ?></button>
        </div>
    </div>
</div>

<!-- Features, for a selection. -->
<div id="am2-bulk-feature" role="dialog" tabindex="-1" aria-labelledby="am2-feature-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <header class="border-b border-edge px-5 py-4">
            <h2 id="am2-feature-label" class="text-base font-semibold text-ink"><?= e('usr.bulk_feature_title') ?></h2>
            <p data-feature-scope class="mt-0.5 font-mono text-[11px] uppercase tracking-[0.15em] text-brand"></p>
        </header>
        <div class="divide-y divide-edge">
            <?php foreach ($features as [$key, $labelKey, $allowed]): ?>
                <div class="flex items-center justify-between gap-3 px-5 py-3">
                    <span class="text-sm <?= $allowed ? 'text-ink' : 'text-ink-subtle' ?>"><?= e($labelKey) ?></span>
                    <span class="flex gap-1.5">
                        <button type="button" data-apply-feature="<?= $key ?>" data-apply-value="false"
                                <?= $allowed ? '' : 'disabled' ?>
                                class="h-9 rounded-control border border-edge px-3 font-mono text-[11px]
                                       uppercase tracking-[0.15em] text-ink-muted transition-colors
                                       duration-[var(--duration-micro)] hover:border-bad hover:text-bad
                                       disabled:cursor-not-allowed disabled:opacity-40"><?= e('usr.off') ?></button>
                        <button type="button" data-apply-feature="<?= $key ?>" data-apply-value="true"
                                <?= $allowed ? '' : 'disabled' ?>
                                class="h-9 rounded-control border border-edge px-3 font-mono text-[11px]
                                       uppercase tracking-[0.15em] text-ink-muted transition-colors
                                       duration-[var(--duration-micro)] hover:border-brand hover:text-brand
                                       disabled:cursor-not-allowed disabled:opacity-40"><?= e('usr.on') ?></button>
                    </span>
                </div>
            <?php endforeach; ?>
        </div>
    </div>
</div>

<!-- Deleting a selection. The count is the sentence, and it has to be typed:
     fifty deletions is fifty times the damage of one. -->
<div id="am2-bulk-delete" role="dialog" tabindex="-1" aria-labelledby="am2-del-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <header class="flex items-start gap-3 border-b border-edge px-5 py-4">
            <span class="mt-0.5 text-bad"><?= am2_icon('alert', 'h-5 w-5') ?></span>
            <div>
                <h2 id="am2-del-label" data-delete-title class="text-base font-semibold text-ink"></h2>
                <p class="mt-1 text-sm text-ink-muted"><?= e('usr.bulk_delete_body') ?></p>
            </div>
        </header>
        <div class="p-5">
            <label for="am2-delete-count" class="<?= $labelCls ?>" data-delete-prompt></label>
            <input id="am2-delete-count" type="text" inputmode="numeric" autocomplete="off"
                   class="<?= $fieldCls ?> font-mono text-base">
        </div>
        <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" data-hs-overlay="#am2-bulk-delete" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
            <button type="button" data-delete-apply disabled
                    class="h-11 rounded-control bg-bad px-4 font-mono text-[11px] font-semibold uppercase
                           tracking-[0.15em] text-white transition-colors duration-[var(--duration-micro)]
                           hover:bg-bad/90 disabled:cursor-not-allowed disabled:opacity-40">
                <?= e('usr.bulk_delete') ?>
            </button>
        </footer>
    </div>
</div>

<!--
    The unit sheet.

    It holds no copy of anything: on open, the row's own cells are moved into
    it and moved back when it closes. One set of toggles, one set of handlers,
    and a control that works in the sheet is the control that works in the
    table -- the alternative was rendering every attribute twice for twenty
    rows and hoping the two stayed in step.
-->
<div id="am2-unit-sheet" role="dialog" tabindex="-1" aria-labelledby="am2-sheet-label"
     class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
            bg-slate-950/50 backdrop-blur-sm lg:hidden">
    <div data-am2-panel
         class="am2-surface fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto
                rounded-t-card border-b-0">
        <header class="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
            <span class="min-w-0">
                <span id="am2-sheet-label" data-sheet-unit
                      class="block truncate font-mono text-base font-semibold text-ink"></span>
                <span data-sheet-name class="block truncate text-sm text-ink-muted"></span>
            </span>
            <button type="button" data-hs-overlay="#am2-unit-sheet"
                    aria-label="<?= e('ch.cancel') ?>"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-control text-ink-subtle
                           transition-colors duration-[var(--duration-micro)] hover:text-ink">
                <?= am2_icon('close', 'h-4 w-4') ?>
            </button>
        </header>

        <!--
            Label beside the value, on a narrower gutter.

            Stacking the label above cost a whole line per row for four
            characters of text, and with 44px chips that made the sheet 61% of a
            390px screen. The label sits back alongside instead, on 4rem rather
            than 5, and the row is only as tall as the chips it holds.
        -->
        <div class="divide-y divide-edge">
            <?php foreach ([['channel', 'usr.channel'], ['duplex', 'usr.duplex'],
                            ['features', 'usr.features']] as [$slot, $label]): ?>
                <div class="flex items-center gap-3 px-5 py-2">
                    <span class="w-16 shrink-0 font-mono text-[11px] uppercase tracking-[0.15em]
                                 text-ink-subtle"><?= e($label) ?></span>
                    <span data-slot="<?= $slot ?>"
                          class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"></span>
                </div>
            <?php endforeach; ?>
        </div>

        <!--
            The verbs on one row. Three of them wrapped to two lines in a
            two-column grid, which added ninety pixels to a sheet reached with
            one thumb; sharing a single row keeps them all within reach of it.
        -->
        <footer data-slot="actions"
                class="flex items-stretch gap-2 border-t border-edge bg-card-muted px-5 py-3
                       pb-[max(0.75rem,env(safe-area-inset-bottom))]
                       [&>span]:flex [&>span]:w-full [&>span]:gap-2
                       [&_form]:contents [&_button]:min-h-11 [&_button]:flex-1
                       [&_button]:basis-0 [&_button]:justify-center [&_button]:px-1
                       [&_[data-row-result]]:hidden"></footer>
    </div>
</div>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const table = $('am2-roster');
    const T = <?= json_encode([
        'one'    => t('usr.scope_one'),
        'many'   => t('usr.scope_many'),
        'done'   => t('usr.bulk_done'),
        'del'    => t('usr.bulk_delete_title'),
        'prompt' => t('usr.bulk_delete_prompt'),
        'saved'  => t('usr.saved'),
        'failed' => t('usr.failed'),
    ], JSON_UNESCAPED_UNICODE) ?>;

    /** What the next dialogue is about: a row, or the selection. */
    let scope = { ids: [], label: '' };

    const setScope = (ids, label) => {
        scope = { ids, label };
        document.querySelectorAll('[data-duplex-scope], [data-feature-scope]')
            .forEach((el) => { el.textContent = label; });
    };

    const scopeLabel = (n) => (n === 1 ? T.one : T.many.replace(':n', String(n)));

    // A bulk verb the table runtime handed back because it needs to ask
    // something first. Preline opens the dialogue; this only says what it is
    // about, and must run before the operator can answer.
    table?.addEventListener('am2:bulk', (e) => {
        const { verb, ids } = e.detail;
        setScope(ids, scopeLabel(ids.length));
        if (verb === 'delete') {
            document.querySelector('[data-delete-title]').textContent = T.del.replace(':n', String(ids.length));
            document.querySelector('[data-delete-prompt]').textContent =
                T.prompt.replace(':n', String(ids.length));
            const input = $('am2-delete-count');
            input.value = '';
            document.querySelector('[data-delete-apply]').disabled = true;
        }
        if (verb === 'export') exportSelection(ids);
    });

    // A single row. The button carries data-hs-overlay as well, so Preline
    // opens the dialogue through its own trigger.
    document.querySelectorAll('[data-row-edit]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-edit-unit');
        btn.addEventListener('click', () => {
            $('edit_id').value = btn.dataset.unit;
            $('edit_name').value = btn.dataset.name;
            $('edit_entity_type').value = btn.dataset.entityType === 'tracker' ? 'tracker' : 'user';
            $('pass_edit').value = '';
            document.querySelector('[data-edit-unit]').textContent = btn.dataset.unit;
        });
    });

    /**
     * One request per unit, against the endpoints this page already has, so
     * the tenant checks come along for free. Every row is given its own
     * outcome: one spinner turning into a tick says nothing about the three
     * that failed.
     */
    async function applyToScope(fieldsFor, closeSelector) {
        const csrf = document.querySelector('input[name="_csrf"]').value;
        let ok = 0;
        const failed = [];
        for (const id of scope.ids) {
            const cell = table?.querySelector(`tr[data-row-id="${CSS.escape(id)}"] [data-row-result]`);
            if (cell) { cell.textContent = '·'; cell.className = 'w-3 font-mono text-xs text-ink-subtle'; }
            try {
                const body = new FormData();
                body.append('_csrf', csrf);
                for (const [k, v] of Object.entries(fieldsFor(id))) {
                    if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
                    else body.append(k, v);
                }
                const r = await (await fetch(location.pathname, { method: 'POST', body })).json();
                if (!r || r.success === false) throw new Error(r?.msg || '');
                ok += 1;
                if (cell) { cell.textContent = '✓'; cell.className = 'w-3 font-mono text-xs text-ok'; }
            } catch {
                failed.push(id);
                if (cell) { cell.textContent = '✕'; cell.className = 'w-3 font-mono text-xs text-bad'; }
            }
        }
        if (closeSelector) {
            window.HSOverlay?.close(document.querySelector(closeSelector));
        }
        window.AM2?.toast(
            T.done.replace(':ok', String(ok)).replace(':failed', String(failed.length)),
            failed.length === 0);
        setTimeout(() => window.location.reload(), failed.length ? 2600 : 900);
    }

    document.querySelectorAll('[data-apply-duplex]').forEach((btn) => {
        btn.addEventListener('click', () => applyToScope(
            (id) => ({ update_feature: '1', u_id: id, feature: 'duplex_mode', val: btn.dataset.applyDuplex }),
            '#am2-bulk-duplex'));
    });

    document.querySelectorAll('[data-apply-feature]').forEach((btn) => {
        btn.addEventListener('click', () => applyToScope(
            (id) => ({ update_feature: '1', u_id: id, feature: btn.dataset.applyFeature, val: btn.dataset.applyValue }),
            '#am2-bulk-feature'));
    });

    // The count has to be typed. The number is the whole sentence.
    const delInput = $('am2-delete-count');
    delInput?.addEventListener('input', () => {
        document.querySelector('[data-delete-apply]').disabled =
            delInput.value.trim() !== String(scope.ids.length);
    });
    document.querySelector('[data-delete-apply]')?.addEventListener('click', () => {
        applyToScope((id) => ({ delete_user: id, ajax: '1' }), '#am2-bulk-delete');
    });

    /** A native POST, because the answer to it is a file. */
    function exportSelection(ids) {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = location.pathname;
        form.innerHTML = '';
        const add = (n, v) => {
            const el = document.createElement('input');
            el.type = 'hidden';
            el.name = n;
            el.value = v;
            form.appendChild(el);
        };
        add('_csrf', document.querySelector('input[name="_csrf"]').value);
        add('export_selected', '1');
        ids.forEach((id) => add('ids[]', id));
        document.body.appendChild(form);
        form.submit();
        form.remove();
    }

    /*
     * The unit sheet borrows the row's own cells rather than copying them.
     *
     * A copy would mean twenty rows rendering every toggle twice and two sets
     * of handlers that have to agree forever. Moving the nodes means the
     * control in the sheet is the control in the table: the same element, the
     * same state, the same listener. They go home when the sheet closes.
     */
    const sheet = $('am2-unit-sheet');
    const SLOTS = ['channel', 'duplex', 'features', 'actions'];
    let borrowed = [];

    function returnBorrowed() {
        for (const { node, home } of borrowed) home.appendChild(node);
        borrowed = [];
    }

    document.querySelectorAll('[data-open-sheet]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!sheet) return;
            returnBorrowed();

            const tr = btn.closest('tr[data-row-id]');
            sheet.querySelector('[data-sheet-unit]').textContent = btn.dataset.unit;
            sheet.querySelector('[data-sheet-name]').textContent = btn.dataset.name;

            for (const name of SLOTS) {
                const td = tr.querySelector(`[data-cell="${name}"]`);
                const slot = sheet.querySelector(`[data-slot="${name}"]`);
                if (!td || !slot) continue;
                while (td.firstChild) {
                    borrowed.push({ node: td.firstChild, home: td });
                    slot.appendChild(td.firstChild);
                }
            }
        });
    });

    // Preline owns the closing; this only puts the furniture back.
    sheet?.addEventListener('close.hs.overlay', returnBorrowed);

    /*
     * The sheet only exists below lg, and a window can cross that line while it
     * is open.
     *
     * `lg:hidden` takes the panel away, but Preline's backdrop is a child of
     * body and knows nothing about the breakpoint: it stayed at full opacity
     * with the body still scroll-locked, so the page was covered by a grey
     * sheet belonging to nothing visible. Closing through Preline is what
     * removes the backdrop, restores the scroll and returns the borrowed cells
     * to their row -- doing any of that by hand would leave the other two.
     */
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeSheetAboveLg = () => {
        if (!desktop.matches || !sheet?.classList.contains('opened')) return;
        window.HSOverlay?.close(sheet);
    };
    desktop.addEventListener('change', closeSheetAboveLg);

    /**
     * The roster is live. The same endpoint the shell polls and the map reads,
     * so the three cannot disagree; paused while the tab is hidden.
     */
    async function syncPresence() {
        try {
            const res = await fetch('get-users-ajax.php', { headers: { Accept: 'application/json' } });
            if (!res.ok) return;
            const online = new Map((await res.json()).map((u) => [String(u.id), u]));
            table?.querySelectorAll('tr[data-row-id]').forEach((tr) => {
                const live = online.get(tr.dataset.rowId);
                const dot = tr.querySelector('[data-presence]');
                const tx = tr.querySelector('[data-tx]');
                if (dot) dot.className = 'mt-1.5 h-2 w-2 shrink-0 rounded-full '
                    + (live ? 'bg-ok' : 'bg-edge-strong');
                if (tx) tx.hidden = !(live && Number(live.is_speaking) === 1);
                if (tx && !tx.hidden) tx.classList.add('am2-live');
            });
        } catch {
            // Leave the server-rendered state alone rather than claim everyone
            // dropped off because one request failed.
        }
    }

    let presenceTimer = null;
    const startPresence = () => {
        if (presenceTimer) return;
        syncPresence();
        presenceTimer = setInterval(syncPresence, 30000);
    };
    const stopPresence = () => { clearInterval(presenceTimer); presenceTimer = null; };
    document.addEventListener('visibilitychange',
        () => (document.hidden ? stopPresence() : startPresence()));
    if (!document.hidden) startPresence();
})();
</script>
</body>
</html>
