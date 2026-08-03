<?php
require_once 'auth.php';
require_once 'config.php';

$role_user  = $_SESSION['admin_role'];
$admin_id   = $_SESSION['admin_id'];
$admin_user = $_SESSION['admin_username'];
$is_super   = $role_user === 'superadmin';
$msg        = '';
$error      = '';

/**
 * Refuse an operation that crosses tenant boundaries, and say so in the log.
 *
 * api_settings.php guards import-db with am2_api_require_super(); this page
 * ran the same psql pipe with no role check at all, so any branch admin could
 * overwrite every tenant's data. The two ends of one operation now agree.
 */
function am2_page_require_super(bool $is_super, string $what): bool
{
    if ($is_super) {
        return false;
    }
    error_log(sprintf(
        'AM2 page-authz REJECT %s %s from %s reason=%s',
        $_SERVER['REQUEST_METHOD'] ?? '?',
        $_SERVER['REQUEST_URI'] ?? '?',
        am2_client_ip(),
        $what
    ));
    return true;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['update_password'])) {
    $new_pass     = $_POST['new_password'] ?? '';
    $confirm_pass = $_POST['confirm_password'] ?? '';

    if (strlen($new_pass) < 8) {
        $error = t('set.err_password_short');
    } elseif ($new_pass !== $confirm_pass) {
        $error = t('set.err_password_mismatch');
    } else {
        try {
            $stmt = $pdo->prepare("UPDATE public.admin SET password_hash = ? WHERE id = ?");
            $stmt->execute([password_hash($new_pass, PASSWORD_BCRYPT), $admin_id]);
            $msg = t('set.msg_password_ok');
        } catch (PDOException $e) {
            $error = am2_safe_error($e, 'settings');
        }
    }
}

if (isset($_POST['upload_apk']) && isset($_FILES['apk_file'])) {
    if (am2_page_require_super($is_super, 'upload-apk')) {
        $error = t('set.err_denied');
    } else {
        $target_dir = 'update/';
        if (!is_dir($target_dir)) {
            mkdir($target_dir, 0755, true);
        }

        $file_name = basename($_FILES['apk_file']['name']);
        $target    = $target_dir . $file_name;

        if (strtolower(pathinfo($target, PATHINFO_EXTENSION)) !== 'apk') {
            $error = t('set.err_apk_type');
        } elseif (move_uploaded_file($_FILES['apk_file']['tmp_name'], $target)) {
            $msg = t('set.msg_apk_ok', ['file' => $file_name]);
        } else {
            $error = t('set.err_apk_move');
        }
    }
}

if (isset($_POST['export_db'])) {
    $timestamp = date('Ymd_His');
    $filename  = ($is_super ? 'FULL_BACKUP_' : 'BACKUP_' . strtoupper($admin_user) . '_')
               . $timestamp . '.sql';

    header('Content-Type: application/octet-stream');
    header('Content-disposition: attachment; filename="' . $filename . '"');

    putenv('PGPASSWORD=' . $password);

    // -p was missing here and present in api_settings.php, so this dumped
    // whatever cluster happened to answer on the default port.
    $base = 'pg_dump -h ' . $host . ' -p ' . $port . ' -U ' . $user . ' -d ' . $dbname;
    $command = $is_super
        ? $base . ' -n public'
        : $base . ' -t public.users -t public.channels --column-inserts';

    passthru($command);
    exit;
}

