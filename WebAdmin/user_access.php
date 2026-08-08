<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];
$is_super = $role_user === 'superadmin';



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
        // Written here rather than behind a helper, so the obligation is
        // declared here too: kicking a unit off is a change to that unit, and
        // the log is how anyone later finds out who did it.
        am2_audit_expect('force_logout');
        $stmtKick = $pdo->prepare($sqlKick);
        $stmtKick->execute([$uid_to_kick]);

        am2_log($pdo, $current_admin_id, 'FORCE_LOGOUT', 'user.force_logout',
                ['name' => $target_name], 'users', (string) $uid_to_kick);

        am2_audit_complete();
        $pdo->commit();

        notifyForceLogout($uid_to_kick);

        header('Content-Type: application/json');
        echo json_encode(['success' => true]);
        exit;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
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

            // The channel list travels structured, so "(utama)" can be said
            // in the language of whoever is reading the log rather than the
            // language of whoever granted the access. FULL DUPLEX and RX stay
            // as they are: the relay compares against those exact strings, so
            // they are protocol values, not prose.
            if ($selected_channels) {
                $stmtChName = $pdo->prepare("SELECT display_name FROM public.channels WHERE id = ?");
                $logChannels = [];
                foreach ($selected_channels as $ch_id) {
                    $stmtChName->execute([$ch_id]);
                    $logChannels[] = [
                        'name'    => (string) $stmtChName->fetchColumn(),
                        'default' => ((string) $ch_id === (string) $result['default']),
                        'perm'    => $result['permissions'][(string) $ch_id] ?? 'FULL DUPLEX',
                    ];
                }
                $logCode   = 'access.update';
                $logParams = ['name' => $target_name, 'channels' => $logChannels];
            } else {
                $logCode   = 'access.revoke';
                $logParams = ['name' => $target_name];
            }

            am2_log($pdo, $current_admin_id, 'UPDATE_ACCESS', $logCode, $logParams,
                    'users', (string) $user_id);

            am2_audit_complete();
            $pdo->commit();
            syncUserChannels($user_id);
            $success_msg = "Otoritas akses user berhasil diperbarui.";
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            $error_msg = "Gagal memperbarui database: " . am2_safe_error($e, 'user_access');
        }
    }
}

if (!$is_super) {
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

/** Page size. Twenty rows fill a screen without needing two scrolls. */
const AM2_ACCESS_PAGE = 20;

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

/*
 * Chips are filters that mean something operationally, and on this page both
 * of the first two are the same fault seen from different sides: server.js
 * refuses app_login outright unless the unit has a default channel. A unit
 * with none, or with channels but no default among them, cannot sign in at
 * all -- and the old list said nothing about either.
 */
$chip = in_array($_GET['chip'] ?? '', ['nochannel', 'nodefault', 'rx'], true)
    ? (string) $_GET['chip'] : '';

// Whitelisted. Neither the column nor the direction is ever interpolated from
// what arrived in the query string.
$sortable = ['name' => 'u.name', 'id' => 'u.id', 'channels' => 'ch_count'];
$sortCol  = $sortable[$_GET['sort'] ?? ''] ?? 'u.name';
$sortDir  = ($_GET['dir'] ?? 'asc') === 'desc' ? 'DESC' : 'ASC';

$where  = ["u.role = 'user'"];
$params = [];

if (!$is_super) {
    $where[] = 'u.admin_id = ?';
    $params[] = $current_admin_id;
}
if ($search !== '') {
    $where[] = '(u.name ILIKE ? OR u.id::text ILIKE ?)';
    $params[] = "%$search%";
    $params[] = "%$search%";
}
if ($chip === 'nochannel') {
    $where[] = 'NOT EXISTS (SELECT 1 FROM public.user_channels uc WHERE uc.user_id = u.id)';
} elseif ($chip === 'nodefault') {
    $where[] = 'EXISTS (SELECT 1 FROM public.user_channels uc WHERE uc.user_id = u.id)
                AND NOT EXISTS (SELECT 1 FROM public.user_channels uc
                                WHERE uc.user_id = u.id AND uc.is_default)';
} elseif ($chip === 'rx') {
    $where[] = "EXISTS (SELECT 1 FROM public.user_channels uc
                        WHERE uc.user_id = u.id AND uc.permission = 'RX')";
}

