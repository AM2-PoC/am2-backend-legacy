<?php
require_once 'auth.php';
require_once 'config.php';

require_superadmin();

$success_msg = "";
$error_msg = "";

/** Answer as JSON and stop. The bulk path asks over fetch. */
function am2_adm_json(array $payload): void
{
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

/**
 * Whether this admin account may be deleted, and why not.
 *
 * Three rules, and they are stated once here because the row, the bulk path
 * and the handler all have to agree about them -- the confirm dialogue used to
 * offer the act to every row and the handler refused three kinds of it after
 * the fact.
 */
function am2_adm_undeletable(array $row, $my_id): string
{
    if ((string) $row['role'] === 'superadmin') return 'adm.locked_super';
    if ((int) $row['id'] === 1)                 return 'adm.locked_master';
    if ((int) $row['id'] === (int) $my_id)      return 'adm.locked_self';
    return '';
}

if (isset($_POST['delete_admin_id'])) {
    $id_to_delete = (int)$_POST['delete_admin_id'];
    $my_id = (int)$_SESSION['admin_id'];
    $ajax = !empty($_POST['ajax']);

    try {
        $stmt_check = $pdo->prepare("SELECT id, role FROM public.admin WHERE id = ?");
        $stmt_check->execute([$id_to_delete]);
        $target = $stmt_check->fetch();

        if (!$target) {
            $error_msg = "Admin tidak ditemukan.";
        } elseif (($why = am2_adm_undeletable($target, $my_id)) !== '') {
            $error_msg = t($why);
        } else {
            $stmt = $pdo->prepare("DELETE FROM public.admin WHERE id = ? AND id != ?");
            $stmt->execute([$id_to_delete, $my_id]);
            $success_msg = "Akun admin cabang berhasil dihapus.";
        }
    } catch (PDOException $e) {
        $error_msg = "Gagal menghapus: " . am2_safe_error($e, 'admin_panel');
    }

    if ($ajax) {
        am2_adm_json($error_msg === ''
            ? ['success' => true]
            : ['success' => false, 'msg' => $error_msg]);
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['save_admin'])) {
    $admin_id = !empty($_POST['admin_id']) ? (int)$_POST['admin_id'] : null;
    $username = trim($_POST['username']);

    // Whitelisted. The column takes whatever it is given, and a role nothing
    // recognises is an account that can neither be used nor found by the
    // filters that look for one of the two that exist.
    $role = in_array($_POST['role'] ?? '', ['admin', 'superadmin'], true)
        ? $_POST['role'] : 'admin';

    $u_quota = ($role === 'superadmin') ? 999999 : (int)$_POST['user_quota'];
    $c_quota = ($role === 'superadmin') ? 999999 : (int)$_POST['channel_quota'];

    $is_permanent = isset($_POST['is_permanent']);
    $expired_at = $is_permanent ? null : ($_POST['expired_at'] ?: null);

    $can_maps  = isset($_POST['can_manage_maps'])  ? 'true' : 'false';
    $can_p2p   = isset($_POST['can_manage_p2p'])   ? 'true' : 'false';
    $can_video = isset($_POST['can_manage_video']) ? 'true' : 'false';

    try {
        if ($admin_id) {
            // The permission flags are parameters now. They were derived from
            // isset() either way, so nothing could reach the string -- but a
            // query built by concatenation invites the next value to be built
            // the same way, and the next one may not be a boolean.
            $sql = "UPDATE public.admin SET username = ?, role = ?, user_quota = ?, channel_quota = ?,
                    expired_at = ?, can_manage_maps = ?, can_manage_p2p = ?, can_manage_video = ?,
                    status = 'active'";
            $params = [$username, $role, $u_quota, $c_quota, $expired_at,
                       $can_maps, $can_p2p, $can_video];

            if (!empty($_POST['password'])) {
                $sql .= ", password_hash = ?";
                $params[] = password_hash($_POST['password'], PASSWORD_BCRYPT);
            }
            $sql .= " WHERE id = ?";
            $params[] = $admin_id;
            $pdo->prepare($sql)->execute($params);

            notifyNodeServerToRefresh($admin_id);
        } else {
            $password = password_hash($_POST['password'], PASSWORD_BCRYPT);
            $stmt = $pdo->prepare(
                "INSERT INTO public.admin (username, password_hash, role, user_quota, channel_quota,
                                           expired_at, can_manage_maps, can_manage_p2p,
                                           can_manage_video, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')");
            $stmt->execute([$username, $password, $role, $u_quota, $c_quota, $expired_at,
                            $can_maps, $can_p2p, $can_video]);
        }
        $success_msg = "Konfigurasi admin berhasil disimpan.";
    } catch (PDOException $e) {
        $error_msg = "Gagal menyimpan: " . am2_safe_error($e, 'admin_panel');
    }
}

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['update_delegation'])) {
    $target_admin_id = (int)$_POST['target_admin_id'];
    $selected_channels = $_POST['channels'] ?? [];

    try {
        $pdo->beginTransaction();
        $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE admin_id = ?")->execute([$target_admin_id]);

        if (!empty($selected_channels)) {
            $stmt_ch = $pdo->prepare("INSERT INTO public.admin_managed_channels (admin_id, channel_id) VALUES (?, ?)");
            foreach ($selected_channels as $ch_id) {
                $stmt_ch->execute([$target_admin_id, (int)$ch_id]);
            }
        }
        $pdo->commit();
        $success_msg = "Delegasi channel berhasil diperbarui.";
    } catch (PDOException $e) {
        $pdo->rollBack();
        $error_msg = "Gagal delegasi: " . am2_safe_error($e, 'admin_panel');
    }
}

