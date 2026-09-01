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

/** "2M" as a number of bytes. */
function am2_ini_bytes(string $value): int
{
    $value = trim($value);
    $n = (int) $value;
    return match (strtolower(substr($value, -1))) {
        'g' => $n * 1024 ** 3,
        'm' => $n * 1024 ** 2,
        'k' => $n * 1024,
        default => $n,
    };
}

/** Bytes as something a person reads. */
function am2_bytes_human(int $bytes): string
{
    if ($bytes >= 1024 ** 2) {
        return number_format($bytes / 1024 ** 2, 1) . ' MB';
    }
    if ($bytes >= 1024) {
        return number_format($bytes / 1024, 1) . ' KB';
    }
    return $bytes . ' B';
}

/**
 * Why an upload did not arrive.
 *
 * move_uploaded_file() failing was reported as "Gagal mengunggah file ke
 * server" whatever went wrong, including the case that actually happens: the
 * file was larger than PHP accepts and was never written at all.
 */
function am2_upload_error(array $file): string
{
    return match ($file['error'] ?? UPLOAD_ERR_NO_FILE) {
        UPLOAD_ERR_OK => '',
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'set.err_too_big',
        UPLOAD_ERR_PARTIAL => 'set.err_partial',
        UPLOAD_ERR_NO_FILE => 'set.err_no_file',
        UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE => 'set.err_server_store',
        default => 'set.err_upload',
    };
}

/**
 * What `update/` actually is on this host.
 *
 * The APK handler writes into a relative `update/` and creates it when it is
 * missing. In production that path is a symlink to shared storage; on staging
 * it did not exist, so an upload would have made a real directory inside the
 * deployed tree, where the next deploy erases it. Nothing said so on screen.
 */
function am2_update_state(): array
{
    $dir = __DIR__ . '/update';
    $state = [
        'exists'   => is_dir($dir),
        'symlink'  => is_link($dir),
        'writable' => is_dir($dir) && is_writable($dir),
        'files'    => [],
    ];
    foreach (glob($dir . '/*.apk') ?: [] as $f) {
        $state['files'][] = [
            'name' => basename($f),
            'size' => (int) filesize($f),
            'time' => (int) filemtime($f),
        ];
    }
    usort($state['files'], fn ($a, $b) => $b['time'] <=> $a['time']);

    // The version Admin Native is told about, read from the same file
    // api_settings.php?action=check_update serves.
    $state['version'] = null;
    $json = $dir . '/admin_version.json';
    if (is_file($json)) {
        $parsed = json_decode((string) file_get_contents($json), true);
        if (is_array($parsed)) {
            $state['version'] = $parsed;
        }
    }
    return $state;
}

/**
 * The other update channel: the radio app the units carry.
 *
 * There are two, and the panel only ever showed one. Admin Native reads
 * update/admin_version.json through api_settings.php?action=check_update; the
 * field app reads server/update/version.json directly. The two share nothing --
 * not the directory, not the metadata, not even the shape of it -- and the docs
 * say plainly not to merge them. So this reads the second one and shows it
 * beside the first, rather than leaving an operator to assume the panel covers
 * both.
 *
 * It used to read public.app_versions instead, on the belief that the relay
 * answered from the table and the file beside the APK was "only a deployment
 * note". That was backwards. AboutActivity fetches UPDATE_MANIFEST_URL, which
 * is this file; nothing in the client calls the relay endpoint, and across
 * every retained access log it has been asked for zero times while this file
 * has been fetched by real handsets.
 *
 * So the table was never the channel -- it was a second, hand-written copy that
 * only this card read, which is why this card was the only thing that lied. It
 * showed build 3 while build 124 was published and being downloaded. Reading
 * what the handset reads is the only arrangement in which the two cannot
 * disagree.
 */
function am2_field_channel(): array
{
    $dir = dirname(__DIR__) . '/server/update';
    $out = [
        'version' => null, 'build' => null, 'changelog' => '', 'url' => '',
        'files' => [], 'readable' => is_dir($dir),
    ];

    foreach (glob($dir . '/*.apk') ?: [] as $f) {
        $out['files'][] = [
            'name' => basename($f),
            'size' => (int) filesize($f),
            'time' => (int) filemtime($f),
        ];
    }
    usort($out['files'], fn ($a, $b) => $b['time'] <=> $a['time']);

    /*
     * What the relay would actually advertise, asked rather than recomputed.
     *
     * This card read version.json for itself and reported whatever it found --
     * on production, "1.0.0, build 1", for a manifest written in May naming an
     * APK that has never been in the directory. The relay refuses that set, so
     * no handset would ever be offered it, and the card announced it anyway.
     *
     * That is precisely the disagreement the admin card had with its own
     * endpoint. The rule lives in the relay because that is where a handset's
     * answer comes from; this shows the decision instead of forming a second
     * opinion about the same file. Null means the relay could not be reached,
     * which is a channel whose state is genuinely unknown.
     */
    // With the locale. The relay resolves release notes per language and
    // defaults to Indonesian, so asking without one renders Indonesian notes on
    // an English page -- the exact leak this channel was cleaned up for,
    // reintroduced by the fix for a different one. Latent while every published
    // manifest holds a plain string, which reads the same in every language.
    $advertised = am2_node_get('/api/check-update?lang=' . urlencode(am2_locale()));
    if (!is_array($advertised) || ($advertised['success'] ?? false) !== true) {
        return $out;
    }

    $out['version'] = ($advertised['server_version_name'] ?? '') !== ''
        ? (string) $advertised['server_version_name'] : null;
    $out['build'] = isset($advertised['server_version_code'])
        ? (int) $advertised['server_version_code'] : null;
    $out['changelog'] = $advertised['release_notes'] ?? '';
    $out['url'] = (string) ($advertised['update_url'] ?? '');

    return $out;
}