if (isset($_POST['import_db']) && isset($_FILES['sql_file'])) {
    if (am2_page_require_super($is_super, 'import-db')) {
        $error = t('set.err_denied');
    } else {
        $file = $_FILES['sql_file']['tmp_name'];
        $ext  = strtolower(pathinfo($_FILES['sql_file']['name'], PATHINFO_EXTENSION));

        if ($ext !== 'sql') {
            $error = t('set.err_sql_type');
        } elseif (is_uploaded_file($file)) {
            putenv('PGPASSWORD=' . $password);

            /*
             * Two flags carry this, and neither was here before.
             *
             * ON_ERROR_STOP: psql exits 0 even when every statement in the file
             * was rejected. Five "value too long" errors and a status of 0 is
             * what the operator was reading as a completed restore.
             *
             * --single-transaction: the restore is all or nothing. Without it a
             * dump that breaks halfway leaves the database half overwritten,
             * which is the hardest state to recover from -- worse than a
             * restore that refuses to start.
             */
            $command = 'psql -v ON_ERROR_STOP=1 --single-transaction'
                     . ' -h ' . $host . ' -p ' . $port . ' -U ' . $user
                     . ' -d ' . $dbname . ' < ' . $file . ' 2>&1';

            // exec(), not shell_exec(): the exit status is the whole point.
            $output = [];
            $status = 1;
            exec($command, $output, $status);

            // ptt_logs cannot hold this event: user_id is a foreign key to
            // users(id) and channel_id to channels(id), and an admin is neither
            // a device nor a channel. The server log can, and it already
            // carries the refusals from am2_page_require_super().
            error_log(sprintf(
                'AM2 settings RESTORE by=%s from=%s file=%s status=%d',
                $admin_user,
                am2_client_ip(),
                basename($_FILES['sql_file']['name']),
                $status
            ));

            if ($status === 0) {
                $msg = t('set.msg_restore_ok');
            } else {
                // The operator chose this file, so the reason it was refused is
                // theirs to read. A refusal with no reason is a dead end.
                $reason = '';
                foreach ($output as $line) {
                    if (stripos($line, 'ERROR') !== false) { $reason = $line; break; }
                }
                if ($reason === '' && $output) {
                    $reason = (string) end($output);
                }
                $error = t('set.err_restore_failed',
                           ['reason' => mb_substr(trim($reason), 0, 200)]);
            }
        }
    }
}

try {
    $stmt = $pdo->prepare("SELECT * FROM public.admin WHERE id = ?");
    $stmt->execute([$admin_id]);
    $settings = $stmt->fetch();

    if ($is_super) {
        $total_admins   = $pdo->query("SELECT COUNT(*) FROM public.admin WHERE role = 'admin'")->fetchColumn();
        $total_users    = $pdo->query("SELECT COUNT(*) FROM public.users")->fetchColumn();
        $total_channels = $pdo->query("SELECT COUNT(*) FROM public.channels")->fetchColumn();
    } else {
        $total_admins = 0;

        $stmt_u = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ?");
        $stmt_u->execute([$admin_id]);
        $total_users = $stmt_u->fetchColumn();

        $stmt_c = $pdo->prepare("SELECT COUNT(*) FROM public.channels WHERE created_by = ?");
        $stmt_c->execute([$admin_id]);
        $total_channels = $stmt_c->fetchColumn();
    }
} catch (PDOException $e) {
    die(htmlspecialchars(am2_safe_error($e, 'settings')));
}

/**
 * How much of a quota is spent, as a percentage, or null when there is no
 * ceiling. A superadmin has no quota: showing "100" beside "sisa UNLIMITED"
 * stated two contradictory things at once.
 */
function am2_quota_pct($used, $quota): ?int
{
    if (!is_numeric($quota) || (int) $quota <= 0) {
        return null;
    }
    return (int) min(100, round(((int) $used / (int) $quota) * 100));
}

$quotas = [
    ['label' => 'set.quota_users',    'used' => (int) $total_users,
     'quota' => $is_super ? null : ($settings['user_quota'] ?? null),    'icon' => 'users'],
    ['label' => 'set.quota_channels', 'used' => (int) $total_channels,
     'quota' => $is_super ? null : ($settings['channel_quota'] ?? null), 'icon' => 'radio'],
];

$features = [
    ['key' => 'set.feature_video', 'on' => (bool) $settings['can_manage_video']],
    ['key' => 'set.feature_maps',  'on' => (bool) $settings['can_manage_maps']],
    ['key' => 'set.feature_chat',  'on' => (bool) $settings['can_manage_p2p']],
];