/** Page size. Twenty rows fill a screen without needing two scrolls. */
const AM2_ADMIN_PAGE = 20;

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

/*
 * Chips are filters that mean something operationally. An expired account is
 * not a tidy-up job: every unit under that admin loses access with it, and
 * nothing on this page said which accounts were in that state.
 */
$chip = in_array($_GET['chip'] ?? '', ['expired', 'permanent', 'branch'], true)
    ? (string) $_GET['chip'] : '';

$sortable = ['name' => 'a.username', 'expiry' => 'a.expired_at', 'id' => 'a.id'];
$sortCol  = $sortable[$_GET['sort'] ?? ''] ?? 'a.id';
$sortDir  = ($_GET['dir'] ?? 'desc') === 'asc' ? 'ASC' : 'DESC';

$where  = ['a.id != ?'];
$params = [$_SESSION['admin_id']];

if ($search !== '') {
    $where[] = 'a.username ILIKE ?';
    $params[] = "%$search%";
}
if ($chip === 'expired') {
    $where[] = 'a.expired_at IS NOT NULL AND a.expired_at < NOW()';
} elseif ($chip === 'permanent') {
    $where[] = 'a.expired_at IS NULL';
} elseif ($chip === 'branch') {
    $where[] = "a.role = 'admin'";
}

$fromWhere = 'FROM public.admin a WHERE ' . implode(' AND ', $where);

$stmt_count = $pdo->prepare("SELECT COUNT(*) {$fromWhere}");
$stmt_count->execute($params);
$total = (int) $stmt_count->fetchColumn();

$pages  = max(1, (int) ceil($total / AM2_ADMIN_PAGE));
$page   = min(max(1, (int) ($_GET['p'] ?? 1)), $pages);
$offset = ($page - 1) * AM2_ADMIN_PAGE;