$fromWhere = 'FROM public.users u WHERE ' . implode(' AND ', $where);

$stmt_count = $pdo->prepare("SELECT COUNT(*) {$fromWhere}");
$stmt_count->execute($params);
$total = (int) $stmt_count->fetchColumn();

$pages  = max(1, (int) ceil($total / AM2_ACCESS_PAGE));
$page   = min(max(1, (int) ($_GET['p'] ?? 1)), $pages);
$offset = ($page - 1) * AM2_ACCESS_PAGE;

/*
 * The roster, then its memberships -- two queries rather than one grouped one.
 *
 * The aggregate this replaces could not be paged: LIMIT applies after GROUP BY,
 * so counting the rows meant counting groups in a subquery anyway, and every
 * page still aggregated every membership in the database.
 */
$stmt_acc = $pdo->prepare(
    "SELECT u.id, u.name,
            (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.user_id = u.id) AS ch_count
     {$fromWhere} ORDER BY {$sortCol} {$sortDir}, u.id ASC
     LIMIT " . AM2_ACCESS_PAGE . " OFFSET {$offset}");
$stmt_acc->execute($params);
$access_list = $stmt_acc->fetchAll(PDO::FETCH_ASSOC);

// Every id the filter matches, so "pilih semua yang cocok" can mean it rather
// than quietly meaning the twenty on screen.
$stmt_all = $pdo->prepare("SELECT u.id {$fromWhere} ORDER BY u.id");
$stmt_all->execute($params);
$allIds = $stmt_all->fetchAll(PDO::FETCH_COLUMN);

// The memberships of the units on this page. One query, default first.
$rowAccess = [];
if ($access_list) {
    $ids = array_column($access_list, 'id');
    $marks = implode(',', array_fill(0, count($ids), '?'));
    $stmt_ra = $pdo->prepare(
        "SELECT uc.user_id, uc.channel_id, uc.is_default, uc.permission, c.display_name
         FROM public.user_channels uc
         JOIN public.channels c ON c.id = uc.channel_id
         WHERE uc.user_id IN ({$marks})
         ORDER BY uc.is_default DESC, c.display_name ASC");
    $stmt_ra->execute($ids);
    foreach ($stmt_ra as $r) {
        $rowAccess[(string) $r['user_id']][] = $r;
    }
}

/*
 * Export the access map for exactly the units that were selected, as CSV.
 *
 * One line per membership, because that is what an audit asks about: who may
 * speak where, and where they come up. The ids narrow the query, they never
 * widen it.
 */
if (isset($_POST['export_selected']) && !empty($_POST['ids']) && is_array($_POST['ids'])) {
    $xids = array_values(array_filter(array_map('strval', $_POST['ids'])));
    $xmarks = implode(',', array_fill(0, max(1, count($xids)), '?'));
    $xargs = $xids ?: [''];

    $sqlx = "SELECT u.id, u.name, c.display_name, uc.is_default, uc.permission
             FROM public.users u
             LEFT JOIN public.user_channels uc ON uc.user_id = u.id
             LEFT JOIN public.channels c ON c.id = uc.channel_id
             WHERE u.role = 'user' AND u.id IN ({$xmarks})";
    if (!$is_super) {
        $sqlx .= ' AND u.admin_id = ?';
        $xargs[] = $current_admin_id;
    }
    $stmt_x = $pdo->prepare($sqlx . ' ORDER BY u.name, uc.is_default DESC, c.display_name');
    $stmt_x->execute($xargs);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="AKSES_' . date('Ymd_His') . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['unit', 'nama', 'channel', 'utama', 'izin']);
    foreach ($stmt_x as $r) {
        fputcsv($out, [
            $r['id'], $r['name'],
            $r['display_name'] ?? '',
            $r['is_default'] ? '1' : '0',
            $r['permission'] ?? '',
        ]);
    }
    fclose($out);
    exit;
}
?>
<?php
$pageTitle = t('acc.heading');
$pageLede  = t('acc.lede');

/** The table frame reads these. See partials/table_open.php. */
$tableId = 'am2-access-table';
$searchPlaceholder = 'acc.search';
$countKey = 'acc.count';
$pageSize = AM2_ACCESS_PAGE;

$chips = [
    ['value' => '',          'key' => 'acc.chip_all'],
    ['value' => 'nochannel', 'key' => 'acc.chip_nochannel', 'dot' => 'bg-bad'],
    ['value' => 'nodefault', 'key' => 'acc.chip_nodefault', 'dot' => 'bg-warn'],
    ['value' => 'rx',        'key' => 'acc.chip_rx'],
];

$columns = [
    ['key' => 'usr.unit',     'sort' => 'name'],
    ['key' => 'acc.channels', 'sort' => 'channels'],
    ['key' => 'usr.actions',  'align' => 'right'],
];

// Both verbs are owned by this page: one has to ask whether you meant it, and
// the other answers with a file, which fetch cannot hand to the browser.
$bulkActions = [
    ['verb' => 'export', 'key' => 'acc.bulk_export', 'icon' => 'download'],
    ['verb' => 'kick',   'key' => 'acc.bulk_kick',   'icon' => 'power', 'danger' => true,
     'data' => ['hs-overlay' => '#am2-bulk-kick']],
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

<?php include 'partials/table_open.php'; ?>

            <tbody class="divide-y divide-edge">
                <?php if (!$access_list): ?>
                    <tr>
                        <td colspan="4" class="px-5 py-16 text-center">
                            <?php $filtered = $search !== '' || $chip !== ''; ?>
                            <p class="text-sm text-ink-muted">
                                <?= $filtered ? e('usr.empty_filtered') : e('usr.empty') ?>
                            </p>
                            <?php if ($filtered): ?>
                                <a href="user_access.php"
                                   class="mt-3 inline-flex h-10 items-center rounded-control border border-edge
                                          px-4 font-mono text-[10px] uppercase tracking-[0.15em]
                                          text-ink-muted! no-underline! transition-colors
                                          duration-[var(--duration-micro)] hover:border-brand hover:text-brand!">
                                    <?= e('usr.clear_filter') ?>
                                </a>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endif; ?>

                <?php foreach ($access_list as $row):
                    $uid  = (string) $row['id'];
                    $mine = $rowAccess[$uid] ?? [];
                    $hasDefault = false;
                    foreach ($mine as $m) { if ($m['is_default']) { $hasDefault = true; break; } }
                    // The state the modal opens in, carried on the button rather
                    // than rebuilt from the chips it drew.
                    $state = [
                        'id' => $uid,
                        'name' => (string) $row['name'],
                        'ids' => array_map(static fn ($m) => (string) $m['channel_id'], $mine),
                        'def' => '',
                        'perm' => [],
                    ];
                    foreach ($mine as $m) {
                        $state['perm'][(string) $m['channel_id']] = (string) $m['permission'];
                        if ($m['is_default']) $state['def'] = (string) $m['channel_id'];
                    }
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
                            <span class="flex items-start gap-2.5">
                                <!-- Amber, not decoration: without a default channel
                                     the relay refuses this unit's login outright. -->
                                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full <?= $hasDefault ? 'bg-ok' : 'bg-warn' ?>"
                                      aria-hidden="true"></span>
                                <span class="min-w-0">
                                    <span class="block truncate text-sm text-ink"><?= htmlspecialchars((string) $row['name']) ?></span>
                                    <span class="block truncate font-mono text-[10px] text-ink-subtle"><?= htmlspecialchars($uid) ?></span>

                                    <span data-summary class="block text-xs lg:hidden">
                                        <?php if (!$mine): ?>
                                            <span class="text-bad"><?= e('acc.none') ?></span>
                                        <?php elseif (!$hasDefault): ?>
                                            <span class="text-warn"><?= e('acc.no_default_short') ?></span>
                                        <?php else: ?>
                                            <span class="text-ink-muted"><?= htmlspecialchars((string) $mine[0]['display_name']) ?></span>
                                            <?php if (count($mine) > 1): ?>
                                                <span class="text-ink-subtle"> · <?= e('acc.more', ['n' => count($mine) - 1]) ?></span>
                                            <?php endif; ?>
                                        <?php endif; ?>
                                    </span>
                                </span>

                                <button type="button" data-open-sheet
                                        data-hs-overlay="#am2-access-sheet"
                                        data-unit="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $row['name'], ENT_QUOTES, 'UTF-8') ?>"
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

                        <td data-cell="access" data-label="<?= e('acc.channels') ?>" class="px-4 py-2.5 align-middle">
                            <?php if (!$mine): ?>
                                <!-- Without a default channel server.js refuses app_login outright. -->
                                <span class="inline-flex items-center gap-1.5 rounded-control border border-bad/40
                                             bg-bad/5 px-2 py-1 font-mono text-[9px] uppercase
                                             tracking-[0.1em] text-bad">
                                    <?= am2_icon('alert', 'h-3 w-3') ?><?= e('acc.none') ?>
                                </span>
                            <?php else: ?>
                                <span class="flex flex-wrap gap-1.5">
                                    <?php foreach ($mine as $m):
                                        $isDefault = (bool) $m['is_default'];
                                        $isRx = ((string) $m['permission']) === 'RX'; ?>
                                        <span class="am2-chip <?= $isDefault ? 'border-brand bg-brand/10 text-brand'
                                                                             : 'border-edge text-ink-subtle' ?>">
                                            <?= htmlspecialchars((string) $m['display_name']) ?><?= $isRx ? ' · RX' : '' ?>
                                        </span>
                                    <?php endforeach; ?>
                                    <?php if (!$hasDefault): ?>
                                        <span class="am2-chip border-warn/50 bg-warn/5 text-warn"><?= e('acc.no_default_short') ?></span>
                                    <?php endif; ?>
                                </span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="actions" data-label="<?= e('usr.actions') ?>" class="px-4 py-2.5 text-right align-middle">
                            <span class="inline-flex flex-wrap items-center justify-end gap-2">
                                <span data-row-result class="w-3 font-mono text-xs"></span>

                                <button type="button" data-row-edit
                                        data-state="<?= htmlspecialchars(json_encode($state, JSON_UNESCAPED_UNICODE), ENT_QUOTES, 'UTF-8') ?>"
                                        class="h-8 rounded-control border border-edge px-2.5 font-mono
                                               text-[9px] uppercase tracking-[0.12em] text-ink-muted
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:border-brand hover:text-brand">
                                    <?= e('acc.edit') ?>
                                </button>

                                <button type="button" data-row-kick
                                        data-unit="<?= htmlspecialchars($uid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $row['name'], ENT_QUOTES, 'UTF-8') ?>"
                                        class="h-8 rounded-control border border-edge px-2.5 font-mono
                                               text-[9px] uppercase tracking-[0.12em] text-bad
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:border-bad/50 hover:bg-bad/10">
                                    <?= e('acc.kick') ?>
                                </button>
                            </span>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>

<?php include 'partials/table_close.php'; ?>

<?php
$ovl = 'hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto bg-slate-950/50 backdrop-blur-sm';
$card = 'am2-surface mx-auto my-[8vh] w-[92%] max-w-md overflow-hidden rounded-card';
$labelCls = 'font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle';
$btnGhost = 'h-11 rounded-control border border-edge px-4 font-mono text-[10px] font-semibold'
          . ' uppercase tracking-[0.15em] text-ink-muted transition-colors'
          . ' duration-[var(--duration-micro)] hover:text-ink';
$btnBrand = 'h-11 rounded-control bg-brand px-4 font-mono text-[10px] font-semibold uppercase'
          . ' tracking-[0.15em] text-slate-950 transition-colors duration-[var(--duration-micro)]'
          . ' hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40';
?>

<!--
    Access, for one unit. A form POST rather than fetch: this is the surface
    that decides where a unit comes up and whether it may transmit, and the
    reload that follows is what proves the row now says so.
-->
<div id="am2-access-edit" role="dialog" tabindex="-1" aria-labelledby="am2-access-label" class="<?= $ovl ?>">
    <div data-am2-panel class="am2-surface mx-auto my-[6vh] flex max-h-[88vh] w-[92%] max-w-lg
                                flex-col overflow-hidden rounded-card">
        <form method="POST" class="flex min-h-0 flex-1 flex-col">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="user_id" id="m_user_id" value="">
            <input type="hidden" name="default_channel" id="m_default_channel" value="">

            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-access-label" class="text-base font-semibold text-ink"><?= e('acc.modal_title') ?></h2>
                <p id="m_user_name" class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand"></p>
            </header>

            <p class="border-b border-edge px-5 py-2 text-xs text-ink-muted"><?= e('acc.modal_note') ?></p>

            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                <?php if (!$all_channels): ?>
                    <p class="py-8 text-center text-sm text-ink-muted"><?= e('usr.no_channels_available') ?></p>
                <?php endif; ?>
                <?php foreach ($all_channels as $ch): $cid = (string) $ch['id']; ?>
                    <div id="item_<?= $cid ?>" data-item="<?= $cid ?>"
                         class="channel-item mb-1 flex items-center gap-3 rounded-control px-2 py-2
                                transition-colors duration-[var(--duration-micro)]">
                        <input type="checkbox" id="check_<?= $cid ?>" name="channels[]" value="<?= $cid ?>"
                               data-pick="<?= $cid ?>"
                               class="ch-checkbox h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40">
                        <label for="check_<?= $cid ?>" class="min-w-0 flex-1 truncate text-sm text-ink">
                            <?= htmlspecialchars((string) $ch['display_name']) ?>
                        </label>

                        <!-- Receive-only. The relay reads exactly one value here:
                             anything that is not RX means the unit may transmit. -->
                        <label class="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-subtle">
                            <input type="checkbox" id="rx_<?= $cid ?>" name="permissions[<?= $cid ?>]" value="RX"
                                   data-rx="<?= $cid ?>"
                                   class="h-3.5 w-3.5 rounded border-edge-strong text-accent focus:ring-accent/40">
                            RX
                        </label>

                        <button type="button" id="def_label_<?= $cid ?>" data-def="<?= $cid ?>" hidden
                                class="rounded-control border px-2 py-0.5 font-mono text-[9px] uppercase
                                       tracking-[0.1em] transition-colors duration-[var(--duration-micro)]">
                            <?= e('acc.default') ?>
                        </button>
                    </div>
                <?php endforeach; ?>
            </div>

            <footer class="flex items-center justify-between gap-3 border-t border-edge px-5 py-4">
                <p data-default-warning class="font-mono text-[9px] uppercase tracking-[0.15em] text-warn"></p>
                <div class="flex gap-2">
                    <button type="button" data-hs-overlay="#am2-access-edit" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                    <button type="submit" name="update_multi_access" value="1" data-access-save
                            class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
                </div>
            </footer>
        </form>
    </div>
</div>

<!-- Force logout, for a selection. Reversible -- the unit signs in again -- so
     it asks once rather than asking for the count to be typed. -->
<div id="am2-bulk-kick" role="dialog" tabindex="-1" aria-labelledby="am2-kick-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <header class="border-b border-edge px-5 py-4">
            <h2 id="am2-kick-label" data-kick-title class="text-base font-semibold text-bad"></h2>
        </header>
        <div class="p-5">
            <p data-kick-prompt class="text-sm text-ink-muted"></p>
        </div>
        <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" data-hs-overlay="#am2-bulk-kick" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
            <button type="button" data-kick-apply
                    class="h-11 rounded-control bg-bad px-4 font-mono text-[10px] font-semibold uppercase
                           tracking-[0.15em] text-white transition-colors
                           duration-[var(--duration-micro)] hover:opacity-90">
                <?= e('acc.kick') ?>
            </button>
        </footer>
    </div>
</div>

<!-- The unit sheet: the row's own cells, moved in and moved back. -->
<div id="am2-access-sheet" role="dialog" tabindex="-1" aria-labelledby="am2-sheet-label"
     class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
            bg-slate-950/50 backdrop-blur-sm lg:hidden">
    <div data-am2-panel
         class="am2-surface fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto
                rounded-t-card border-b-0">
        <header class="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
            <span class="min-w-0">
                <span id="am2-sheet-label" data-sheet-name
                      class="block truncate text-base font-semibold text-ink"></span>
                <span data-sheet-unit class="block truncate font-mono text-xs text-ink-muted"></span>
            </span>
            <button type="button" data-hs-overlay="#am2-access-sheet"
                    aria-label="<?= e('ch.cancel') ?>"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-control text-ink-subtle
                           transition-colors duration-[var(--duration-micro)] hover:text-ink">
                <?= am2_icon('close', 'h-4 w-4') ?>
            </button>
        </header>

        <div class="divide-y divide-edge">
            <div class="flex items-baseline gap-4 px-5 py-3.5">
                <span class="w-20 shrink-0 font-mono text-[10px] uppercase tracking-[0.15em]
                             text-ink-subtle"><?= e('acc.channels') ?></span>
                <span data-slot="access" class="flex min-w-0 flex-1 flex-wrap gap-1.5"></span>
            </div>
        </div>

        <footer data-slot="actions"
                class="flex flex-wrap items-center justify-end gap-2 border-t border-edge
                       bg-card-muted px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]"></footer>
    </div>
</div>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const table = $('am2-access-table');
    const T = <?= json_encode([
        'one'          => t('acc.scope_one'),
        'many'         => t('acc.scope_many'),
        'done'         => t('acc.bulk_done'),
        'kick_title'   => t('acc.kick_title'),
        'kick_prompt'  => t('acc.kick_prompt'),
        'pick_default' => t('acc.pick_default'),
    ], JSON_UNESCAPED_UNICODE) ?>;

    /* ── the access dialogue ──────────────────────────────────────────────
     *
     * Its state is held here and painted onto the controls, rather than bound
     * to a dataset an observer never watched. That binding is the bug this
     * rebuild exists to remove: the write reached the database and the screen
     * did not move until a reload.
     */
    const m = { ids: new Set(), def: '', perm: {} };

    const items = [...document.querySelectorAll('[data-item]')];

    function paintAccess() {
        for (const item of items) {
            const cid = item.dataset.item;
            const on = m.ids.has(cid);
            item.classList.toggle('bg-card-muted', on);

            const check = document.querySelector(`[data-pick="${CSS.escape(cid)}"]`);
            if (check) check.checked = on;

            // RX is only meaningful on a channel the unit actually holds, and
            // a disabled input is not submitted -- which is what keeps a stale
            // permission from riding along on a channel just unticked.
            const rx = document.querySelector(`[data-rx="${CSS.escape(cid)}"]`);
            if (rx) {
                rx.checked = m.perm[cid] === 'RX';
                rx.disabled = !on;
            }

            const def = document.querySelector(`[data-def="${CSS.escape(cid)}"]`);
            if (def) {
                def.hidden = !on;
                def.className = 'rounded-control border px-2 py-0.5 font-mono text-[9px] uppercase'
                    + ' tracking-[0.1em] transition-colors duration-[var(--duration-micro)] '
                    + (m.def === cid ? 'border-brand bg-brand/10 text-brand'
                                     : 'border-edge text-ink-subtle hover:border-brand');
            }
        }

        $('m_default_channel').value = m.def;

        // A unit with channels but no default cannot sign in: the relay refuses
        // app_login outright. Saying so is worth more than letting it save.
        const missing = m.ids.size > 0 && !m.def;
        document.querySelector('[data-default-warning]').textContent = missing ? T.pick_default : '';
        document.querySelector('[data-access-save]').disabled = missing;
    }

    document.querySelectorAll('[data-pick]').forEach((box) => {
        box.addEventListener('change', () => {
            const cid = box.dataset.pick;
            if (box.checked) {
                m.ids.add(cid);
                if (!m.perm[cid]) m.perm[cid] = 'FULL DUPLEX';
                // The first channel granted is where the unit comes up, so it
                // does not have to be told twice.
                if (!m.def) m.def = cid;
            } else {
                m.ids.delete(cid);
                // Unticking the default leaves the unit unable to sign in, so
                // clear it rather than submit a default that is not granted.
                if (m.def === cid) m.def = '';
            }
            paintAccess();
        });
    });

    document.querySelectorAll('[data-rx]').forEach((box) => {
        box.addEventListener('change', () => {
            m.perm[box.dataset.rx] = box.checked ? 'RX' : 'FULL DUPLEX';
            paintAccess();
        });
    });

    document.querySelectorAll('[data-def]').forEach((btn) => {
        btn.addEventListener('click', () => { m.def = btn.dataset.def; paintAccess(); });
    });

    document.querySelectorAll('[data-row-edit]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-access-edit');
        btn.addEventListener('click', () => {
            const row = JSON.parse(btn.dataset.state);
            m.ids = new Set(row.ids.map(String));
            m.def = String(row.def || '');
            m.perm = { ...row.perm };
            $('m_user_id').value = row.id;
            $('m_user_name').textContent = row.id + ' · ' + row.name;
            paintAccess();
        });
    });

    /* ── force logout ─────────────────────────────────────────────────── */

    let scope = { ids: [], label: '' };
    const scopeLabel = (n) => (n === 1 ? T.one : T.many.replace(':n', String(n)));

    function askKick(ids, label) {
        scope = { ids, label };
        document.querySelector('[data-kick-title]').textContent =
            T.kick_title.replace(':n', String(ids.length));
        document.querySelector('[data-kick-prompt]').textContent =
            T.kick_prompt.replace(':who', label);
    }

    table?.addEventListener('am2:bulk', (e) => {
        const { verb, ids } = e.detail;
        if (verb === 'kick') askKick(ids, scopeLabel(ids.length));
        if (verb === 'export') exportSelection(ids);
    });

    document.querySelectorAll('[data-row-kick]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-bulk-kick');
        btn.addEventListener('click', () =>
            askKick([btn.dataset.unit], btn.dataset.unit + ' · ' + btn.dataset.name));
    });

    /**
     * One request per unit, against the endpoint this page already has, so its
     * ownership check comes along for free. Every row gets its own outcome.
     */
    document.querySelector('[data-kick-apply]')?.addEventListener('click', async () => {
        const csrf = document.querySelector('input[name="_csrf"]').value;
        let ok = 0;
        const failed = [];
        for (const id of scope.ids) {
            const cell = table?.querySelector(`tr[data-row-id="${CSS.escape(id)}"] [data-row-result]`);
            if (cell) { cell.textContent = '·'; cell.className = 'w-3 font-mono text-xs text-ink-subtle'; }
            try {
                const body = new FormData();
                body.append('_csrf', csrf);
                body.append('action', 'db_force_logout');
                body.append('user_id', id);
                const r = await (await fetch(location.pathname, { method: 'POST', body })).json();
                if (!r || r.success === false) throw new Error(r?.message || '');
                ok += 1;
                if (cell) { cell.textContent = '✓'; cell.className = 'w-3 font-mono text-xs text-ok'; }
            } catch {
                failed.push(id);
                if (cell) { cell.textContent = '✕'; cell.className = 'w-3 font-mono text-xs text-bad'; }
            }
        }
        window.HSOverlay?.close(document.querySelector('#am2-bulk-kick'));
        window.AM2?.toast(
            T.done.replace(':ok', String(ok)).replace(':failed', String(failed.length)),
            failed.length === 0);
        setTimeout(() => window.location.reload(), failed.length ? 2600 : 900);
    });

    /** A native POST, because the answer to it is a file. */
    function exportSelection(ids) {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = location.pathname;
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

    /* ── the sheet ────────────────────────────────────────────────────── */

    const sheet = $('am2-access-sheet');
    const SLOTS = ['access', 'actions'];
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
            sheet.querySelector('[data-sheet-name]').textContent = btn.dataset.name;
            sheet.querySelector('[data-sheet-unit]').textContent = btn.dataset.unit;

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

    sheet?.addEventListener('close.hs.overlay', returnBorrowed);
})();
</script>
</body>
</html>