$stats = [
    ['key' => 'set.stat_devices',  'value' => (int) $total_users,    'href' => 'users.php'],
    ['key' => 'set.stat_channels', 'value' => (int) $total_channels, 'href' => 'channels.php'],
];
if ($is_super) {
    array_unshift($stats,
        ['key' => 'set.stat_admins', 'value' => (int) $total_admins, 'href' => 'admin_panel.php']);
}

$pageTitle = t('set.heading');
$pageLede  = t('set.lede');
$pageActions = '<span class="hidden rounded-control border border-edge px-2.5 py-1.5 font-mono'
    . ' text-[10px] uppercase tracking-[0.15em] lg:inline-block '
    . ($is_super ? 'border-bad/40 text-bad' : 'text-ink-muted') . '">'
    . htmlspecialchars(strtoupper($role_user)) . '</span>';

include 'partials/head.php';
include 'partials/shell.php';
?>

<?php if ($msg !== '' || $error !== ''): ?>
    <!-- The result of a POST round trip, so it belongs on the page rather than
         in a toast that can be missed while the page is reloading. -->
    <div role="<?= $error !== '' ? 'alert' : 'status' ?>" data-kpi
         class="mb-4 flex items-start gap-2.5 rounded-control border px-3 py-3 text-sm
                <?= $error !== '' ? 'border-bad/40 border-l-2 border-l-bad bg-bad/5'
                                  : 'border-ok/40 border-l-2 border-l-ok bg-ok/5' ?>">
        <span class="mt-px shrink-0 <?= $error !== '' ? 'text-bad' : 'text-ok' ?>" aria-hidden="true">
            <?= am2_icon($error !== '' ? 'alert' : 'shield', 'h-4 w-4') ?>
        </span>
        <span><?= htmlspecialchars($error !== '' ? $error : $msg) ?></span>
    </div>
<?php endif; ?>

<!--
    Scope of the account, as three counts. Each one is a link, because each one
    is a page in this panel; the arrow is the same affordance the dashboard
    cards carry.
-->
<section class="grid gap-4 sm:grid-cols-2 <?= $is_super ? 'md:grid-cols-3' : '' ?>">
    <?php foreach ($stats as $s): ?>
        <a href="<?= $s['href'] ?>" data-kpi
           class="am2-surface am2-clickable group flex flex-col rounded-card p-5
                  no-underline! text-ink!">
            <p class="flex items-center justify-between font-mono text-[10px] uppercase
                      tracking-[0.18em] text-ink-subtle">
                <span><?= e($s['key']) ?></span>
                <span aria-hidden="true"
                      class="opacity-0 transition-opacity duration-[var(--duration-micro)]
                             group-hover:opacity-100">&rarr;</span>
            </p>
            <p class="mt-3 font-mono text-4xl font-semibold leading-none tabular-nums"
               data-stat><?= number_format($s['value']) ?></p>
        </a>
    <?php endforeach; ?>
</section>

