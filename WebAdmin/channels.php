<?php
require_once 'auth.php';
require_once 'config.php';



$success_msg = "";
$error_msg = "";
$current_admin_id = $_SESSION['admin_id'];
$role_user = $_SESSION['admin_role'];
$is_super = strtolower((string) $role_user) === 'superadmin';

/** Answer as JSON and stop. The bulk paths ask over fetch. */
function am2_ch_json(array $payload): void
{
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

/**
 * The units this admin may add to or drop from a channel.
 *
 * Null means "no restriction" -- a superadmin. For anyone else a shared
 * channel keeps another tenant's units on it either way, which is why the
 * scope is passed down rather than checked once at the door.
 */
function am2_ch_scope(PDO $pdo, bool $is_super, $admin_id): ?array
{
    if ($is_super) {
        return null;
    }
    $stmt = $pdo->prepare("SELECT id FROM public.users WHERE admin_id = ?");
    $stmt->execute([$admin_id]);
    return array_map('strval', array_column($stmt->fetchAll(), 'id'));
}

/**
 * Whether this admin may manage a channel's roster.
 *
 * The same rule that decides whether the channel appears in the list at all:
 * created here, or delegated here. Narrowing it to created_by would have taken
 * the roster of every delegated channel away from the admin who runs it.
 */
function am2_ch_visible(PDO $pdo, bool $is_super, $admin_id, $channel_id): bool
{
    if ($is_super) {
        return true;
    }
    $stmt = $pdo->prepare(
        "SELECT 1 FROM public.channels c
         WHERE c.id = ?
           AND (c.created_by = ?
                OR EXISTS (SELECT 1 FROM public.admin_managed_channels amc
                           WHERE amc.channel_id = c.id AND amc.admin_id = ?))");
    $stmt->execute([$channel_id, $admin_id, $admin_id]);
    return (bool) $stmt->fetchColumn();
}

if (isset($_GET['ajax_action'])) {
    header('Content-Type: application/json');
    if ($_GET['ajax_action'] === 'get_channel_users') {
        $ch_id = (int)$_GET['channel_id'];
        $stmt = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt->execute([$ch_id]);
        echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        exit;
    }

    /*
     * The units this admin may put on a channel.
     *
     * Asked for when the dialogue is first opened, not rendered into every
     * page. Two hundred and eighteen units is thirteen hundred elements and
     * a third of a megabyte of markup, carried on every visit to a page that
     * shows eight channels -- and it grows with the fleet, so the page gets
     * slower as the deployment succeeds.
     */
    if ($_GET['ajax_action'] === 'list_units') {
        if ($is_super) {
            $stmt = $pdo->query("SELECT id, name FROM public.users WHERE role = 'user' ORDER BY name ASC");
        } else {
            $stmt = $pdo->prepare("SELECT id, name FROM public.users
                                   WHERE role = 'user' AND admin_id = ? ORDER BY name ASC");
            $stmt->execute([$current_admin_id]);
        }
        echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
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
    $ajax = !empty($_POST['ajax']);

    /*
     * Additive mode, for a selection of channels.
     *
     * The dialogue cannot show a tick state that is true of five channels at
     * once, so applying it as a replacement would silently drop every unit
     * that happened to be unticked. Adding is the only reading of the gesture
     * that means the same thing for one channel and for five.
     */
    $add_only = !empty($_POST['add_only']);

    /*
     * Both halves of this form are attacker-chosen, and only the DELETE below
     * was scoped.
     *
     * The channel: without this check a branch admin could post another
     * branch's channel id and manage its membership. The users: the INSERT loop
     * further down ran over whatever ids arrived, so a foreign unit could be
     * grafted onto a channel this admin controls -- and syncUserChannels()
     * pushes that to the relay, which means being able to hear and transmit on
     * another branch's traffic. Filtering here rather than inside the loop
     * keeps the membership write a single scoped statement.
     */
    if (strtolower($role_user) !== 'superadmin') {
        $stmtOwn = $pdo->prepare("SELECT 1 FROM public.channels WHERE id = ? AND created_by = ?");
        $stmtOwn->execute([$ch_id, $current_admin_id]);
        if (!$stmtOwn->fetchColumn()) {
            http_response_code(403);
            exit('Akses ditolak');
        }

        $selected_users = array_values(array_filter(
            $selected_users,
            fn($u) => am2_admin_owns_user($pdo, $current_admin_id, $role_user, (string) $u)
        ));
    }

    try {
        if (!am2_ch_visible($pdo, $is_super, $current_admin_id, $ch_id)) {
            throw new RuntimeException('Akses ditolak');
        }

        $pdo->beginTransaction();

        $stmt_old = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
        $stmt_old->execute([$ch_id]);
        $old_users = $stmt_old->fetchAll(PDO::FETCH_COLUMN);

        // Only the units this admin owns may be added or dropped; a shared
        // channel keeps another tenant's units on it either way.
        $scope = am2_ch_scope($pdo, $is_super, $current_admin_id);
        if ($scope !== null) {
            $foreign = array_diff(array_map('strval', $selected_users), $scope);
            if ($foreign) {
                throw new RuntimeException('Akses ditolak');
            }
        }

        // Adding is the same call with the existing roster folded in: nothing
        // is in $wanted's complement, so nothing is removed.
        $wanted = $add_only
            ? array_values(array_unique(array_merge(
                array_map('strval', $old_users),
                array_map('strval', $selected_users))))
            : $selected_users;

        // Recreating the roster used to write is_default = 'false' for every
        // member, so editing a channel stripped the default from every unit
        // on it while users.last_channel_id went on pointing here.
        am2_set_channel_members($pdo, (string) $ch_id, $wanted, $scope);

        $pdo->commit();

        $all_affected_users = array_unique(array_merge($old_users, $selected_users));
        foreach ($all_affected_users as $uid) {
            syncUserChannels($uid);
        }

        if ($ajax) {
            am2_ch_json(['success' => true]);
        }
        $success_msg = "Izin akses channel berhasil diperbarui.";
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($ajax) {
            am2_ch_json(['success' => false, 'msg' => am2_safe_error($e, 'channels')]);
        }
        $error_msg = "Gagal menyimpan akses: " . am2_safe_error($e, 'channels');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['edit_channel'])) {
    $edit_id = (int)$_POST['edit_id'];
    $edit_display = strtoupper(trim($_POST['edit_display_name']));
    $edit_category = 'public';

    try {
        if ($is_super) {
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
    $ajax = !empty($_POST['ajax']);
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

            if ($is_super) {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ?");
                $stmt_del->execute([$id]);
            } else {
                $stmt_del = $pdo->prepare("DELETE FROM public.channels WHERE id = ? AND created_by = ?");
                $stmt_del->execute([$id, $current_admin_id]);
            }

            if ($stmt_del->rowCount() > 0) {
                $pdo->commit();
                // The bulk path asks over fetch and cannot follow a redirect
                // into a page it then throws away. Same guard, same query,
                // different reply.
                if ($ajax) {
                    am2_ch_json(['success' => true]);
                }
                header("Location: channels.php?success=deleted"); exit;
            }
        }
        $pdo->rollBack();
        if ($ajax) {
            am2_ch_json(['success' => false, 'msg' => 'Akses ditolak']);
        }
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($ajax) {
            am2_ch_json(['success' => false, 'msg' => am2_safe_error($e, 'channels')]);
        }
        $error_msg = "Gagal menghapus: " . am2_safe_error($e, 'channels');
    }
}

/*
 * Export exactly the channels that were selected, as CSV.
 *
 * The ids narrow the query, they never widen it: the visibility rule below is
 * restated here, so posting somebody else's id returns nothing rather than a
 * row a branch admin was never shown.
 */
if (isset($_POST['export_selected']) && !empty($_POST['ids']) && is_array($_POST['ids'])) {
    $ids = array_values(array_filter(array_map('intval', $_POST['ids'])));
    $marks = implode(',', array_fill(0, max(1, count($ids)), '?'));
    $args = $ids ?: [0];

    $sqlx = "SELECT c.id, c.name, c.display_name, a.username AS creator_name,
                    (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id) AS total_access
             FROM public.channels c
             LEFT JOIN public.admin a ON c.created_by = a.id
             WHERE c.id IN ({$marks})";
    if (!$is_super) {
        $sqlx .= " AND (c.created_by = ? OR EXISTS (SELECT 1 FROM public.admin_managed_channels amc
                                                    WHERE amc.channel_id = c.id AND amc.admin_id = ?))";
        $args[] = $current_admin_id;
        $args[] = $current_admin_id;
    }
    $stmt_x = $pdo->prepare($sqlx . " ORDER BY c.display_name");
    $stmt_x->execute($args);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="CHANNEL_' . date('Ymd_His') . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['id', 'slug', 'nama', 'pembuat', 'unit']);
    foreach ($stmt_x as $r) {
        fputcsv($out, [$r['id'], $r['name'], $r['display_name'],
                       $r['creator_name'] ?? 'System', $r['total_access']]);
    }
    fclose($out);
    exit;
}

/** Page size. Twenty rows fill a screen without needing two scrolls. */
const AM2_CHANNEL_PAGE = 20;

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

/*
 * Chips are filters that mean something operationally. "Tanpa unit" is a
 * channel nobody can hear, which the old list said nothing about -- it read as
 * a channel like any other until somebody tried to talk on it.
 */
$chip = in_array($_GET['chip'] ?? '', ['owned', 'delegated', 'empty'], true)
    ? (string) $_GET['chip'] : '';

// Whitelisted. Neither the column nor the direction is ever interpolated from
// what arrived in the query string.
$sortable = ['name' => 'c.display_name', 'access' => 'total_access', 'owner' => 'creator_name'];
$sortCol  = $sortable[$_GET['sort'] ?? ''] ?? 'c.display_name';
$sortDir  = ($_GET['dir'] ?? 'asc') === 'desc' ? 'DESC' : 'ASC';

/*
 * Visibility, as EXISTS rather than a LEFT JOIN.
 *
 * The join it replaces produced one row per managing admin, so a channel this
 * admin created and two others manage appeared three times -- harmless in a
 * list that showed everything, wrong the moment it is counted and paged.
 */
$where  = [];
$params = [];

if (!$is_super) {
    $where[] = "(c.created_by = ? OR EXISTS (SELECT 1 FROM public.admin_managed_channels amc
                                             WHERE amc.channel_id = c.id AND amc.admin_id = ?))";
    $params[] = $current_admin_id;
    $params[] = $current_admin_id;
}
if ($search !== '') {
    $where[] = '(c.display_name ILIKE ? OR c.name ILIKE ?)';
    $params[] = "%$search%";
    $params[] = "%$search%";
}
if ($chip === 'owned') {
    $where[] = 'c.created_by = ?';
    $params[] = $current_admin_id;
} elseif ($chip === 'delegated') {
    $where[] = '(c.created_by IS NULL OR c.created_by <> ?)';
    $params[] = $current_admin_id;
} elseif ($chip === 'empty') {
    $where[] = 'NOT EXISTS (SELECT 1 FROM public.user_channels uc WHERE uc.channel_id = c.id)';
}