$stmt_list = $pdo->prepare("
    SELECT a.*,
    CASE
        WHEN a.expired_at IS NOT NULL AND a.expired_at < NOW() THEN 'expired'
        ELSE a.status
    END as current_status,
    (
        SELECT json_agg(channel_id) FROM (
            SELECT channel_id FROM public.admin_managed_channels WHERE admin_id = a.id
            UNION
            SELECT id AS channel_id FROM public.channels WHERE created_by = a.id
        ) as combined_channels
    ) as channel_ids
    {$fromWhere} ORDER BY {$sortCol} {$sortDir}, a.id DESC
    LIMIT " . AM2_ADMIN_PAGE . " OFFSET {$offset}");
$stmt_list->execute($params);
$admins = $stmt_list->fetchAll(PDO::FETCH_ASSOC);

foreach ($admins as &$adm) {
    $adm['channel_ids'] = json_decode($adm['channel_ids'] ?? '[]', true) ?: [];
    // Never rendered into the page, not even inside the JSON the edit button
    // carries: the dialogue asks for a new password, it never shows the old.
    unset($adm['password_hash']);
}
unset($adm);

// Every id the filter matches, so "pilih semua yang cocok" can mean it.
$stmt_all = $pdo->prepare("SELECT a.id {$fromWhere} ORDER BY a.id");
$stmt_all->execute($params);
$allIds = $stmt_all->fetchAll(PDO::FETCH_COLUMN);

$all_channels = $pdo->query("SELECT id, display_name FROM public.channels ORDER BY display_name ASC")->fetchAll(PDO::FETCH_ASSOC);
?>
<?php
$pageTitle = t('adm.heading');
$pageLede  = t('adm.lede');

/** The table frame reads these. See partials/table_open.php. */
$tableId = 'am2-admin-table';
$searchPlaceholder = 'adm.search';
$countKey = 'adm.count';
$pageSize = AM2_ADMIN_PAGE;

$chips = [
    ['value' => '',          'key' => 'adm.chip_all'],
    ['value' => 'expired',   'key' => 'adm.chip_expired', 'dot' => 'bg-bad'],
    ['value' => 'permanent', 'key' => 'adm.chip_permanent'],
    ['value' => 'branch',    'key' => 'adm.chip_branch'],
];

$columns = [
    ['key' => 'adm.account',  'sort' => 'name'],
    ['key' => 'adm.features'],
    ['key' => 'adm.quota',    'align' => 'right'],
    ['key' => 'adm.expiry',   'sort' => 'expiry'],
    ['key' => 'usr.actions',  'align' => 'right'],
];

$tableAction = '<button type="button" data-hs-overlay="#am2-admin-form" data-admin-add'
    . ' class="h-11 shrink-0 rounded-control bg-brand px-4 font-mono text-[10px] font-semibold'
    . ' uppercase tracking-[0.15em] text-slate-950 transition-colors'
    . ' duration-[var(--duration-micro)] hover:bg-brand-hover">'
    . e('adm.add') . '</button>';

$bulkActions = [
    ['verb' => 'delete', 'key' => 'adm.bulk_delete', 'icon' => 'trash', 'danger' => true,
     'data' => ['hs-overlay' => '#am2-bulk-delete']],
];

/** The switches on the form, in the order they appear. */
$permFields = [
    ['can_manage_maps',  'adm.f_maps'],
    ['can_manage_p2p',   'adm.f_p2p'],
    ['can_manage_video', 'adm.f_video'],
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
                <?php if (!$admins): ?>
                    <tr>
                        <td colspan="6" class="px-5 py-16 text-center">
                            <?php $filtered = $search !== '' || $chip !== ''; ?>
                            <p class="text-sm text-ink-muted">
                                <?= $filtered ? e('adm.empty_filtered') : e('adm.empty') ?>
                            </p>
                            <?php if ($filtered): ?>
                                <a href="admin_panel.php"
                                   class="mt-3 inline-flex h-10 items-center rounded-control border border-edge
                                          px-4 font-mono text-[10px] uppercase tracking-[0.15em]
                                          text-ink-muted! no-underline! transition-colors
                                          duration-[var(--duration-micro)] hover:border-brand hover:text-brand!">
                                    <?= e('usr.clear_filter') ?>
                                </a>
                            <?php else: ?>
                                <button type="button" data-hs-overlay="#am2-admin-form" data-admin-add
                                        class="mt-3 h-10 rounded-control bg-brand px-4 font-mono text-[10px]
                                               font-semibold uppercase tracking-[0.15em] text-slate-950
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:bg-brand-hover">
                                    <?= e('adm.add') ?>
                                </button>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endif; ?>

                <?php foreach ($admins as $a):
                    $aid     = (string) $a['id'];
                    $isSuper = (string) $a['role'] === 'superadmin';
                    $expired = ($a['current_status'] ?? '') === 'expired';
                    $locked  = am2_adm_undeletable($a, $_SESSION['admin_id']);
                    $expiry  = $a['expired_at'] ? strtotime((string) $a['expired_at']) : null;
                ?>
                    <tr data-row-id="<?= htmlspecialchars($aid, ENT_QUOTES, 'UTF-8') ?>"
                        class="transition-colors hover:bg-card-muted">

                        <td data-cell="select" data-label="<?= e('tbl.select') ?>" class="w-10 px-4 align-middle lg:ps-5">
                            <input type="checkbox" data-select
                                   <?= $locked ? 'disabled title="' . e($locked) . '"' : '' ?>
                                   aria-label="<?= e('adm.select_account', ['name' => (string) $a['username']]) ?>"
                                   class="h-4 w-4 cursor-pointer rounded border-edge-strong text-brand
                                          focus:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-30">
                        </td>

                        <td data-cell="unit" data-label="<?= e('adm.account') ?>" class="px-4 py-2.5 align-middle">
                            <span class="flex items-start gap-2.5">
                                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full <?= $expired ? 'bg-bad' : 'bg-ok' ?>"
                                      aria-hidden="true"></span>
                                <span class="min-w-0">
                                    <span class="flex items-center gap-2">
                                        <span class="truncate text-sm text-ink"><?= htmlspecialchars((string) $a['username']) ?></span>
                                        <?php if ($isSuper): ?>
                                            <span class="shrink-0 rounded-control bg-accent/10 px-1.5 font-mono
                                                         text-[9px] uppercase tracking-[0.1em] text-accent">
                                                <?= e('adm.super') ?>
                                            </span>
                                        <?php endif; ?>
                                    </span>

                                    <span data-summary class="block text-xs lg:hidden">
                                        <?php if ($expired): ?>
                                            <span class="text-bad"><?= e('adm.expired_on', ['when' => date('d M Y', (int) $expiry)]) ?></span>
                                        <?php elseif (!$expiry): ?>
                                            <span class="text-ink-muted"><?= e('adm.permanent') ?></span>
                                        <?php else: ?>
                                            <span class="text-ink-muted"><?= e('adm.until', ['when' => date('d M Y', $expiry)]) ?></span>
                                        <?php endif; ?>
                                        <span class="text-ink-subtle"> ·
                                            <?= $isSuper ? e('adm.unlimited')
                                                         : (int) $a['user_quota'] . ' / ' . (int) $a['channel_quota'] ?>
                                        </span>
                                    </span>
                                </span>

                                <button type="button" data-open-sheet data-sheet-row
                                        data-hs-overlay="#am2-admin-sheet"
                                        data-name="<?= htmlspecialchars((string) $a['username'], ENT_QUOTES, 'UTF-8') ?>"
                                        data-role="<?= $isSuper ? e('adm.super') : e('adm.branch') ?>"
                                        aria-haspopup="dialog"
                                        aria-label="<?= e('adm.open_detail', ['name' => (string) $a['username']]) ?>"
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

                        <td data-cell="features" data-label="<?= e('adm.features') ?>" class="px-4 py-2.5 align-middle">
                            <?php if ($isSuper): ?>
                                <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-accent">
                                    <?= e('adm.full_access') ?>
                                </span>
                            <?php else: ?>
                                <span class="flex flex-wrap gap-1.5">
                                    <?php foreach ($permFields as [$key, $labelKey]):
                                        $on = ($a[$key] === true || $a[$key] === 't' || $a[$key] === 'true'); ?>
                                        <span class="am2-chip <?= $on ? 'border-brand bg-brand/10 text-brand'
                                                                     : 'border-edge text-ink-subtle' ?>">
                                            <?= e($labelKey) ?>
                                        </span>
                                    <?php endforeach; ?>
                                </span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="quota" data-label="<?= e('adm.quota') ?>" class="px-4 py-2.5 text-right align-middle">
                            <?php if ($isSuper): ?>
                                <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                                    <?= e('adm.unlimited') ?>
                                </span>
                            <?php else: ?>
                                <span class="font-mono text-sm tabular-nums text-ink">
                                    <?= (int) $a['user_quota'] ?><span class="text-ink-subtle">/</span><?= (int) $a['channel_quota'] ?>
                                </span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="expiry" data-label="<?= e('adm.expiry') ?>" class="px-4 py-2.5 align-middle">
                            <?php if ($expired): ?>
                                <span class="inline-flex items-center gap-1.5 rounded-control border border-bad/40
                                             bg-bad/5 px-2 py-1 font-mono text-[9px] uppercase
                                             tracking-[0.1em] text-bad">
                                    <?= am2_icon('alert', 'h-3 w-3') ?><?= e('adm.expired') ?>
                                </span>
                                <span class="ms-1 font-mono text-[10px] text-ink-subtle"><?= date('d M Y', (int) $expiry) ?></span>
                            <?php elseif (!$expiry): ?>
                                <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                                    <?= e('adm.permanent') ?>
                                </span>
                            <?php else: ?>
                                <span class="font-mono text-sm tabular-nums text-ink-muted"><?= date('d M Y', $expiry) ?></span>
                            <?php endif; ?>
                        </td>

                        <td data-cell="actions" data-label="<?= e('usr.actions') ?>" class="px-4 py-2.5 text-right align-middle">
                            <span class="inline-flex flex-wrap items-center justify-end gap-2">
                                <span data-row-result class="w-3 font-mono text-xs"></span>

                                <button type="button" data-row-edit
                                        data-admin="<?= htmlspecialchars(json_encode($a, JSON_UNESCAPED_UNICODE), ENT_QUOTES, 'UTF-8') ?>"
                                        class="h-8 rounded-control border border-edge px-2.5 font-mono
                                               text-[9px] uppercase tracking-[0.12em] text-ink-muted
                                               transition-colors duration-[var(--duration-micro)]
                                               hover:border-brand hover:text-brand">
                                    <?= e('adm.edit') ?>
                                </button>

                                <?php if (!$isSuper): ?>
                                    <!-- Delegation used to open by clicking the row
                                         itself, which nothing announced and a
                                         keyboard could not reach. -->
                                    <button type="button" data-row-delegate
                                            data-id="<?= (int) $a['id'] ?>"
                                            data-name="<?= htmlspecialchars((string) $a['username'], ENT_QUOTES, 'UTF-8') ?>"
                                            data-channels="<?= htmlspecialchars(json_encode($a['channel_ids']), ENT_QUOTES, 'UTF-8') ?>"
                                            class="h-8 rounded-control border border-edge px-2.5 font-mono
                                                   text-[9px] uppercase tracking-[0.12em] text-ink-muted
                                                   transition-colors duration-[var(--duration-micro)]
                                                   hover:border-brand hover:text-brand">
                                        <?= e('adm.delegate') ?>
                                    </button>
                                <?php endif; ?>

                                <?php if ($locked): ?>
                                    <span title="<?= e($locked) ?>"
                                          class="grid h-8 w-8 place-items-center rounded-control border border-edge
                                                 text-ink-subtle opacity-40">
                                        <?= am2_icon('lock', 'h-3.5 w-3.5') ?>
                                    </span>
                                <?php else: ?>
                                    <form method="POST" class="inline"
                                          onsubmit="return confirm(<?= htmlspecialchars(json_encode(t('adm.delete_confirm')), ENT_QUOTES) ?>)">
                                        <?= am2_csrf_field() ?>
                                        <input type="hidden" name="delete_admin_id" value="<?= (int) $a['id'] ?>">
                                        <button type="submit"
                                                class="h-8 rounded-control border border-edge px-2.5 font-mono
                                                       text-[9px] uppercase tracking-[0.12em] text-bad
                                                       transition-colors duration-[var(--duration-micro)]
                                                       hover:border-bad/50 hover:bg-bad/10">
                                            <?= e('adm.delete') ?>
                                        </button>
                                    </form>
                                <?php endif; ?>
                            </span>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>

<?php include 'partials/table_close.php'; ?>

<?php
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

<!-- The account form. One dialogue for adding and for editing; the heading and
     whether the password is required are what tell the two apart. -->
<div id="am2-admin-form" role="dialog" tabindex="-1" aria-labelledby="am2-form-label" class="<?= $ovl ?>">
    <div data-am2-panel class="am2-surface mx-auto my-[5vh] flex max-h-[90vh] w-[92%] max-w-lg
                                flex-col overflow-hidden rounded-card">
        <form method="POST" class="flex min-h-0 flex-1 flex-col">
            <?= am2_csrf_field() ?>
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-form-label" data-form-title class="text-base font-semibold text-ink"></h2>
            </header>

            <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
                <input type="hidden" name="admin_id" id="f_id" value="">

                <div>
                    <label for="f_username" class="<?= $labelCls ?>"><?= e('adm.username') ?></label>
                    <input id="f_username" name="username" type="text" required autocomplete="off"
                           class="<?= $fieldCls ?>">
                </div>

                <div>
                    <label for="f_password" class="<?= $labelCls ?>"><?= e('adm.password') ?></label>
                    <div class="relative">
                        <input id="f_password" name="password" type="password" autocomplete="new-password"
                               class="<?= $fieldCls ?> pe-12 font-mono">
                        <button type="button" data-hs-toggle-password='{"target": "#f_password"}'
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
                    <p data-password-hint class="mt-2 text-xs text-ink-muted"></p>
                </div>

                <div>
                    <label for="f_role" class="<?= $labelCls ?>"><?= e('adm.role') ?></label>
                    <select id="f_role" name="role" class="<?= $fieldCls ?>">
                        <option value="admin"><?= e('adm.role_branch') ?></option>
                        <option value="superadmin"><?= e('adm.role_super') ?></option>
                    </select>
                </div>

                <!-- Both of these describe limits, and a superadmin has none, so
                     they are hidden rather than filled with a number that means
                     nothing. -->
                <div data-branch-only class="space-y-4">
                    <fieldset class="rounded-control border border-edge p-4">
                        <legend class="<?= $labelCls ?> px-1"><?= e('adm.features_legend') ?></legend>
                        <div class="mt-1 grid grid-cols-3 gap-2">
                            <?php foreach ($permFields as [$key, $labelKey]): ?>
                                <label class="flex cursor-pointer items-center gap-2 text-sm text-ink">
                                    <input type="checkbox" name="<?= $key ?>" id="f_<?= $key ?>"
                                           class="h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40">
                                    <?= e($labelKey) ?>
                                </label>
                            <?php endforeach; ?>
                        </div>
                    </fieldset>

                    <fieldset class="rounded-control border border-edge p-4">
                        <legend class="<?= $labelCls ?> px-1"><?= e('adm.quota_legend') ?></legend>
                        <div class="mt-1 grid grid-cols-2 gap-3">
                            <div>
                                <label for="f_user_quota" class="<?= $labelCls ?>"><?= e('adm.quota_users') ?></label>
                                <input id="f_user_quota" name="user_quota" type="number" min="0"
                                       class="<?= $fieldCls ?> font-mono tabular-nums">
                            </div>
                            <div>
                                <label for="f_channel_quota" class="<?= $labelCls ?>"><?= e('adm.quota_channels') ?></label>
                                <input id="f_channel_quota" name="channel_quota" type="number" min="0"
                                       class="<?= $fieldCls ?> font-mono tabular-nums">
                            </div>
                        </div>
                    </fieldset>
                </div>

                <fieldset class="rounded-control border border-edge p-4">
                    <legend class="<?= $labelCls ?> px-1"><?= e('adm.expiry_legend') ?></legend>
                    <label class="mt-1 flex cursor-pointer items-center gap-2 text-sm text-ink">
                        <input type="checkbox" name="is_permanent" id="f_permanent"
                               class="h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40">
                        <?= e('adm.permanent_label') ?>
                    </label>
                    <div data-date-row class="mt-3 flex gap-2">
                        <input id="f_expired" name="expired_at" type="date" class="<?= $fieldCls ?> mt-0 font-mono">
                        <button type="button" data-add-30
                                class="mt-0 h-11 shrink-0 rounded-control border border-edge px-3 font-mono
                                       text-[10px] uppercase tracking-[0.15em] text-ink-muted
                                       transition-colors duration-[var(--duration-micro)]
                                       hover:border-brand hover:text-brand">
                            <?= e('adm.add_30') ?>
                        </button>
                    </div>
                </fieldset>
            </div>

            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-admin-form" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="save_admin" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!-- Delegation: which channels a branch admin may manage. -->
<div id="am2-delegate" role="dialog" tabindex="-1" aria-labelledby="am2-delegate-label" class="<?= $ovl ?>">
    <div data-am2-panel class="am2-surface mx-auto my-[6vh] flex max-h-[88vh] w-[92%] max-w-lg
                                flex-col overflow-hidden rounded-card">
        <form method="POST" class="flex min-h-0 flex-1 flex-col">
            <?= am2_csrf_field() ?>
            <input type="hidden" name="target_admin_id" id="delegate_admin_id" value="">
            <header class="border-b border-edge px-5 py-4">
                <h2 id="am2-delegate-label" class="text-base font-semibold text-ink"><?= e('adm.delegate_title') ?></h2>
                <p data-delegate-scope class="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-brand"></p>
                <p class="mt-1 text-xs text-ink-muted"><?= e('adm.delegate_note') ?></p>
            </header>

            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
                <?php if (!$all_channels): ?>
                    <p class="py-8 text-center text-sm text-ink-muted"><?= e('adm.no_channels') ?></p>
                <?php else: ?>
                    <ul class="space-y-1">
                        <?php foreach ($all_channels as $ch): ?>
                            <li>
                                <label class="flex h-11 cursor-pointer items-center gap-3 rounded-control px-2
                                              transition-colors duration-[var(--duration-micro)] hover:bg-card-muted">
                                    <input type="checkbox" data-delegate-pick name="channels[]"
                                           value="<?= (int) $ch['id'] ?>"
                                           class="h-4 w-4 rounded border-edge-strong text-brand focus:ring-brand/40">
                                    <span class="min-w-0 flex-1 truncate text-sm text-ink"><?= htmlspecialchars((string) $ch['display_name']) ?></span>
                                </label>
                            </li>
                        <?php endforeach; ?>
                    </ul>
                <?php endif; ?>
            </div>

            <footer class="flex justify-end gap-2 border-t border-edge px-5 py-4">
                <button type="button" data-hs-overlay="#am2-delegate" class="<?= $btnGhost ?>"><?= e('ch.cancel') ?></button>
                <button type="submit" name="update_delegation" value="1" class="<?= $btnBrand ?>"><?= e('ch.save') ?></button>
            </footer>
        </form>
    </div>
</div>

<!-- Delete, for a selection. The count has to be typed: every unit under an
     admin loses its access with the account. -->
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
                <?= e('adm.delete') ?>
            </button>
        </footer>
    </div>
</div>

<!-- The account sheet: the row's own cells, moved in and moved back. -->
<div id="am2-admin-sheet" role="dialog" tabindex="-1" aria-labelledby="am2-sheet-label"
     class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
            bg-slate-950/50 backdrop-blur-sm lg:hidden">
    <div data-am2-panel
         class="am2-surface fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto
                rounded-t-card border-b-0">
        <header class="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
            <span class="min-w-0">
                <span id="am2-sheet-label" data-sheet-name
                      class="block truncate text-base font-semibold text-ink"></span>
                <span data-sheet-role class="block truncate font-mono text-xs text-ink-muted"></span>
            </span>
            <button type="button" data-hs-overlay="#am2-admin-sheet"
                    aria-label="<?= e('ch.cancel') ?>"
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-control text-ink-subtle
                           transition-colors duration-[var(--duration-micro)] hover:text-ink">
                <?= am2_icon('close', 'h-4 w-4') ?>
            </button>
        </header>

        <div class="divide-y divide-edge">
            <?php foreach ([['features', 'adm.features'], ['quota', 'adm.quota'],
                            ['expiry', 'adm.expiry']] as [$slot, $label]): ?>
                <div class="flex items-center gap-3 px-5 py-2">
                    <span class="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.15em]
                                 text-ink-subtle"><?= e($label) ?></span>
                    <span data-slot="<?= $slot ?>" class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"></span>
                </div>
            <?php endforeach; ?>
        </div>

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
    const table = $('am2-admin-table');
    const T = <?= json_encode([
        'add'       => t('adm.add_title'),
        'edit'      => t('adm.edit_title'),
        'pw_new'    => t('adm.password_required'),
        'pw_keep'   => t('adm.password_keep'),
        'one'       => t('adm.scope_one'),
        'many'      => t('adm.scope_many'),
        'done'      => t('adm.bulk_done'),
        'del'       => t('adm.bulk_delete_title'),
        'prompt'    => t('adm.bulk_delete_prompt'),
    ], JSON_UNESCAPED_UNICODE) ?>;

    /* ── the account form ─────────────────────────────────────────────── */

    const roleSel = $('f_role');
    const permanent = $('f_permanent');

    /** Limits belong to a branch admin; a superadmin has none to state. */
    function paintRole() {
        const isSuper = roleSel.value === 'superadmin';
        document.querySelectorAll('[data-branch-only]').forEach((el) => { el.hidden = isSuper; });
    }

    /** A permanent account has no date, so the field goes rather than sits
     *  there holding a value the handler will throw away. */
    function paintExpiry() {
        const perm = permanent.checked;
        document.querySelector('[data-date-row]').hidden = perm;
        $('f_expired').required = !perm;
    }

    roleSel?.addEventListener('change', paintRole);
    permanent?.addEventListener('change', paintExpiry);

    document.querySelector('[data-add-30]')?.addEventListener('click', () => {
        const field = $('f_expired');
        const from = field.value ? new Date(field.value) : new Date();
        const base = Number.isNaN(from.getTime()) ? new Date() : from;
        base.setDate(base.getDate() + 30);
        field.value = base.toISOString().split('T')[0];
    });

    function openForm(data) {
        const adding = !data;
        document.querySelector('[data-form-title]').textContent = adding ? T.add : T.edit;
        document.querySelector('[data-password-hint]').textContent = adding ? T.pw_new : T.pw_keep;

        $('f_id').value = adding ? '' : data.id;
        $('f_username').value = adding ? '' : (data.username ?? '');
        $('f_password').value = '';
        $('f_password').required = adding;
        roleSel.value = adding ? 'admin' : (data.role ?? 'admin');
        $('f_user_quota').value = adding ? '' : (data.user_quota ?? '');
        $('f_channel_quota').value = adding ? '' : (data.channel_quota ?? '');

        // Postgres hands booleans back as true, 't' or 'true' depending on the
        // driver's mood; all three mean the same thing here.
        const on = (v) => v === true || v === 't' || v === 'true';
        $('f_can_manage_maps').checked  = adding ? true  : on(data.can_manage_maps);
        $('f_can_manage_p2p').checked   = adding ? true  : on(data.can_manage_p2p);
        $('f_can_manage_video').checked = adding ? false : on(data.can_manage_video);

        if (adding) {
            permanent.checked = false;
            const soon = new Date();
            soon.setDate(soon.getDate() + 30);
            $('f_expired').value = soon.toISOString().split('T')[0];
        } else if (data.expired_at) {
            permanent.checked = false;
            $('f_expired').value = String(data.expired_at).split(' ')[0];
        } else {
            permanent.checked = true;
            $('f_expired').value = '';
        }

        paintRole();
        paintExpiry();
    }

    document.querySelectorAll('[data-admin-add]').forEach((btn) => {
        btn.addEventListener('click', () => openForm(null));
    });

    document.querySelectorAll('[data-row-edit]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-admin-form');
        btn.addEventListener('click', () => {
            try {
                openForm(JSON.parse(btn.dataset.admin));
            } catch {
                openForm(null);
            }
        });
    });

    /* ── delegation ───────────────────────────────────────────────────── */

    document.querySelectorAll('[data-row-delegate]').forEach((btn) => {
        btn.setAttribute('data-hs-overlay', '#am2-delegate');
        btn.addEventListener('click', () => {
            $('delegate_admin_id').value = btn.dataset.id;
            document.querySelector('[data-delegate-scope]').textContent = btn.dataset.name;
            let held = [];
            try { held = JSON.parse(btn.dataset.channels || '[]'); } catch { held = []; }
            const wanted = new Set(held.map(String));
            document.querySelectorAll('[data-delegate-pick]').forEach((c) => {
                c.checked = wanted.has(String(c.value));
            });
        });
    });

    /* ── bulk delete ──────────────────────────────────────────────────── */

    let scope = { ids: [] };
    const scopeLabel = (n) => (n === 1 ? T.one : T.many.replace(':n', String(n)));

    table?.addEventListener('am2:bulk', (e) => {
        const { verb, ids } = e.detail;
        if (verb !== 'delete') return;
        scope = { ids };
        document.querySelector('[data-delete-title]').textContent = T.del.replace(':n', String(ids.length));
        document.querySelector('[data-delete-prompt]').textContent =
            T.prompt.replace(':n', String(ids.length)).replace(':who', scopeLabel(ids.length));
        const input = $('am2-delete-count');
        input.value = '';
        document.querySelector('[data-delete-apply]').disabled = true;
    });

    const delInput = $('am2-delete-count');
    delInput?.addEventListener('input', () => {
        document.querySelector('[data-delete-apply]').disabled =
            delInput.value.trim() !== String(scope.ids.length);
    });

    document.querySelector('[data-delete-apply]')?.addEventListener('click', async () => {
        const csrf = document.querySelector('input[name="_csrf"]').value;
        let ok = 0;
        const failed = [];
        for (const id of scope.ids) {
            const cell = table?.querySelector(`tr[data-row-id="${CSS.escape(id)}"] [data-row-result]`);
            if (cell) { cell.textContent = '·'; cell.className = 'w-3 font-mono text-xs text-ink-subtle'; }
            try {
                const body = new FormData();
                body.append('_csrf', csrf);
                body.append('delete_admin_id', id);
                body.append('ajax', '1');
                const r = await (await fetch(location.pathname, { method: 'POST', body })).json();
                if (!r || r.success === false) throw new Error(r?.msg || '');
                ok += 1;
                if (cell) { cell.textContent = '✓'; cell.className = 'w-3 font-mono text-xs text-ok'; }
            } catch {
                failed.push(id);
                if (cell) { cell.textContent = '✕'; cell.className = 'w-3 font-mono text-xs text-bad'; }
            }
        }
        window.HSOverlay?.close(document.querySelector('#am2-bulk-delete'));
        window.AM2?.toast(
            T.done.replace(':ok', String(ok)).replace(':failed', String(failed.length)),
            failed.length === 0);
        setTimeout(() => window.location.reload(), failed.length ? 2600 : 900);
    });

    /* ── the sheet ────────────────────────────────────────────────────── */

    const sheet = $('am2-admin-sheet');
    const SLOTS = ['features', 'quota', 'expiry', 'actions'];
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
            sheet.querySelector('[data-sheet-role]').textContent = btn.dataset.role;

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

    paintRole();
    paintExpiry();
})();
</script>
</body>
</html>