<div class="mt-4 grid items-start gap-4 lg:grid-cols-2" data-reveal>

    <div class="flex flex-col gap-4">

        <!-- Account. One thing an operator changes here, and it is their own key. -->
        <section class="am2-surface rounded-card">
            <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
                <span class="text-ink-subtle"><?= am2_icon('lock', 'h-4 w-4') ?></span>
                <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
                    <?= e('set.account') ?>
                </h2>
            </header>

            <div class="p-5">
                <p class="flex items-baseline justify-between gap-3 border-b border-edge pb-4">
                    <span class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.username') ?>
                    </span>
                    <span class="truncate font-mono text-sm text-ink">
                        <?= htmlspecialchars($settings['username']) ?>
                    </span>
                </p>

                <!-- method and field names are the contract: the handler above reads
                     $_POST['update_password'], ['new_password'] and ['confirm_password']. -->
                <form method="POST" class="mt-4">
                    <?= am2_csrf_field() ?>

                    <?php
                    /*
                     * Preline toggle-password:
                     * https://preline.co/docs/toggle-password.html
                     * Replaces the hand-rolled Font Awesome eye, which swapped two
                     * icon classes by hand and had no pressed state to announce.
                     */
                    $fields = [
                        ['id' => 'new_password',     'name' => 'new_password',
                         'label' => 'set.new_password',     'hint' => 'set.new_password_hint'],
                        ['id' => 'confirm_password', 'name' => 'confirm_password',
                         'label' => 'set.confirm_password', 'hint' => 'set.confirm_hint'],
                    ];
                    foreach ($fields as $f): ?>
                        <div class="mb-4">
                            <label for="<?= $f['id'] ?>"
                                   class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                                <?= e($f['label']) ?>
                            </label>
                            <div class="relative mt-2">
                                <input id="<?= $f['id'] ?>" name="<?= $f['name'] ?>" type="password" required
                                       minlength="8" autocomplete="new-password"
                                       placeholder="<?= e($f['hint']) ?>"
                                       class="h-12 w-full rounded-control border border-edge bg-card pe-12 ps-3
                                              font-mono text-base text-ink transition-colors
                                              duration-[var(--duration-micro)]
                                              hover:border-edge-strong focus:border-brand focus:outline-none
                                              focus:ring-2 focus:ring-brand/25">
                                <button type="button"
                                        data-hs-toggle-password='{"target": "#<?= $f['id'] ?>"}'
                                        class="absolute inset-y-0 end-0 grid w-12 place-items-center
                                               rounded-e-control text-ink-subtle transition-colors
                                               duration-[var(--duration-micro)] hover:text-brand
                                               focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                                        aria-label="<?= e('set.show_password') ?>">
                                    <svg class="hs-password-active:hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                         stroke-linejoin="round" aria-hidden="true">
                                        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>
                                        <circle cx="12" cy="12" r="3"/>
                                    </svg>
                                    <svg class="hs-password-active:block hidden h-5 w-5" viewBox="0 0 24 24" fill="none"
                                         stroke="currentColor" stroke-width="1.75" stroke-linecap="round"
                                         stroke-linejoin="round" aria-hidden="true">
                                        <path d="M10.7 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.2"/>
                                        <path d="M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>
                                        <path d="m2 2 20 20"/>
                                        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    <?php endforeach; ?>

                    <button type="submit" name="update_password" value="1"
                            class="h-12 w-full rounded-control bg-brand px-4 font-mono text-[11px]
                                   font-semibold uppercase tracking-[0.15em] text-slate-950
                                   transition-colors duration-[var(--duration-micro)]
                                   hover:bg-brand-hover focus:outline-none focus-visible:ring-2
                                   focus-visible:ring-brand/60">
                        <?= e('set.submit_password') ?>
                    </button>
                </form>
            </div>
        </section>

        <?php if ($is_super): ?>
            <!-- Distribution. The field app checks update/admin_version.json. -->
            <section class="am2-surface rounded-card">
                <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
                    <span class="text-ink-subtle"><?= am2_icon('inbox', 'h-4 w-4') ?></span>
                    <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
                        <?= e('set.distribution') ?>
                    </h2>
                </header>

                <div class="p-5">
                    <form method="POST" enctype="multipart/form-data">
                        <?= am2_csrf_field() ?>
                        <input type="file" name="apk_file" accept=".apk" required
                               aria-label="<?= e('set.distribution') ?>"
                               class="w-full cursor-pointer rounded-control border border-edge bg-card
                                      text-sm text-ink-muted file:me-3 file:cursor-pointer file:border-0
                                      file:bg-card-muted file:px-4 file:py-3 file:font-mono
                                      file:text-[10px] file:uppercase file:tracking-[0.15em]
                                      file:text-ink hover:border-edge-strong focus:border-brand
                                      focus:outline-none focus:ring-2 focus:ring-brand/25">

                        <div class="mt-3 flex items-center justify-between gap-3">
                            <!-- 135x15 on a phone. A link beside a 44px button has
                                 to be reachable by the same thumb. -->
                            <a href="update/" target="_blank" rel="noopener"
                               class="inline-flex h-11 items-center font-mono text-[10px]
                                      uppercase tracking-[0.15em] text-ink-subtle!
                                      no-underline! hover:text-brand!
                                      focus-visible:outline-2 focus-visible:outline-offset-2">
                                <?= e('set.open_folder') ?>
                            </a>
                            <button type="submit" name="upload_apk" value="1"
                                    class="h-11 rounded-control border border-edge px-5 font-mono
                                           text-[10px] font-semibold uppercase tracking-[0.15em]
                                           text-ink transition-colors duration-[var(--duration-micro)]
                                           hover:border-brand hover:text-brand focus:outline-none
                                           focus-visible:ring-2 focus-visible:ring-brand/60">
                                <?= e('set.upload') ?>
                            </button>
                        </div>
                    </form>
                </div>
            </section>
        <?php endif; ?>
        </div>

    <!-- Licence and quota. -->
    <section class="am2-surface rounded-card">
        <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
            <span class="text-ink-subtle"><?= am2_icon('shield', 'h-4 w-4') ?></span>
            <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('set.licence') ?>
            </h2>
        </header>

        <div class="p-5">
            <div class="am2-surface-accent rounded-control border border-edge bg-card-muted px-4 py-3">
                <p class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                    <?= e('set.valid_until') ?>
                </p>
                <p class="mt-1 text-lg font-semibold text-ink">
                    <?= ($settings['expired_at'] && $settings['expired_at'] !== 'infinity')
                        ? htmlspecialchars(date('d F Y', strtotime($settings['expired_at'])))
                        : e('set.lifetime') ?>
                </p>
            </div>

            <!-- Usage against the ceiling, not two numbers side by side.
                 The old card printed "100" next to "sisa UNLIMITED". -->
            <div class="mt-5 space-y-4">
                <?php foreach ($quotas as $q): $pct = am2_quota_pct($q['used'], $q['quota']); ?>
                    <div>
                        <p class="flex items-center justify-between gap-3">
                            <span class="flex items-center gap-2 font-mono text-[10px] uppercase
                                         tracking-[0.15em] text-ink-subtle">
                                <?= am2_icon($q['icon'], 'h-3.5 w-3.5') ?><?= e($q['label']) ?>
                            </span>
                            <span class="font-mono text-sm tabular-nums text-ink">
                                <?= number_format($q['used']) ?>
                                <span class="text-ink-subtle">/
                                    <?= $pct === null ? e('set.unlimited')
                                                      : number_format((int) $q['quota']) ?>
                                </span>
                            </span>
                        </p>
                        <?php if ($pct !== null): ?>
                            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-card-muted"
                                 role="progressbar" aria-valuenow="<?= $pct ?>"
                                 aria-valuemin="0" aria-valuemax="100"
                                 aria-label="<?= e($q['label']) ?>">
                                <div class="h-full rounded-full <?= $pct >= 90 ? 'bg-bad'
                                                : ($pct >= 70 ? 'bg-warn' : 'bg-brand') ?>"
                                     style="width: <?= $pct ?>%"></div>
                            </div>
                        <?php endif; ?>
                    </div>
                <?php endforeach; ?>
            </div>

            <h3 class="mt-6 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                <?= e('set.features') ?>
            </h3>
            <ul class="mt-2 divide-y divide-edge rounded-control border border-edge">
                <?php foreach ($features as $f): ?>
                    <li class="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <span class="text-ink"><?= e($f['key']) ?></span>
                        <span class="flex items-center gap-1.5 font-mono text-[10px] uppercase
                                     tracking-[0.15em] <?= $f['on'] ? 'text-ok' : 'text-ink-subtle' ?>">
                            <?php if ($f['on']): ?>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                     stroke-linecap="round" stroke-linejoin="round"
                                     class="h-3.5 w-3.5" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>
                            <?php else: ?>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                     stroke-linecap="round" class="h-3.5 w-3.5" aria-hidden="true">
                                    <path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                            <?php endif; ?>
                            <?= $f['on'] ? e('set.on') : e('set.off') ?>
                        </span>
                    </li>
                <?php endforeach; ?>
            </ul>
        </div>
    </section>