$fromWhere = 'FROM public.channels c LEFT JOIN public.admin a ON c.created_by = a.id'
           . ($where ? ' WHERE ' . implode(' AND ', $where) : '');

$stmt_count = $pdo->prepare("SELECT COUNT(*) {$fromWhere}");
$stmt_count->execute($params);
$total = (int) $stmt_count->fetchColumn();

$pages  = max(1, (int) ceil($total / AM2_CHANNEL_PAGE));
$page   = min(max(1, (int) ($_GET['p'] ?? 1)), $pages);
$offset = ($page - 1) * AM2_CHANNEL_PAGE;

// total_access counts only the units this admin owns, so the number on the row
// is the number the dialogue behind it can actually change.
$accessCount = $is_super
    ? '(SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id)'
    : '(SELECT COUNT(*) FROM public.user_channels uc
        WHERE uc.channel_id = c.id
          AND uc.user_id IN (SELECT id FROM public.users WHERE admin_id = ?))';

$listParams = $is_super ? $params : array_merge([$current_admin_id], $params);

$stmt = $pdo->prepare(
    "SELECT c.*, a.username AS creator_name,
            {$accessCount} AS total_access,
            (SELECT COUNT(*) FROM public.users u
             WHERE u.current_channel = c.name AND u.status = 'online') AS online_count
     {$fromWhere}
     ORDER BY {$sortCol} {$sortDir}, c.id ASC
     LIMIT " . AM2_CHANNEL_PAGE . " OFFSET {$offset}");
$stmt->execute($listParams);
$channels = $stmt->fetchAll(PDO::FETCH_ASSOC);

// Every id the filter matches, so "pilih semua yang cocok" can mean it rather
// than quietly meaning the twenty on screen.
$stmt_all = $pdo->prepare("SELECT c.id {$fromWhere} ORDER BY c.id");
$stmt_all->execute($params);
$allIds = $stmt_all->fetchAll(PDO::FETCH_COLUMN);

// Owned and delegated across everything visible, not just this page: a count
// that changes when you turn the page is not a count of anything.
$stmt_split = $pdo->prepare(
    "SELECT COUNT(*) FILTER (WHERE c.created_by = ?) AS owned,
            COUNT(*) FILTER (WHERE c.created_by IS NULL OR c.created_by <> ?) AS delegated
     FROM public.channels c"
    . ($is_super ? '' : " WHERE (c.created_by = ? OR EXISTS (SELECT 1 FROM public.admin_managed_channels amc
                                                             WHERE amc.channel_id = c.id AND amc.admin_id = ?))"));
$stmt_split->execute($is_super
    ? [$current_admin_id, $current_admin_id]
    : [$current_admin_id, $current_admin_id, $current_admin_id, $current_admin_id]);
$split = $stmt_split->fetch(PDO::FETCH_ASSOC) ?: ['owned' => 0, 'delegated' => 0];
$count_owned = (int) $split['owned'];
// A superadmin owns the lot by definition; calling another admin's channel
// "delegated to me" would be false, and the chip it draws would filter on a
// distinction that does not exist at that level.
$count_delegated = $is_super ? 0 : (int) $split['delegated'];

// Only how many. The list itself is fetched when the dialogue opens.
if ($is_super) {
    $managed_total = (int) $pdo->query("SELECT COUNT(*) FROM public.users WHERE role = 'user'")->fetchColumn();
} else {
    $stmt_u = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE role = 'user' AND admin_id = ?");
    $stmt_u->execute([$current_admin_id]);
    $managed_total = (int) $stmt_u->fetchColumn();
}
?>
<?php
$pageTitle = t('ch.heading');
$pageLede  = t('ch.lede', ['n' => number_format($total)]);

/** The table frame reads these. See partials/table_open.php. */
$tableId = 'am2-channels-table';
$searchPlaceholder = 'ch.search';
$countKey = 'ch.count';
$pageSize = AM2_CHANNEL_PAGE;

/*
 * A filter that can only ever return nothing is noise, so each chip has to
 * earn its place. A superadmin typically created none of these channels and
 * is delegated none of them either -- both words describe a distinction that
 * does not exist at that level, and drawing them anyway offers two filters
 * that always come back empty.
 */
$chips = [['value' => '', 'key' => 'ch.chip_all']];
if ($count_owned > 0) {
    $chips[] = ['value' => 'owned', 'key' => 'ch.chip_owned'];
}
if ($count_delegated > 0) {
    $chips[] = ['value' => 'delegated', 'key' => 'ch.chip_delegated', 'dot' => 'bg-accent'];
}
$chips[] = ['value' => 'empty', 'key' => 'ch.chip_empty', 'dot' => 'bg-warn'];

$columns = [
    ['key' => 'ch.name',    'sort' => 'name'],
    ['key' => 'ch.access',  'sort' => 'access'],
    ['key' => 'ch.owner',   'sort' => 'owner'],
    ['key' => 'ch.actions', 'align' => 'right'],
];

/** The page's own verb, in the toolbar with the thing it acts on. */
$tableAction = '<button type="button" data-hs-overlay="#am2-add-channel"'
    . ' class="h-11 shrink-0 rounded-control bg-brand px-4 font-mono text-[10px] font-semibold'
    . ' uppercase tracking-[0.15em] text-slate-950 transition-colors'
    . ' duration-[var(--duration-micro)] hover:bg-brand-hover">'
    . e('ch.add') . '</button>';

// Access has to ask which units, and delete has to ask whether you meant it,
// so neither can be declared as a fixed request on a button. Export answers
// with a file, which fetch cannot hand to the browser.
$bulkActions = [
    ['verb' => 'access', 'key' => 'ch.bulk_access', 'icon' => 'radio',
     'data' => ['hs-overlay' => '#am2-channel-access']],
    ['verb' => 'export', 'key' => 'ch.bulk_export', 'icon' => 'download'],
    ['verb' => 'delete', 'key' => 'ch.bulk_delete', 'icon' => 'trash', 'danger' => true,
     'data' => ['hs-overlay' => '#am2-bulk-delete']],
];

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

<?php include 'partials/table_open.php'; ?>

            <tbody class="divide-y divide-edge">
                <?php if (!$channels): ?>
                    <!-- Two empty states, not one. "Nothing yet" and "nothing
                         matched" are different problems and want different
                         next steps. -->
                    <tr>
                        <td colspan="5" class="px-5 py-16 text-center">
                            <?php $filtered = $search !== '' || $chip !== ''; ?>
                            <p class="text-sm text-ink-muted">
                                <?= $filtered ? e('ch.empty_filtered') : e('ch.empty') ?>
                            </p>
                            <?php if ($filtered): ?>
                                <a href="channels.php"
                                   class="mt-3 inline-flex h-10 items-center rounded-control border border-edge
                                          px-4 font-mono text-[10px] uppercase tracking-[0.15em]
                                          text-ink-muted! no-underline! transition-colors
                                          duration-[var(--duration-micro)] hover:border-brand hover:text-brand!">
                                    <?= e('ch.clear_filter') ?>
                                </a>
                            <?php else: ?>
                                <button type="button" data-hs-overlay="#am2-add-channel"
                                        class="mt-3 h-10 rounded-control bg-brand px-4 font-mono text-[10px]
                                               font-semibold uppercase tracking-[0.15em] text-slate-950
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:bg-brand-hover">
                                    <?= e('ch.add') ?>
                                </button>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endif; ?>

                <?php foreach ($channels as $c):
                    $cid   = (string) $c['id'];
                    $units = (int) $c['total_access'];
                    $live  = (int) $c['online_count'];
                    $mine  = $is_super || (string) $c['created_by'] === (string) $current_admin_id;
                ?>
                    <tr data-row-id="<?= htmlspecialchars($cid, ENT_QUOTES, 'UTF-8') ?>"
                        class="transition-colors hover:bg-card-muted">

                        <td data-cell="select" data-label="<?= e('tbl.select') ?>" class="w-10 px-4 align-middle lg:ps-5">
                            <input type="checkbox" data-select
                                   aria-label="<?= e('ch.select_channel', ['ch' => (string) $c['display_name']]) ?>"
                                   class="h-4 w-4 cursor-pointer rounded border-edge-strong text-brand
                                          focus:ring-brand/40">
                        </td>

                        <td data-cell="unit" data-label="<?= e('ch.name') ?>" class="px-4 py-2.5 align-middle">
                            <span class="flex items-start gap-2.5">
                                <!-- Somebody is on it right now. A channel with
                                     traffic is not one to delete by accident. -->
                                <span data-live
                                      class="mt-1.5 h-2 w-2 shrink-0 rounded-full <?= $live > 0 ? 'bg-ok' : 'bg-edge-strong' ?>"
                                      aria-hidden="true"></span>
                                <span class="min-w-0">
                                    <span class="block truncate text-sm font-medium text-ink">
                                        <?= htmlspecialchars((string) $c['display_name']) ?>
                                    </span>
                                    <span class="block truncate font-mono text-[10px] text-ink-subtle">
                                        <?= htmlspecialchars((string) $c['name']) ?>
                                    </span>

                                    <!--
                                        Narrow: one line, and a fault outranks a
                                        fact on it. A channel with no unit on it
                                        cannot carry anything, so it says that
                                        where the count would have been.
                                    -->
                                    <span data-summary class="block text-xs lg:hidden">
                                        <?php if ($units === 0): ?>
                                            <span class="text-warn"><?= e('ch.no_units') ?></span>
                                        <?php else: ?>
                                            <span class="text-ink-muted">
                                                <?= (int) $units ?> <?= e('ch.units') ?>
                                            </span>
                                        <?php endif; ?>
                                        <span class="text-ink-subtle"> ·
                                            <?= htmlspecialchars((string) ($c['creator_name'] ?? 'System')) ?>
                                        </span>
                                    </span>
                                </span>

                                <!-- Everything else about this channel is one tap
                                     away, and the chevron is what says so. -->
                                <button type="button" data-open-sheet data-sheet-row
                                        data-hs-overlay="#am2-channel-sheet"
                                        data-ch="<?= htmlspecialchars($cid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $c['display_name'], ENT_QUOTES, 'UTF-8') ?>"
                                        data-slug="<?= htmlspecialchars((string) $c['name'], ENT_QUOTES, 'UTF-8') ?>"
                                        aria-haspopup="dialog"
                                        aria-label="<?= e('ch.open_detail', ['ch' => (string) $c['display_name']]) ?>"
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

                        <td data-cell="access" data-label="<?= e('ch.access') ?>" class="px-4 py-2.5 align-middle">
                            <?php if ($units === 0): ?>
                                <span class="inline-flex items-center gap-1.5 rounded-control border border-warn/40
                                             bg-warn/5 px-2 py-1 font-mono text-[9px] uppercase
                                             tracking-[0.1em] text-warn">
                                    <?= am2_icon('alert', 'h-3 w-3') ?><?= e('ch.no_units') ?>
                                </span>
                            <?php else: ?>
                                <span class="font-mono text-sm tabular-nums text-ink"><?= $units ?></span>
                                <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                                    <?= e('ch.units') ?>
                                </span>
                                <?php if ($live > 0): ?>
                                    <span class="ms-1 font-mono text-[10px] text-ok">
                                        <?= e('ch.live', ['n' => $live]) ?>
                                    </span>
                                <?php endif; ?>
                            <?php endif; ?>
                        </td>

                        <td data-cell="owner" data-label="<?= e('ch.owner') ?>" class="px-4 py-2.5 align-middle">
                            <span class="text-sm text-ink-muted"><?= htmlspecialchars((string) ($c['creator_name'] ?? 'System')) ?></span>
                            <?php if (!$mine): ?>
                                <span class="ms-1 rounded-control bg-accent/10 px-1.5 py-0.5 font-mono
                                             text-[9px] uppercase tracking-[0.1em] text-accent">
                                    <?= e('ch.delegated_tag') ?>
                                </span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="actions" data-label="<?= e('ch.actions') ?>" class="px-4 py-2.5 text-right align-middle">
                            <span class="inline-flex flex-wrap items-center justify-end gap-2">
                                <span data-row-result class="w-3 font-mono text-xs"></span>

                                <button type="button" data-row-access
                                        data-ch="<?= htmlspecialchars($cid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $c['display_name'], ENT_QUOTES, 'UTF-8') ?>"
                                        class="h-8 rounded-control border border-edge px-2.5 font-mono
                                               text-[9px] uppercase tracking-[0.12em] text-ink-muted
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:border-brand hover:text-brand">
                                    <?= e('ch.manage_access') ?>
                                </button>

                                <button type="button" data-row-edit
                                        data-ch="<?= htmlspecialchars($cid, ENT_QUOTES, 'UTF-8') ?>"
                                        data-name="<?= htmlspecialchars((string) $c['display_name'], ENT_QUOTES, 'UTF-8') ?>"
                                        class="h-8 rounded-control border border-edge px-2.5 font-mono
                                               text-[9px] uppercase tracking-[0.12em] text-ink-muted
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:border-brand hover:text-brand">
                                    <?= e('ch.edit') ?>
                                </button>

                                <form method="POST" class="inline"
                                      onsubmit="return confirm(<?= htmlspecialchars(json_encode(t('ch.delete_confirm')), ENT_QUOTES) ?>)">
                                    <?= am2_csrf_field() ?>
                                    <input type="hidden" name="delete_channel" value="<?= (int) $c['id'] ?>">
                                    <button type="submit"
                                            class="h-8 rounded-control border border-edge px-2.5 font-mono
                                                   text-[9px] uppercase tracking-[0.12em] text-bad
                                                   transition-colors duration-[var(--duration-micro)]
                                                   hover:border-bad/50 hover:bg-bad/10">
                                        <?= e('ch.delete') ?>
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
 * page only decides what a dialogue is about before Preline shows it.
 */
$ovl = 'hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto bg-slate-950/50 backdrop-blur-sm';
$card = 'am2-surface mx-auto my-[8vh] w-[92%] max-w-md overflow-hidden rounded-card';
$fieldCls = 'mt-2 h-11 w-full rounded-control border border-edge bg-card px-3 text-sm text-ink'
          . ' transition-colors duration-[var(--duration-micro)] hover:border-edge-strong'
          . ' focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';
$labelCls = 'font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle';
$btnGhost = 'h-11 rounded-control border border-edge px-4 font-mono text-[10px] font-semibold'
          . ' uppercase tracking-[0.15em] text-ink-muted transition-colors'
          . ' duration-[var(--duration-micro)] hover:text-ink';
$btnBrand = 'h-11 rounded-control bg-brand px-4 font-mono text-[10px] font-semibold uppercase'
          . ' tracking-[0.15em] text-slate-950 transition-colors duration-[var(--duration-micro)]'
          . ' hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40';
?>

<!-- New channel. The slug is derived, so the form asks for the one thing a
     person actually decides. -->
<div id="am2-add-channel" role="dialog" tabindex="-1" aria-labelledby="am2-add-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <form method="POST">
            <?= am2_csrf_field() ?>
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-add-label" class="text-base font-semibold text-ink"><?= e('ch.add_title') ?></h2>
            </header>
            <div class="space-y-4 p-5">
                <div>
                    <label for="display_name" class="<?= $labelCls ?>"><?= e('ch.new_name') ?></label>
                    <input id="display_name" name="display_name" type="text" required
                           autocomplete="off" data-slug-source
                           placeholder="<?= e('ch.new_placeholder') ?>" class="<?= $fieldCls ?>">
                    <p class="mt-2 font-mono text-[10px] text-ink-subtle">
                        <?= e('ch.slug_hint') ?> <span data-slug-preview class="text-brand">—</span>
                    </p>
                </div>
            </div>
            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-add-channel" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="add_channel" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!-- Rename. -->
<div id="am2-edit-channel" role="dialog" tabindex="-1" aria-labelledby="am2-edit-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <form method="POST">
            <?= am2_csrf_field() ?>
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-edit-label" class="text-base font-semibold text-ink"><?= e('ch.edit_title') ?></h2>
                <p data-edit-scope class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand"></p>
            </header>
            <div class="space-y-4 p-5">
                <input type="hidden" name="edit_id" id="am2-edit-id" value="">
                <div>
                    <label for="edit_display_name" class="<?= $labelCls ?>"><?= e('ch.display_name') ?></label>
                    <input id="edit_display_name" name="edit_display_name" type="text" required class="<?= $fieldCls ?>">
                </div>
            </div>
            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-edit-channel" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="edit_channel" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!--
    Access. One dialogue for a single channel and for a selection, and the
    difference between them is stated rather than implied: for one channel the
    ticks are its current roster and saving replaces it; for several there is
    no roster the ticks could describe, so saving adds and never removes.
-->
<div id="am2-channel-access" role="dialog" tabindex="-1" aria-labelledby="am2-access-label" class="<?= $ovl ?>">
    <div data-am2-panel class="am2-surface mx-auto my-[6vh] flex max-h-[88vh] w-[92%] max-w-lg
                                flex-col overflow-hidden rounded-card">
        <header class="border-b border-edge px-5 py-4">
            <h2 id="am2-access-label" class="text-base font-semibold text-ink"><?= e('ch.manage_access') ?></h2>
            <p data-access-scope class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand"></p>
            <p data-access-mode class="mt-1 text-xs text-ink-muted"></p>
        </header>

        <div class="flex items-center justify-between gap-3 border-b border-edge px-5 py-2.5">
            <label class="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" data-access-all
                       class="h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40">
                <?= e('ch.select_all') ?>
            </label>
            <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                <span data-access-count class="tabular-nums text-ink-muted">0</span> / <?= $managed_total ?>
            </span>
        </div>

        <!-- Filled on first open. Empty here on purpose: see the list_units
             endpoint above for why the roster is not rendered into the page. -->
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            <?php if ($managed_total === 0): ?>
                <p class="py-8 text-center text-sm text-ink-muted"><?= e('ch.no_units_available') ?></p>
            <?php else: ?>
                <p data-unit-status class="py-8 text-center text-sm text-ink-muted"><?= e('ch.loading_units') ?></p>
                <ul data-unit-list class="space-y-1"></ul>
            <?php endif; ?>
        </div>

        <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" data-hs-overlay="#am2-channel-access" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
            <button type="button" data-access-apply class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
        </footer>
    </div>
</div>

<!-- Delete, for a selection. The count has to be typed: the number is the
     whole sentence, and a channel takes its logs with it. -->
<div id="am2-bulk-delete" role="dialog" tabindex="-1" aria-labelledby="am2-delete-label" class="<?= $ovl ?>">
    <div data-am2-panel class="<?= $card ?>">
        <header class="border-b border-edge px-5 py-4">
            <h2 id="am2-delete-label" data-delete-title class="text-base font-semibold text-bad"></h2>
        </header>
        <div class="space-y-4 p-5">
            <p data-delete-prompt class="text-sm text-ink-muted"></p>
            <input id="am2-delete-count" type="text" inputmode="numeric" autocomplete="off"
                   class="<?= $fieldCls ?> font-mono">
        </div>
        <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
            <button type="button" data-hs-overlay="#am2-bulk-delete" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
            <button type="button" data-delete-apply disabled
                    class="h-11 rounded-control bg-bad px-4 font-mono text-[10px] font-semibold uppercase
                           tracking-[0.15em] text-white transition-colors
                           duration-[var(--duration-micro)] hover:opacity-90
                           disabled:cursor-not-allowed disabled:opacity-40">
                <?= e('ch.delete') ?>
            </button>
        </footer>
    </div>
</div>

<!--
    The channel sheet.

    It holds no copy of anything: on open, the row's own cells are moved into
    it and moved back when it closes. One set of controls, one set of handlers,
    and a button that works in the sheet is the button that works in the table.
-->
<div id="am2-channel-sheet" role="dialog" tabindex="-1" aria-labelledby="am2-sheet-label"
     class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
            bg-slate-950/50 backdrop-blur-sm lg:hidden">
    <div data-am2-panel
         class="am2-surface fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto
                rounded-t-card border-b-0">
        <header class="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
            <span class="min-w-0">
                <span id="am2-sheet-label" data-sheet-name
                      class="block truncate text-base font-semibold text-ink"></span>
                <span data-sheet-slug class="block truncate font-mono text-xs text-ink-muted"></span>
            </span>
            <button type="button" data-hs-overlay="#am2-channel-sheet"
                    aria-label="<?= e('ch.cancel') ?>"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-control text-ink-subtle
                           transition-colors duration-[var(--duration-micro)] hover:text-ink">
                <?= am2_icon('close', 'h-4 w-4') ?>
            </button>
        </header>

        <div class="divide-y divide-edge">
            <?php foreach ([['access', 'ch.access'], ['owner', 'ch.owner']] as [$slot, $label]): ?>
                <div class="flex items-center gap-3 px-5 py-2">
                    <span class="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.15em]
                                 text-ink-subtle"><?= e($label) ?></span>
                    <span data-slot="<?= $slot ?>" class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"></span>
                </div>
            <?php endforeach; ?>
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
    const table = $('am2-channels-table');
    const T = <?= json_encode([
        'one'     => t('ch.scope_one'),
        'many'    => t('ch.scope_many'),
        'replace' => t('ch.access_replace'),
        'add'     => t('ch.access_add'),
        'done'    => t('ch.bulk_done'),
        'del'     => t('ch.bulk_delete_title'),
        'prompt'  => t('ch.bulk_delete_prompt'),
    ], JSON_UNESCAPED_UNICODE) ?>;

    /** What the next dialogue is about: a row, or the selection. */
    let scope = { ids: [], label: '', addOnly: false };

    const setScope = (ids, label, addOnly) => {
        scope = { ids, label, addOnly };
        document.querySelectorAll('[data-access-scope], [data-edit-scope]')
            .forEach((el) => { el.textContent = label; });
        const mode = document.querySelector('[data-access-mode]');
        if (mode) mode.textContent = addOnly ? T.add : T.replace;
    };

    const scopeLabel = (n) => (n === 1 ? T.one : T.many.replace(':n', String(n)));

    const picks = () => [...document.querySelectorAll('[data-unit-pick]')];

    /*
     * The unit list, fetched once and kept. Every path that opens the dialogue
     * awaits this first, so nothing can tick a box that is not there yet.
     */
    const unitList = document.querySelector('[data-unit-list]');
    let unitsReady = null;

    function loadUnits() {
        if (unitsReady) return unitsReady;
        unitsReady = (async () => {
            if (!unitList) return;
            const res = await fetch('channels.php?ajax_action=list_units',
                { headers: { Accept: 'application/json' } });
            const units = await res.json();

            const frag = document.createDocumentFragment();
            for (const u of units) {
                const li = document.createElement('li');
                const label = document.createElement('label');
                label.className = 'flex h-11 cursor-pointer items-center gap-3 rounded-control px-2'
                    + ' transition-colors duration-[var(--duration-micro)] hover:bg-card-muted';

                const box = document.createElement('input');
                box.type = 'checkbox';
                box.dataset.unitPick = '';
                box.value = String(u.id);
                box.className = 'h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40';

                const name = document.createElement('span');
                name.className = 'min-w-0 flex-1 truncate text-sm text-ink';
                name.textContent = u.name ?? '';

                const id = document.createElement('span');
                id.className = 'font-mono text-[10px] text-ink-subtle';
                id.textContent = String(u.id);

                label.append(box, name, id);
                li.appendChild(label);
                frag.appendChild(li);
            }
            unitList.appendChild(frag);
            document.querySelector('[data-unit-status]')?.remove();
        })().catch(() => {
            // Let the next open try again rather than leaving a dialogue that
            // is permanently empty and says nothing about why.
            unitsReady = null;
            const status = document.querySelector('[data-unit-status]');
            if (status) status.textContent = <?= json_encode(t('ch.units_failed'), JSON_UNESCAPED_UNICODE) ?>;
        });
        return unitsReady;
    }
    const recount = () => {
        const n = picks().filter((c) => c.checked).length;
        const out = document.querySelector('[data-access-count]');
        if (out) out.textContent = String(n);
        const all = document.querySelector('[data-access-all]');
        if (all) {
            all.checked = n > 0 && n === picks().length;
            all.indeterminate = n > 0 && n < picks().length;
        }
    };

    document.querySelector('[data-access-all]')?.addEventListener('change', (e) => {
        picks().forEach((c) => { c.checked = e.target.checked; });
        recount();
    });
    // Delegated: the boxes do not exist when this runs.
    unitList?.addEventListener('change', (e) => {
        if (e.target.matches('[data-unit-pick]')) recount();
    });

    // A bulk verb the table runtime handed back because it needs to ask
    // something first. Preline opens the dialogue; this only says what it is
    // about, and must run before the operator can answer.
    table?.addEventListener('am2:bulk', (e) => {
        const { verb, ids } = e.detail;
        if (verb === 'access') {
            // Nothing is prefilled: no tick state is true of five channels at
            // once, so the dialogue adds rather than replaces and says so.
            setScope(ids, scopeLabel(ids.length), true);
            loadUnits().then(() => {
                picks().forEach((c) => { c.checked = false; });
                recount();
            });
        }
        if (verb === 'delete') {
            setScope(ids, scopeLabel(ids.length), false);
            document.querySelector('[data-delete-title]').textContent = T.del.replace(':n', String(ids.length));
            document.querySelector('[data-delete-prompt]').textContent = T.prompt.replace(':n', String(ids.length));
            const input = $('am2-delete-count');
            input.value = '';
            document.querySelector('[data-delete-apply]').disabled = true;
        }
        if (verb === 'export') exportSelection(ids);
    });

    // A single channel. The button carries data-hs-overlay as well, so Preline
    // opens the dialogue through its own trigger.
    document.querySelectorAll('[data-row-access]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-channel-access');
        btn.addEventListener('click', async () => {
            setScope([btn.dataset.ch], btn.dataset.name, false);
            try {
                // Both in flight at once: the roster of this channel does not
                // depend on the list of units it will be ticked onto.
                const [, res] = await Promise.all([
                    loadUnits(),
                    fetch(`channels.php?ajax_action=get_channel_users&channel_id=${encodeURIComponent(btn.dataset.ch)}`),
                ]);
                const wanted = new Set((await res.json() ?? []).map(String));
                picks().forEach((c) => { c.checked = wanted.has(String(c.value)); });
            } catch {
                // Leave every box clear rather than show a roster that is a
                // guess: saving from a guess is what would drop units.
            }
            recount();
        });
    });

    document.querySelectorAll('[data-row-edit]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-edit-channel');
        btn.addEventListener('click', () => {
            $('am2-edit-id').value = btn.dataset.ch;
            $('edit_display_name').value = btn.dataset.name;
            document.querySelector('[data-edit-scope]').textContent = btn.dataset.name;
        });
    });

    /**
     * One request per channel, against the handlers this page already has, so
     * the ownership checks come along for free. Every row is given its own
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

    document.querySelector('[data-access-apply]')?.addEventListener('click', () => {
        const chosen = picks().filter((c) => c.checked).map((c) => c.value);
        applyToScope((id) => {
            const fields = { save_channel_access: '1', manage_ch_id: id, ajax: '1', 'users[]': chosen };
            if (scope.addOnly) fields.add_only = '1';
            return fields;
        }, '#am2-channel-access');
    });

    // The count has to be typed. The number is the whole sentence.
    const delInput = $('am2-delete-count');
    delInput?.addEventListener('input', () => {
        document.querySelector('[data-delete-apply]').disabled =
            delInput.value.trim() !== String(scope.ids.length);
    });
    document.querySelector('[data-delete-apply]')?.addEventListener('click', () => {
        applyToScope((id) => ({ delete_channel: id, ajax: '1' }), '#am2-bulk-delete');
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

    /** The slug is derived, so the form shows what it is deriving. */
    const slugSource = document.querySelector('[data-slug-source]');
    slugSource?.addEventListener('input', () => {
        const preview = document.querySelector('[data-slug-preview]');
        const v = slugSource.value.trim().toUpperCase().replace(/ /g, '_').toLowerCase();
        if (preview) preview.textContent = v || '—';
    });

    /*
     * The sheet borrows the row's own cells rather than copying them, so the
     * control in the sheet is the control in the table: the same element, the
     * same state, the same listener. They go home when the sheet closes.
     */
    const sheet = $('am2-channel-sheet');
    const SLOTS = ['access', 'owner', 'actions'];
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
            sheet.querySelector('[data-sheet-slug]').textContent = btn.dataset.slug;

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
     * is open. `lg:hidden` takes the panel away, but Preline's backdrop is a
     * child of body and knows nothing about the breakpoint -- it stayed at full
     * opacity with the body still scroll-locked, so the page sat under a grey
     * scrim belonging to nothing visible. Closing through Preline is what
     * removes the backdrop, restores the scroll and returns the borrowed cells.
     */
    const desktop = window.matchMedia('(min-width: 1024px)');
    desktop.addEventListener('change', () => {
        if (desktop.matches && sheet?.classList.contains('opened')) {
            window.HSOverlay?.close(sheet);
        }
    });
})();
</script>
</body>
</html>