$upload_limit = min(
    am2_ini_bytes((string) ini_get('upload_max_filesize')),
    am2_ini_bytes((string) ini_get('post_max_size'))
);

// A body over post_max_size is discarded whole: $_POST and $_FILES arrive
// empty, so am2_csrf_require() finds no token and answers "Sesi tidak valid"
// -- which is what an operator uploading a 24 MB APK actually saw. The guard
// runs in config.php and exits before this file, so the only thing that can be
// done here is refuse the file before it is ever sent. See the page script.

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

/**
 * A branch admin's own rows, as INSERT statements.
 *
 * pg_dump has no WHERE, so `-t public.users -t public.channels` handed a branch
 * admin every branch's rows -- the whole table, under a filename that said it
 * was theirs. Two tables bounded by the account's quota are small enough to
 * build here, which also takes a shell call and a PGPASSWORD out of this page.
 *
 * $table and $where are literals from the two call sites below; only the
 * parameters come from the request, and the values are quoted by PDO.
 */
function am2_export_rows(PDO $pdo, string $table, string $where, array $args): string
{
    $stmt = $pdo->prepare("SELECT * FROM {$table} WHERE {$where} ORDER BY 1");
    $stmt->execute($args);

    $sql = '';
    foreach ($stmt as $row) {
        $cols = implode(', ', array_map(fn ($c) => '"' . $c . '"', array_keys($row)));
        $vals = implode(', ', array_map(function ($v) use ($pdo) {
            if ($v === null) {
                return 'NULL';
            }
            if (is_bool($v)) {
                return $v ? 'TRUE' : 'FALSE';
            }
            return $pdo->quote((string) $v);
        }, $row));
        $sql .= "INSERT INTO {$table} ({$cols}) VALUES ({$vals});\n";
    }
    return $sql;
}

if (isset($_POST['export_db'])) {
    $timestamp = date('Ymd_His');
    $filename  = ($is_super ? 'FULL_BACKUP_' : 'BACKUP_' . strtoupper($admin_user) . '_')
               . $timestamp . '.sql';

    header('Content-Type: application/octet-stream');
    header('Content-disposition: attachment; filename="' . $filename . '"');

    if ($is_super) {
        putenv('PGPASSWORD=' . $password);
        // -p was missing here and present in api_settings.php, so this dumped
        // whatever cluster happened to answer on the default port.
        passthru('pg_dump -h ' . $host . ' -p ' . $port . ' -U ' . $user
               . ' -d ' . $dbname . ' -n public');
        exit;
    }

    echo "-- AM2 backup\n";
    echo '-- ' . $admin_user . ' · ' . date('Y-m-d H:i:s') . "\n";
    echo "-- The rows belonging to this account, and no others.\n\n";
    echo am2_export_rows($pdo, 'public.channels', 'created_by = ?', [$admin_id]);
    echo am2_export_rows($pdo, 'public.users', 'admin_id = ?', [$admin_id]);
    exit;
}