</div>

<!--
    Everything below this line changes data that cannot be got back. It used to
    sit in the same card as the password field, which said the two were the same
    kind of act.
-->
<section class="am2-surface mt-4 rounded-card border-bad/40" data-reveal>
    <header class="flex items-center gap-2.5 border-b border-bad/30 bg-bad/5 px-5 py-3.5">
        <span class="text-bad"><?= am2_icon('alert', 'h-4 w-4') ?></span>
        <h2 class="font-mono text-[10px] uppercase tracking-[0.18em] text-bad">
            <?= e('set.danger') ?>
        </h2>
    </header>

    <div class="divide-y divide-edge">
        <div class="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
                <h3 class="text-sm font-semibold text-ink"><?= e('set.export') ?></h3>
                <p class="mt-1 text-xs text-ink-muted"><?= e('set.export_note') ?></p>
            </div>
            <!-- A native submit, deliberately: the response to this POST is the
                 dump itself, streamed by passthru(). Sending it through fetch()
                 would download the file into memory and never hand it over. -->
            <form method="POST" class="shrink-0">
                <?= am2_csrf_field() ?>
                <button type="submit" name="export_db" value="1"
                        class="h-11 w-full rounded-control border border-edge px-5 font-mono
                               text-[10px] font-semibold uppercase tracking-[0.15em] text-ink
                               transition-colors duration-[var(--duration-micro)]
                               hover:border-brand hover:text-brand focus:outline-none
                               focus-visible:ring-2 focus-visible:ring-brand/60 sm:w-auto">
                    <?= e('set.export_action') ?>
                </button>
            </form>
        </div>

        <?php if ($is_super): ?>
            <div class="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                    <h3 class="text-sm font-semibold text-ink"><?= e('set.restore') ?></h3>
                    <p class="mt-1 text-xs text-ink-muted"><?= e('set.restore_note') ?></p>
                    <p class="mt-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.restore_logged') ?>
                    </p>
                </div>
                <button type="button" data-hs-overlay="#am2-restore"
                        aria-haspopup="dialog" aria-expanded="false" aria-controls="am2-restore"
                        class="h-11 shrink-0 rounded-control border border-bad/50 px-5 font-mono
                               text-[10px] font-semibold uppercase tracking-[0.15em] text-bad
                               transition-colors duration-[var(--duration-micro)]
                               hover:bg-bad/10 focus:outline-none focus-visible:ring-2
                               focus-visible:ring-bad/60">
                    <?= e('set.restore_open') ?>
                </button>
            </div>
        <?php endif; ?>
    </div>
</section>

<?php if ($is_super): ?>
    <!--
        Restore, behind Preline's modal:
        https://preline.co/docs/modal.html
        Preline owns open, close, Escape and the focus trap. No transition on
        the container: Preline waits for one to end before it re-adds `hidden`,
        and a transition on a property that never changes never ends -- which is
        how an invisible overlay ended up swallowing every click on this app.

        The whole form lives in here so the file and the confirmation are one
        submission. name="import_db" and name="sql_file" are the contract.
    -->
    <div id="am2-restore" role="dialog" tabindex="-1" aria-labelledby="am2-restore-label"
         class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
                bg-slate-950/50 backdrop-blur-sm">
        <div data-am2-panel
             class="am2-surface mx-auto mt-[10vh] w-[92%] max-w-lg overflow-hidden rounded-card">
            <form method="POST" enctype="multipart/form-data" id="am2-restore-form">
                <?= am2_csrf_field() ?>

                <header class="flex items-start gap-3 border-b border-edge px-5 py-4">
                    <span class="mt-0.5 text-bad"><?= am2_icon('alert', 'h-5 w-5') ?></span>
                    <div class="min-w-0">
                        <h2 id="am2-restore-label" class="text-base font-semibold text-ink">
                            <?= e('set.restore_confirm_title') ?>
                        </h2>
                        <p class="mt-1 text-sm text-ink-muted"><?= e('set.restore_confirm_body') ?></p>
                    </div>
                </header>

                <div class="p-5">
                    <label for="am2-restore-file"
                           class="font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.restore_file') ?>
                    </label>
                    <input id="am2-restore-file" type="file" name="sql_file" accept=".sql" required
                           class="mt-2 w-full cursor-pointer rounded-control border border-edge bg-card
                                  text-sm text-ink-muted file:me-3 file:cursor-pointer file:border-0
                                  file:bg-card-muted file:px-4 file:py-3 file:font-mono
                                  file:text-[10px] file:uppercase file:tracking-[0.15em] file:text-ink
                                  hover:border-edge-strong focus:border-brand focus:outline-none
                                  focus:ring-2 focus:ring-brand/25">

                    <label for="am2-restore-word"
                           class="mt-5 block font-mono text-[10px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.restore_type', ['word' => t('set.restore_word')]) ?>
                    </label>
                    <!-- The word is an attribute, not a string in the script, so
                         the confirmation stays translated without i18n in JS. -->
                    <input id="am2-restore-word" type="text" autocomplete="off" spellcheck="false"
                           data-confirm-word="<?= htmlspecialchars(t('set.restore_word')) ?>"
                           class="mt-2 h-12 w-full rounded-control border border-edge bg-card px-3
                                  font-mono text-base uppercase tracking-[0.15em] text-ink
                                  transition-colors duration-[var(--duration-micro)]
                                  hover:border-edge-strong focus:border-bad focus:outline-none
                                  focus:ring-2 focus:ring-bad/25">
                </div>

                <footer class="flex flex-col-reverse gap-2 border-t border-edge px-5 py-4 sm:flex-row sm:justify-end">
                    <button type="button" data-hs-overlay="#am2-restore"
                            class="h-11 rounded-control border border-edge px-5 font-mono text-[10px]
                                   font-semibold uppercase tracking-[0.15em] text-ink-muted
                                   transition-colors duration-[var(--duration-micro)]
                                   hover:text-ink focus:outline-none focus-visible:ring-2
                                   focus-visible:ring-brand/60">
                        <?= e('set.cancel') ?>
                    </button>
                    <button type="submit" name="import_db" value="1" id="am2-restore-submit" disabled
                            class="h-11 rounded-control bg-bad px-5 font-mono text-[10px] font-semibold
                                   uppercase tracking-[0.15em] text-white transition-colors
                                   duration-[var(--duration-micro)] hover:bg-bad/90
                                   disabled:cursor-not-allowed disabled:opacity-40
                                   focus:outline-none focus-visible:ring-2 focus-visible:ring-bad/60">
                        <?= e('set.restore_submit') ?>
                    </button>
                </footer>
            </form>
        </div>
    </div>
<?php endif; ?>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    document.querySelectorAll('[data-stat]').forEach((el) => {
        window.AM2?.countTo(el, Number(el.textContent.replace(/[^\d]/g, '')));
    });
    window.AM2?.enterOnce('[data-kpi]');
    window.AM2?.revealOnScroll('[data-reveal]');

    // Restore stays locked until the operator writes the word out. confirm()
    // was one keystroke away from overwriting every tenant's data.
    const word = document.getElementById('am2-restore-word');
    const submit = document.getElementById('am2-restore-submit');
    if (word && submit) {
        const expected = word.dataset.confirmWord.toUpperCase();
        const check = () => { submit.disabled = word.value.trim().toUpperCase() !== expected; };
        word.addEventListener('input', check);
        // Reopening the dialog must not inherit the last attempt's state.
        document.getElementById('am2-restore')
                ?.addEventListener('close.hs.overlay', () => { word.value = ''; check(); });
        check();
    }
})();
</script>
</body>
</html>