if (isset($_POST['import_db']) && isset($_FILES['sql_file'])) {
    if (am2_page_require_super($is_super, 'import-db')) {
        $error = t('set.err_denied');
    } elseif (($why = am2_upload_error($_FILES['sql_file'])) !== '') {
        $error = t($why, ['limit' => am2_bytes_human($upload_limit)]);
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
     'quota' => $is_super ? null : ($settings['user_quota'] ?? null),    'icon' => 'users',
     'at_limit' => 'set.quota_users_full'],
    ['label' => 'set.quota_channels', 'used' => (int) $total_channels,
     'quota' => $is_super ? null : ($settings['channel_quota'] ?? null), 'icon' => 'radio',
     'at_limit' => 'set.quota_channels_full'],
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

$shelf = $is_super ? am2_update_state() : ['exists' => false, 'files' => [], 'version' => null];

// The file Admin Native is told to fetch, and whether it is actually there.
$shelf_target = '';
$shelf_present = true;
// `update_url` is the published field; `download_url` was its name before the
// manifest carried a digest and a signer, and manifests in that older shape
// are still on disk. Read both so the shelf keeps rendering during the change
// -- api_settings.php validates the set separately and will not advertise an
// old one, which is the decision that actually matters.
$shelf_url = (string) ($shelf['version']['update_url'] ?? $shelf['version']['download_url'] ?? '');
if ($shelf_url !== '') {
    $shelf_target = basename((string) parse_url($shelf_url, PHP_URL_PATH));
    $shelf_present = in_array($shelf_target, array_column($shelf['files'], 'name'), true);
}

/** The file a channel points at, and whether it is actually there. */
function am2_channel_target(string $url, array $files): array
{
    if ($url === '') {
        return ['', true];
    }
    $name = basename((string) parse_url($url, PHP_URL_PATH));
    return [$name, in_array($name, array_column($files, 'name'), true)];
}

$channels = [];
if ($is_super) {
    $field = am2_field_channel();
    [$field_target, $field_present] = am2_channel_target($field['url'], $field['files']);

    /*
     * The same verdict api_settings.php reaches, from the same function.
     *
     * This card used to read admin_version.json itself and print whatever
     * version_name was in it. The endpoint validated the set and refused it, so
     * the panel announced a version no handset could ever be offered, and the
     * number on screen was the reason to believe the channel worked.
     *
     * When it is refused there is no version, which also takes away the QR code
     * and the download URL: an operator should not be invited to install a set
     * the server will not advertise.
     */
    $advertisement = am2_admin_update_advertisement(
        __DIR__ . '/update',
        AM2_ADMIN_UPDATE_BASE,
        AM2_ADMIN_UPDATE_PACKAGE,
        AM2_ADMIN_UPDATE_DENIED_SIGNERS
    );
    $shelf_valid = $advertisement['valid'] === true;

    $channels[] = [
        'label'     => t('set.channel_admin'),
        'note'      => t('set.channel_admin_note'),
        'version'   => $shelf_valid ? ($advertisement['advertised']['version_name'] ?? null) : null,
        'build'     => $shelf_valid ? ($advertisement['advertised']['version_code'] ?? null) : null,
        'changelog' => $shelf_valid ? am2_release_notes($advertisement['changelog']) : '',
        'url'       => $shelf_valid ? $shelf_url : '',
        'files'     => $shelf['files'],
        'target'    => $shelf_target,
        'present'   => $shelf_present,
        // The reason, not a generic emptiness. The reader here is a signed-in
        // superadmin; the public endpoint still says only "no update".
        'empty'     => $shelf_valid
            ? t('set.no_version')
            : t('set.not_advertised', ['reason' => $advertisement['reason']]),
        'managed'   => true,
    ];
    $channels[] = [
        'label'     => t('set.channel_field'),
        'note'      => t('set.channel_field_note'),
        'version'   => $field['version'],
        'build'     => $field['build'],
        'changelog' => am2_release_notes($field['changelog']),
        'url'       => $field['url'],
        'files'     => $field['files'],
        'target'    => $field_target,
        'present'   => $field_present,
        'empty'     => t('set.no_version_field'),
        'managed'   => false,
    ];
}

$pageTitle = t('set.heading');
$pageLede  = t('set.lede');
$pageActions = '<span class="hidden rounded-control border border-edge px-2.5 py-1.5 font-mono'
    . ' text-[11px] uppercase tracking-[0.15em] lg:inline-block '
    . ($is_super ? 'border-bad/40 text-bad' : 'text-ink-muted') . '">'
    . htmlspecialchars(strtoupper($role_user)) . '</span>';

// The command palette can reach the sections of this page, which is the
// fuzzy-search affordance the shell already owns rather than a second one.
$pageCommands = array_values(array_filter([
    ['id' => 's-account', 'group' => t('set.heading'), 'label' => t('set.account'),    'target' => '#am2-card-account'],
    ['id' => 's-quota',   'group' => t('set.heading'), 'label' => t('set.licence'),    'target' => '#am2-card-licence'],
    $is_super ? ['id' => 's-apk', 'group' => t('set.heading'), 'label' => t('set.distribution'), 'target' => '#am2-card-shelf'] : null,
    ['id' => 's-export',  'group' => t('set.heading'), 'label' => t('set.export'),     'target' => '#am2-card-danger'],
    $is_super ? ['id' => 's-restore', 'group' => t('set.heading'), 'label' => t('set.restore'), 'target' => '#am2-card-danger'] : null,
]));

include 'partials/head.php';
include 'partials/shell.php';
?>

<!--
    Always rendered, empty or not: the upload swaps this node in from the
    response rather than reloading the page, so it needs somewhere to land.
-->
<div id="am2-page-alert">
    <?php if ($msg !== '' || $error !== ''): ?>
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
</div>

<!--
    Scope of the account, as three counts. Each one is a link, because each one
    is a page in this panel; the arrow is the same affordance the dashboard
    cards carry.
-->
<section class="grid gap-4 sm:grid-cols-2 <?= $is_super ? 'md:grid-cols-3' : '' ?>">
    <?php foreach ($stats as $s): ?>
        <a href="<?= $s['href'] ?>" data-kpi
           class="am2-surface am2-surface-accent am2-clickable group flex flex-col rounded-card p-5
                  no-underline! text-ink!">
            <p class="flex items-center justify-between font-mono text-[11px] uppercase
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
        <section id="am2-card-account" class="am2-surface rounded-card scroll-mt-28">
            <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
                <span class="text-ink-subtle"><?= am2_icon('lock', 'h-4 w-4') ?></span>
                <h2 class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                    <?= e('set.account') ?>
                </h2>
            </header>

            <div class="p-5">
                <p class="flex items-baseline justify-between gap-3 border-b border-edge pb-4">
                    <span class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.username') ?>
                    </span>
                    <span class="truncate font-mono text-sm text-ink">
                        <?= htmlspecialchars($settings['username']) ?>
                    </span>
                </p>

                <!-- method and field names are the contract: the handler above reads
                     $_POST['update_password'], ['new_password'] and ['confirm_password']. -->
                <form method="POST" class="mt-4" id="am2-password-form">
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
                                   class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
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

                    <!--
                        The rules, checked as they are met. The server said
                        "minimal 8 karakter" only after a round trip, and said
                        nothing at all about the two fields matching until the
                        password had already been submitted.
                    -->
                    <ul id="am2-pw-rules" class="mb-4 space-y-1.5" aria-live="polite">
                        <li data-rule="length" class="flex items-center gap-2 text-xs text-ink-subtle">
                            <span data-mark aria-hidden="true"
                                  class="grid h-4 w-4 shrink-0 place-items-center rounded-full
                                         border border-edge-strong text-[11px]">·</span>
                            <span><?= e('set.rule_length') ?></span>
                        </li>
                        <li data-rule="match" class="flex items-center gap-2 text-xs text-ink-subtle">
                            <span data-mark aria-hidden="true"
                                  class="grid h-4 w-4 shrink-0 place-items-center rounded-full
                                         border border-edge-strong text-[11px]">·</span>
                            <span><?= e('set.rule_match') ?></span>
                        </li>
                    </ul>

                    <p id="am2-pw-caps" hidden
                       class="mb-3 flex items-center gap-2 rounded-control border border-warn/40
                              bg-warn/5 px-3 py-2 text-xs text-warn">
                        <?= am2_icon('alert', 'h-3.5 w-3.5') ?><?= e('set.caps_lock') ?>
                    </p>

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

    </div>

    <!-- Licence and quota. -->
    <section id="am2-card-licence" class="am2-surface rounded-card scroll-mt-28">
        <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
            <span class="text-ink-subtle"><?= am2_icon('shield', 'h-4 w-4') ?></span>
            <h2 class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('set.licence') ?>
            </h2>
        </header>

        <div class="p-5">
            <div class="am2-surface-accent rounded-control border border-edge bg-card-muted px-4 py-3">
                <p class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                    <?= e('set.valid_until') ?>
                </p>
                <p class="mt-1 text-lg font-semibold text-ink">
                    <?= ($settings['expired_at'] && $settings['expired_at'] !== 'infinity')
                        ? htmlspecialchars(date('d F Y', strtotime($settings['expired_at'])))
                        : e('set.lifetime') ?>
                </p>
            </div>

            <!-- Usage against the ceiling, not two numbers side by side. The old
                 card printed "100" next to "sisa UNLIMITED", and neither number
                 said what happens when the ceiling is reached. -->
            <div class="mt-5 space-y-4">
                <?php foreach ($quotas as $q): $pct = am2_quota_pct($q['used'], $q['quota']); ?>
                    <div>
                        <p class="flex items-center justify-between gap-3">
                            <span class="flex items-center gap-2 font-mono text-[11px] uppercase
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
                            <?php
                            // Written out in full: Tailwind reads this file as
                            // text, so a class name assembled from a variable
                            // ships with no rule behind it.
                            $bar = $pct >= 90 ? 'bg-bad' : ($pct >= 70 ? 'bg-warn' : 'bg-brand');
                            $left = max(0, (int) $q['quota'] - (int) $q['used']);
                            ?>
                            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-card-muted"
                                 role="progressbar" aria-valuenow="<?= $pct ?>"
                                 aria-valuemin="0" aria-valuemax="100"
                                 aria-label="<?= e($q['label']) ?>">
                                <div class="h-full rounded-full <?= $bar ?>"
                                     style="width: <?= $pct ?>%"></div>
                            </div>
                            <p class="mt-1.5 text-xs <?= $pct >= 90 ? 'text-bad' : 'text-ink-muted' ?>">
                                <?= $left === 0
                                    ? e($q['at_limit'])
                                    : e('set.quota_left', ['n' => number_format($left)]) ?>
                            </p>
                        <?php endif; ?>
                    </div>
                <?php endforeach; ?>
            </div>

            <h3 class="mt-6 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                <?= e('set.features') ?>
            </h3>
            <ul class="mt-2 divide-y divide-edge rounded-control border border-edge">
                <?php foreach ($features as $f): ?>
                    <li class="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <span class="text-ink"><?= e($f['key']) ?></span>
                        <span class="flex items-center gap-1.5 font-mono text-[11px] uppercase
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

<?php if ($is_super): ?>
    <section id="am2-card-shelf" class="am2-surface mt-4 rounded-card scroll-mt-28" data-reveal>
        <header class="flex items-center gap-2.5 border-b border-edge px-5 py-3.5">
            <span class="text-ink-subtle"><?= am2_icon('inbox', 'h-4 w-4') ?></span>
            <h2 class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('set.distribution') ?>
            </h2>
        </header>

        <div id="am2-shelf-version" class="grid gap-5 border-b border-edge p-5 lg:grid-cols-2">
            <?php foreach ($channels as $ch): ?>
                <!--
                    min-w-0, because a grid item's automatic minimum size is its
                    min-content width, and the URL row below is a flex line whose
                    min-content is the whole URL. Without this the card sizes
                    itself to that URL and grows wider than the column it sits
                    in -- 451px inside a 406px column, measured at a 480px
                    viewport -- which is what pushed its contents over the card
                    edge. With it the code element truncates, as it was written
                    to.
                -->
                <section class="min-w-0 rounded-control border border-edge p-4">
                    <header class="flex items-baseline justify-between gap-3">
                        <h3 class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink">
                            <?= htmlspecialchars($ch['label']) ?>
                        </h3>
                        <?php if (!$ch['managed']): ?>
                            <span class="shrink-0 rounded-control border border-edge px-1.5 font-mono
                                         text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                                <?= e('set.channel_readonly') ?>
                            </span>
                        <?php endif; ?>
                    </header>
                    <p class="mt-1 text-xs text-ink-muted"><?= htmlspecialchars($ch['note']) ?></p>

                    <?php if ($ch['version'] !== null && $ch['version'] !== ''): ?>
                        <!--
                            Version beside the code, until there is no room for
                            beside. The QR is a fixed 104px square that cannot
                            shrink, and the version name is one unbreakable
                            token -- "1.2.0-staging+240.g783e817" is 26
                            characters of 24px mono. Under about 485px those two
                            demands add up to more than the card is wide, and
                            the text ran under the code. Below that width they
                            stack, and the token is allowed to break so it wraps
                            instead of overflowing.
                        -->
                        <div class="mt-4 flex flex-col gap-4
                                    min-[485px]:flex-row min-[485px]:items-start">
                            <div class="min-w-0 flex-1">
                                <p class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                                    <?= e('set.current_version') ?>
                                </p>
                                <p class="mt-1 break-all font-mono text-xl font-semibold leading-tight
                                          text-ink min-[485px]:text-2xl min-[485px]:leading-none">
                                    <?= htmlspecialchars((string) $ch['version']) ?>
                                </p>
                                <?php if ($ch['build'] !== null): ?>
                                    <!--
                                        The build, beside the name and not instead of it.

                                        version_name is written by a human and stays put for a
                                        release or ten, so two different APKs render identically.
                                        version_code is the CI run number and is the only thing
                                        either end compares when deciding an update exists -- it is
                                        what actually identifies what a handset is carrying.
                                    -->
                                    <p class="mt-1 font-mono text-[11px] uppercase tracking-[0.15em]
                                              text-ink-subtle">
                                        <?= e('set.build', ['code' => (string) $ch['build']]) ?>
                                    </p>
                                <?php endif; ?>
                                <?php if ($ch['changelog'] !== ''): ?>
                                    <p class="mt-2 text-xs text-ink-muted">
                                        <?= htmlspecialchars($ch['changelog']) ?>
                                    </p>
                                <?php endif; ?>
                            </div>

                            <?php if ($ch['url'] !== ''): ?>
                                <!-- The code is drawn client-side, and clicking it
                                     opens the same code large enough to scan from
                                     across a room. -->
                                <figure class="shrink-0 text-center">
                                    <button type="button" data-hs-overlay="#am2-qr-zoom"
                                            data-qr="<?= htmlspecialchars($ch['url']) ?>"
                                            data-qr-label="<?= htmlspecialchars($ch['label']) ?>"
                                            aria-haspopup="dialog"
                                            aria-label="<?= e('set.zoom_qr') ?>" title="<?= e('set.zoom_qr') ?>"
                                            class="grid h-[104px] w-[104px] place-items-center rounded-control
                                                   border border-edge bg-white p-1.5 text-slate-950
                                                   transition-colors duration-[var(--duration-micro)]
                                                   hover:border-brand focus:outline-none
                                                   focus-visible:ring-2 focus-visible:ring-brand/60"></button>
                                    <figcaption class="mt-1.5 font-mono text-[11px] uppercase
                                                       tracking-[0.15em] text-ink-subtle">
                                        <?= e('set.scan_to_install') ?>
                                    </figcaption>
                                </figure>
                            <?php endif; ?>
                        </div>

                        <?php if ($ch['url'] !== ''): ?>
                            <div class="mt-3 flex items-center gap-2">
                                <code class="min-w-0 flex-1 truncate rounded-control border border-edge
                                             bg-card-muted px-2.5 py-2 font-mono text-[11px] text-ink-muted"
                                      data-url="<?= htmlspecialchars($ch['url']) ?>">
                                    <?= htmlspecialchars($ch['url']) ?>
                                </code>
                                <button type="button" data-copy-url="<?= htmlspecialchars($ch['url']) ?>"
                                        class="grid h-11 w-11 shrink-0 place-items-center rounded-control
                                               border border-edge text-ink-subtle transition-colors
                                               duration-[var(--duration-micro)] hover:border-brand
                                               hover:text-brand focus:outline-none focus-visible:ring-2
                                               focus-visible:ring-brand/60"
                                        aria-label="<?= e('set.copy_url') ?>" title="<?= e('set.copy_url') ?>">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
                                         stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"
                                         aria-hidden="true">
                                        <rect x="9" y="9" width="12" height="12" rx="2"/>
                                        <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
                                    </svg>
                                </button>
                            </div>
                        <?php endif; ?>

                        <?php if ($ch['target'] !== '' && !$ch['present']): ?>
                            <p class="mt-3 flex items-start gap-2 rounded-control border border-warn/40
                                      bg-warn/5 px-3 py-2.5 text-xs text-warn">
                                <?= am2_icon('alert', 'h-4 w-4') ?>
                                <span><?= e('set.version_missing', ['file' => $ch['target']]) ?></span>
                            </p>
                        <?php endif; ?>
                    <?php else: ?>
                        <p class="mt-4 flex items-start gap-2 rounded-control border border-warn/40
                                  bg-warn/5 px-3 py-2.5 text-xs text-warn">
                            <?= am2_icon('alert', 'h-4 w-4') ?>
                            <span><?= htmlspecialchars($ch['empty']) ?></span>
                        </p>
                    <?php endif; ?>

                    <?php if (!$ch['managed']): ?>
                        <p class="mt-3 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                            <?= $ch['files']
                                ? e('set.shelf_count', ['n' => count($ch['files'])])
                                : e('set.shelf_empty') ?>
                        </p>
                    <?php endif; ?>
                </section>
            <?php endforeach; ?>

            <?php if (!$shelf['exists']): ?>
                <p class="flex items-start gap-2 rounded-control border border-bad/40
                          bg-bad/5 px-3 py-2.5 text-xs text-bad lg:col-span-2">
                    <?= am2_icon('alert', 'h-4 w-4') ?>
                    <span><?= e('set.folder_missing') ?></span>
                </p>
            <?php endif; ?>
        </div>

        <div class="grid gap-5 p-5 lg:grid-cols-2">
            <!--
                Releases are published by the release pipeline from bytes
                signed on an isolated runner, so the panel has no part in
                putting a file on the shelf. It shows what is published.
            -->
            <div class="min-w-0 self-start rounded-control border border-edge px-4 py-3">
                <p class="text-sm text-ink-muted"><?= e('set.publish_via_release') ?></p>
            </div>

            <div id="am2-shelf-list" class="min-w-0 self-start rounded-control border border-edge">
            <p class="px-4 pt-3 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                <?= e('set.on_shelf') ?>
            </p>
            <?php if (!$shelf['files']): ?>
                <p class="px-4 pb-3 pt-2 text-sm text-ink-muted"><?= e('set.shelf_empty') ?></p>
            <?php else: ?>
                <ul class="mt-1 divide-y divide-edge">
                    <?php foreach ($shelf['files'] as $f): ?>
                        <li class="flex flex-col gap-1 px-4 py-2.5
                                   min-[485px]:flex-row min-[485px]:items-center
                                   min-[485px]:justify-between min-[485px]:gap-3">
                            <span class="flex min-w-0 items-center gap-2">
                                <span class="truncate font-mono text-sm text-ink">
                                    <?= htmlspecialchars($f['name']) ?>
                                </span>
                                <?php if ($f['name'] === $shelf_target): ?>
                                    <span class="shrink-0 rounded-control bg-ok/10 px-1.5 font-mono
                                                 text-[11px] uppercase tracking-[0.1em] text-ok">
                                        <?= e('set.served') ?>
                                    </span>
                                <?php endif; ?>
                            </span>
                            <span class="shrink-0 font-mono text-[11px] text-ink-subtle">
                                <?= am2_bytes_human($f['size']) ?> ·
                                <?= date('d M Y', $f['time']) ?>
                            </span>
                        </li>
                    <?php endforeach; ?>
                </ul>
            <?php endif; ?>
            </div>
        </div>
    </section>
<?php endif; ?>

<!--
    Everything below this line changes data that cannot be got back. It used to
    sit in the same card as the password field, which said the two were the same
    kind of act.
-->
<section id="am2-card-danger" class="am2-surface mt-4 rounded-card border-bad/40 scroll-mt-28" data-reveal>
    <header class="flex items-center gap-2.5 border-b border-bad/30 bg-bad/5 px-5 py-3.5">
        <span class="text-bad"><?= am2_icon('alert', 'h-4 w-4') ?></span>
        <h2 class="font-mono text-[11px] uppercase tracking-[0.18em] text-bad">
            <?= e('set.danger') ?>
        </h2>
    </header>

    <div class="divide-y divide-edge">
        <div class="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
                <h3 class="text-sm font-semibold text-ink"><?= e('set.export') ?></h3>
                <p class="mt-1 text-xs text-ink-muted"><?= e('set.export_note') ?></p>
                <!-- What the file will hold, before it is asked for. -->
                <p class="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                    <?= $is_super
                        ? e('set.export_full_note')
                        : e('set.export_contents', [
                            'devices'  => number_format((int) $total_users),
                            'channels' => number_format((int) $total_channels),
                          ]) ?>
                </p>
            </div>
            <!-- A native submit, deliberately: the response to this POST is the
                 dump itself, streamed by passthru(). Sending it through fetch()
                 would download the file into memory and never hand it over. -->
            <form method="POST" class="shrink-0">
                <?= am2_csrf_field() ?>
                <button type="submit" name="export_db" value="1"
                        class="h-11 w-full rounded-control border border-edge px-5 font-mono
                               text-[11px] font-semibold uppercase tracking-[0.15em] text-ink
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
                    <p class="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.restore_logged') ?>
                    </p>
                </div>
                <button type="button" data-hs-overlay="#am2-restore"
                        aria-haspopup="dialog" aria-expanded="false" aria-controls="am2-restore"
                        class="h-11 shrink-0 rounded-control border border-bad/50 px-5 font-mono
                               text-[11px] font-semibold uppercase tracking-[0.15em] text-bad
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
        and a transition on a property that doesn't change never ends -- which
        is how an invisible overlay ended up swallowing every click on this app.

        The whole form lives in here so the file and the confirmation are one
        submission. name="import_db" and name="sql_file" are the contract.
    -->
    <div id="am2-restore" role="dialog" tabindex="-1" aria-labelledby="am2-restore-label"
         class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
                bg-slate-950/50 backdrop-blur-sm">
        <div data-am2-panel
             class="am2-surface mx-auto my-[6vh] w-[92%] max-w-lg overflow-hidden rounded-card">
            <form method="POST" enctype="multipart/form-data" id="am2-restore-form"
                  data-devices="<?= (int) $total_users ?>" data-channels="<?= (int) $total_channels ?>"
                  data-limit="<?= $upload_limit ?>">
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
                    <!-- Take a backup first. The one thing that makes this
                         reversible, one click away, in the place it is needed. -->
                    <p class="mb-4 flex items-center gap-2 rounded-control border border-edge
                              bg-card-muted px-3 py-2.5 text-xs text-ink-muted">
                        <?= am2_icon('shield', 'h-4 w-4') ?>
                        <span><?= e('set.backup_first') ?></span>
                    </p>

                    <label for="am2-restore-file"
                           class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                        <?= e('set.restore_file') ?>
                    </label>
                    <div id="am2-sql-zone" data-input="am2-restore-file"
                         class="mt-2 rounded-control border-2 border-dashed border-edge-strong
                                bg-card-muted/40 px-4 py-5 text-center transition-colors
                                duration-[var(--duration-micro)]">
                        <p class="text-sm text-ink-muted"><?= e('set.drop_sql') ?></p>
                        <input id="am2-restore-file" type="file" name="sql_file" accept=".sql" required
                               class="mx-auto mt-3 block w-full max-w-xs cursor-pointer rounded-control
                                      border border-edge bg-card text-sm text-ink-muted
                                      file:me-3 file:cursor-pointer file:border-0 file:bg-card-muted
                                      file:px-4 file:py-3 file:font-mono file:text-[11px]
                                      file:uppercase file:tracking-[0.15em] file:text-ink
                                      hover:border-edge-strong focus:border-brand focus:outline-none
                                      focus:ring-2 focus:ring-brand/25">
                    </div>

                    <!--
                        Preflight. The file is read in the browser before anything
                        is sent, so the operator sees what is about to replace
                        what. Nothing here reaches the server.
                    -->
                    <div id="am2-sql-preflight" hidden class="mt-3 rounded-control border border-edge
                                bg-card-muted px-3 py-3" aria-live="polite">
                        <p class="flex items-baseline justify-between gap-3 text-sm">
                            <span data-sql-name class="min-w-0 truncate font-mono text-ink"></span>
                            <span data-sql-size class="shrink-0 font-mono text-xs text-ink-muted"></span>
                        </p>
                        <p data-sql-kind class="mt-1 font-mono text-[11px] uppercase
                                  tracking-[0.15em] text-ink-subtle"></p>

                        <table class="mt-3 w-full text-sm">
                            <thead>
                                <tr class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
                                    <th class="pb-1 text-left font-normal"></th>
                                    <th class="pb-1 text-right font-normal"><?= e('set.now') ?></th>
                                    <th class="pb-1 text-right font-normal"><?= e('set.in_file') ?></th>
                                </tr>
                            </thead>
                            <tbody class="font-mono tabular-nums">
                                <tr>
                                    <td class="py-0.5 text-ink-muted"><?= e('set.quota_users') ?></td>
                                    <td class="py-0.5 text-right text-ink" data-now-devices></td>
                                    <td class="py-0.5 text-right text-ink" data-file-devices></td>
                                </tr>
                                <tr>
                                    <td class="py-0.5 text-ink-muted"><?= e('set.quota_channels') ?></td>
                                    <td class="py-0.5 text-right text-ink" data-now-channels></td>
                                    <td class="py-0.5 text-right text-ink" data-file-channels></td>
                                </tr>
                            </tbody>
                        </table>

                        <p data-sql-warn hidden
                           class="mt-3 flex items-start gap-2 rounded-control border border-warn/40
                                  bg-warn/5 px-2.5 py-2 text-xs text-warn"></p>
                    </div>

                    <label for="am2-restore-word"
                           class="mt-5 block font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle">
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
                            class="h-11 rounded-control border border-edge px-5 font-mono text-[11px]
                                   font-semibold uppercase tracking-[0.15em] text-ink-muted
                                   transition-colors duration-[var(--duration-micro)]
                                   hover:text-ink focus:outline-none focus-visible:ring-2
                                   focus-visible:ring-brand/60">
                        <?= e('set.cancel') ?>
                    </button>
                    <button type="submit" name="import_db" value="1" id="am2-restore-submit" disabled
                            class="h-11 rounded-control bg-bad px-5 font-mono text-[11px] font-semibold
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

<?php if ($is_super): ?>
    <!--
        The code, large. A 104px square is enough to prove it is there and not
        enough to scan across a control room, which is exactly when it is used.
    -->
    <div id="am2-qr-zoom" role="dialog" tabindex="-1" aria-labelledby="am2-qr-zoom-label"
         class="hs-overlay fixed inset-0 z-80 hidden size-full overflow-y-auto
                bg-slate-950/60 backdrop-blur-sm">
        <div data-am2-panel
             class="am2-surface mx-auto mt-[8vh] w-[92%] max-w-sm overflow-hidden rounded-card p-6 text-center">
            <h2 id="am2-qr-zoom-label" class="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                <?= e('set.scan_to_install') ?>
            </h2>
            <p data-qr-zoom-label class="mt-1 text-sm font-semibold text-ink"></p>
            <div data-qr-zoom class="mx-auto mt-4 grid h-[288px] w-[288px] place-items-center
                        rounded-control border border-edge bg-white p-3 text-slate-950"></div>
            <code data-qr-zoom-url
                  class="mt-4 block truncate rounded-control border border-edge bg-card-muted
                         px-2.5 py-2 font-mono text-[11px] text-ink-muted"></code>
            <button type="button" data-hs-overlay="#am2-qr-zoom"
                    class="mt-4 h-11 w-full rounded-control border border-edge font-mono text-[11px]
                           font-semibold uppercase tracking-[0.15em] text-ink-muted transition-colors
                           duration-[var(--duration-micro)] hover:text-ink focus:outline-none
                           focus-visible:ring-2 focus-visible:ring-brand/60">
                <?= e('set.close') ?>
            </button>
        </div>
    </div>
<?php endif; ?>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const T = <?= json_encode([
        'copied'     => t('set.copied'),
        'too_big'    => t('set.err_too_big', ['limit' => am2_bytes_human($upload_limit)]),
        'kind_am2'   => t('set.kind_am2'),
        'kind_dump'  => t('set.kind_dump'),
        'kind_other' => t('set.kind_other'),
        'no_drop'    => t('set.warn_no_drop'),
        'partial'    => t('set.warn_partial_read'),
        'not_sql'    => t('set.err_sql_type'),
    ], JSON_UNESCAPED_UNICODE) ?>;

    const bytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
                       : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

    /*
     * The bundle is deferred, and a deferred script runs after the document is
     * parsed -- which is after this inline block. Calling window.AM2 here found
     * nothing, silently, because every call site guards with `?.`: the page
     * looked correct and simply had no motion and no QR. Deferred scripts do
     * run before DOMContentLoaded, so that event is the earliest safe moment.
     */
    const ready = (fn) => (window.AM2
        ? fn()
        : window.addEventListener('DOMContentLoaded', fn, { once: true }));

    ready(() => {
        document.querySelectorAll('[data-stat]').forEach((el) => {
            window.AM2.countTo(el, Number(el.textContent.replace(/[^\d]/g, '')));
        });
        window.AM2.enterOnce('[data-kpi]');
        window.AM2.revealOnScroll('[data-reveal]');

        // One per channel, and each one opens itself larger on click.
        document.querySelectorAll('[data-qr]').forEach((btn) => {
            btn.appendChild(window.AM2.qr(btn.dataset.qr, 92));
        });
    });

    /* ---- Drop zones ---------------------------------------------------
     * The <input type="file"> is never replaced: it is what a keyboard and a
     * screen reader operate, and the only path where drag events do not exist.
     * The zone is a second way in for a pointer, and it delegates to the input
     * so there is one source of truth for the chosen file.
     */
    function dropzone(zoneId, onFile) {
        const zone = $(zoneId);
        if (!zone) return;
        const input = $(zone.dataset.input);
        if (!input) return;

        const lit = ['border-brand', 'bg-brand/5'];
        const off = () => zone.classList.remove(...lit);

        ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
            e.preventDefault();
            zone.classList.add(...lit);
        }));
        ['dragleave', 'dragend'].forEach((ev) => zone.addEventListener(ev, off));

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            off();
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;
            // Hand it to the input, so the form submits it and the input shows
            // it -- the drop is an alternative gesture, not a parallel state.
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        input.addEventListener('change', () => onFile(input.files[0] || null));
    }

    /* ---- Release shelf ------------------------------------------------ */
    document.querySelectorAll('[data-copy-url]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(btn.dataset.copyUrl);
                window.AM2?.toast(T.copied);
            } catch {
                // Clipboard needs a secure context and permission; selecting
                // the text is the fallback that always works.
                const code = btn.previousElementSibling;
                if (!code) return;
                const r = document.createRange();
                r.selectNodeContents(code);
                const sel = getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
            }
        });
    });

    // The large code is drawn on open, not eight times on load.
    const zoom = $('am2-qr-zoom');
    document.querySelectorAll('[data-qr]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!zoom) return;
            const box = zoom.querySelector('[data-qr-zoom]');
            box.textContent = '';
            box.appendChild(window.AM2.qr(btn.dataset.qr, 264));
            zoom.querySelector('[data-qr-zoom-label]').textContent = btn.dataset.qrLabel;
            zoom.querySelector('[data-qr-zoom-url]').textContent = btn.dataset.qr;
        });
    });

    /* ---- Password rules, as they are met ------------------------------ */
    const pw = $('new_password');
    const pw2 = $('confirm_password');
    const rules = $('am2-pw-rules');
    const caps = $('am2-pw-caps');

    function mark(name, ok) {
        const li = rules?.querySelector(`[data-rule="${name}"]`);
        if (!li) return;
        li.classList.toggle('text-ok', ok);
        li.classList.toggle('text-ink-subtle', !ok);
        const dot = li.querySelector('[data-mark]');
        dot.textContent = ok ? '✓' : '·';
        dot.classList.toggle('border-ok', ok);
        dot.classList.toggle('border-edge-strong', !ok);
    }

    function checkRules() {
        mark('length', (pw?.value || '').length >= 8);
        mark('match', !!pw?.value && pw.value === pw2?.value);
    }
    [pw, pw2].forEach((el) => el?.addEventListener('input', checkRules));

    // A console operated at night, with a monospaced field that shows dots.
    [pw, pw2].forEach((el) => el?.addEventListener('keyup', (ev) => {
        if (typeof ev.getModifierState !== 'function') return;
        caps.hidden = !ev.getModifierState('CapsLock');
    }));
    checkRules();

    /* ---- Restore preflight -------------------------------------------- */
    const restoreForm = $('am2-restore-form');
    const pre = $('am2-sql-preflight');
    const word = $('am2-restore-word');
    const submit = $('am2-restore-submit');

    const countOf = (text, re) => (text.match(re) || []).length;

    dropzone('am2-sql-zone', async (file) => {
        if (!file || !pre) { if (pre) pre.hidden = true; return; }
        pre.hidden = false;
        pre.querySelector('[data-sql-name]').textContent = file.name;
        pre.querySelector('[data-sql-size]').textContent = bytes(file.size);

        const warn = pre.querySelector('[data-sql-warn]');
        const notes = [];

        // A dump can be large, and reading all of it would stall the dialog.
        // The cap is the server's own limit: anything past it cannot be sent.
        const cap = 8 * 1024 * 1024;
        const slice = file.size > cap ? file.slice(0, cap) : file;
        const text = await slice.text();
        if (file.size > cap) notes.push(T.partial);

        const kind = /PostgreSQL database dump/i.test(text) ? T.kind_dump
                   : /^--\s*AM2 backup/im.test(text) ? T.kind_am2
                   : T.kind_other;
        pre.querySelector('[data-sql-kind]').textContent = kind;

        const devices = countOf(text, /INSERT INTO public\.users\b/gi);
        const channels = countOf(text, /INSERT INTO public\.channels\b/gi);
        const copies = countOf(text, /^COPY public\./gim);

        pre.querySelector('[data-now-devices]').textContent = restoreForm.dataset.devices;
        pre.querySelector('[data-now-channels]').textContent = restoreForm.dataset.channels;
        pre.querySelector('[data-file-devices]').textContent = copies ? '—' : String(devices);
        pre.querySelector('[data-file-channels]').textContent = copies ? '—' : String(channels);

        // A backup with no DROP or TRUNCATE is added to what is already there,
        // which is where duplicate keys come from.
        if (!/\b(DROP TABLE|TRUNCATE)\b/i.test(text)) notes.push(T.no_drop);
        if (!/\.sql$/i.test(file.name)) notes.push(T.not_sql);

        warn.hidden = notes.length === 0;
        warn.textContent = notes.join(' ');
    });

    if (word && submit) {
        const expected = word.dataset.confirmWord.toUpperCase();
        const check = () => { submit.disabled = word.value.trim().toUpperCase() !== expected; };
        word.addEventListener('input', check);
        // Reopening the dialog must not inherit the last attempt's state.
        $('am2-restore')?.addEventListener('close.hs.overlay', () => {
            word.value = '';
            if (pre) pre.hidden = true;
            check();
        });
        check();
    }
})();
</script>
</body>
</html>
