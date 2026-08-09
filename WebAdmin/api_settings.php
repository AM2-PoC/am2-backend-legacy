<?php
session_start();
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();

/*
 * The one action here that is deliberately public.
 *
 * Admin Native calls this to learn whether a newer APK exists; it has no
 * session and, until it ships a key, no credential either. The answer is the
 * published version, its download URL and its changelog -- all of which the
 * download endpoint already serves to anyone. Gating it behind the session
 * added below broke update checks for every handset in the field, which a
 * contract test caught by name.
 *
 * Placed before the gate rather than exempted inside it, so the reason is
 * visible at the point it applies.
 */
if (($_GET['action'] ?? '') === 'check_update') {

    $json_path = 'update/admin_version.json';
    if (file_exists($json_path)) {
        $data = json_decode(file_get_contents($json_path), true);
        echo json_encode([
            'latest_version' => $data['version_name'],
            'download_url' => $data['download_url'],
            'changelog' => $data['changelog']
        ]);
    } else {
        echo json_encode([
            'latest_version' => '1.0.0',
            'download_url' => 'https://am2-poc.com/update/admin.apk',
            'changelog' => 'Versi awal.'
        ]);
    }
    exit;
}

/*
 * Who is allowed in here, decided before anything else runs.
 *
 * This file had no authentication of any kind. It took the caller's word for
 * their role -- `$_GET['role']` -- and on that word streamed a pg_dump of the
 * entire public schema; its import action shell_exec'd psql against an
 * uploaded .sql with no role check at all. Both were reachable from the
 * internet, because the panel's vhost forwards every path.
 *
 * Backup and restore are superadmin operations, so the check is the identity
 * of the session, and only the session. A role that arrives in the request is
 * a role the requester chose; the query parameters are still read below for
 * naming the file, but they no longer decide anything.
 */
if (empty($_SESSION['admin_logged_in'])) {
    http_response_code(401);
    exit(json_encode(['success' => false, 'message' => 'Unauthorized']));
}

$session_role = strtolower((string) ($_SESSION['admin_role'] ?? ''));
$is_superadmin = $session_role === 'superadmin';

/** Refuse anything but a signed-in superadmin, in one place. */
function am2_settings_require_superadmin(bool $ok): void
{
    if ($ok) {
        return;
    }
    http_response_code(403);
    exit(json_encode(['success' => false, 'message' => 'Akses ditolak']));
}

$method = $_SERVER['REQUEST_METHOD'];

if (isset($_GET['action']) && $_GET['action'] == 'export_db') {
    am2_settings_require_superadmin($is_superadmin);

    $admin_id = (int) ($_SESSION['admin_id'] ?? 0);
    $role = $session_role;

    $stmt = $pdo->prepare("SELECT username FROM public.admin WHERE id = ?");
    $stmt->execute([$admin_id]);
    $admin_user = $stmt->fetchColumn() ?: "admin";

    $timestamp = date('Ymd_His');
    $filename = ($role === 'superadmin' ? "FULL_BACKUP_" : "BACKUP_" . strtoupper($admin_user) . "_") . $timestamp . ".sql";

    header('Content-Type: application/octet-stream');
    header("Content-disposition: attachment; filename=\"" . $filename . "\"");

    /*
     * Argument array, not a shell string, and the password in the child's
     * environment rather than this process's.
     *
     * putenv() puts PGPASSWORD in the process table, where `ps` shows it to
     * every account on the host -- and the command was assembled by pasting
     * host, port, user and database name into a line the shell then parsed.
     * Neither is attacker-controlled today (they come from the env file), but
     * a credential visible to `ps` is a credential leaked, and a shell string
     * is one config change away from being a command injection.
     */
    $args = ['pg_dump', '-h', $host, '-p', (string) $port, '-U', $user, '-d', $dbname];
    $args = array_merge($args, $role === 'superadmin'
        ? ['-n', 'public']
        : ['-t', 'public.users', '-t', 'public.channels', '--column-inserts']);

    $proc = proc_open($args, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
                      ['PGPASSWORD' => $password] + $_ENV);
    if (!is_resource($proc)) {
        http_response_code(500);
        exit('pg_dump tidak dapat dijalankan');
    }
    fpassthru($pipes[1]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($proc);
    exit;
}

if ($method == 'GET') {
    $action = $_GET['action'] ?? '';
    /*
     * Identity from the session, not the query string. Reading another admin's
     * settings was a matter of changing admin_id, and role=superadmin turned
     * the counts below into a census of the whole system.
     */
    $admin_id = (int) ($_SESSION['admin_id'] ?? 0);
    $role = $session_role;


    try {
        $stmt = $pdo->prepare("SELECT username, role, user_quota, channel_quota, expired_at, can_manage_maps, can_manage_p2p, can_manage_video FROM public.admin WHERE id = ?");
        $stmt->execute([$admin_id]);
        $settings = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($settings) {
            if ($role === 'superadmin') {
                $total_admins = $pdo->query("SELECT COUNT(*) FROM public.admin WHERE role = 'admin'")->fetchColumn();
                $total_users = $pdo->query("SELECT COUNT(*) FROM public.users")->fetchColumn();
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

            $settings['total_admins'] = (int)$total_admins;
            $settings['total_users'] = (int)$total_users;
            $settings['total_channels'] = (int)$total_channels;
            $settings['can_manage_maps'] = (bool)($settings['can_manage_maps'] == 'true' || $settings['can_manage_maps'] === true);
            $settings['can_manage_p2p'] = (bool)($settings['can_manage_p2p'] == 'true' || $settings['can_manage_p2p'] === true);
            $settings['can_manage_video'] = (bool)($settings['can_manage_video'] == 'true' || $settings['can_manage_video'] === true);

            echo json_encode($settings);
        } else {
            echo json_encode(['error' => 'Settings not found']);
        }
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => am2_safe_error($e, 'api_settings')]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';
    $admin_id = (int) ($_SESSION['admin_id'] ?? 0);

    if ($action == 'update_password') {
        /*
         * Your own, always -- and said so, rather than done quietly.
         *
         * This took admin_id from the request, so any signed-in admin could
         * rewrite the superadmin's password by naming its id, and before the
         * session gate above so could anyone at all. Ignoring the parameter
         * closes that, but silently: a caller asking to change admin 5's
         * password had admin 6's changed instead and was told it worked. A
         * contract test caught it by having its own fixture password rewritten
         * underneath it.
         *
         * So a request that names someone else is refused outright. There is
         * no legitimate caller for it: this endpoint has never had a
         * change-another-admin's-password feature.
         */
        $named = $_POST['admin_id'] ?? null;
        if ($named !== null && (string) $named !== (string) $admin_id) {
            http_response_code(403);
            exit(json_encode(['success' => false, 'message' => 'Akses ditolak']));
        }

        $new_pass = $_POST['new_password'] ?? '';
        if (strlen($new_pass) < 8) {
            echo json_encode(['success' => false, 'message' => 'Password minimal 8 karakter']);
            exit;
        }
        $hash = password_hash($new_pass, PASSWORD_BCRYPT);
        try {
            $stmt = $pdo->prepare("UPDATE public.admin SET password_hash = ? WHERE id = ?");
            $stmt->execute([$hash, $admin_id]);
            echo json_encode(['success' => true, 'message' => 'Password diperbarui']);
        } catch (PDOException $e) {
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_settings')]);
        }
    }
    elseif ($action == 'import_db') {
        // Restoring a database over the live one is the most destructive thing
        // this panel can do, and it had no role check whatsoever.
        am2_settings_require_superadmin($is_superadmin);

        if (!isset($_FILES['sql_file'])) {
            echo json_encode(['success' => false, 'message' => 'File .sql tidak ditemukan']);
            exit;
        }
        // A real upload, not a path the request chose: without this check an
        // is_uploaded_file()-less handler can be pointed at any readable file.
        if (!is_uploaded_file($_FILES['sql_file']['tmp_name'] ?? '')) {
            http_response_code(400);
            exit(json_encode(['success' => false, 'message' => 'Unggahan tidak valid']));
        }
        $file = $_FILES['sql_file']['tmp_name'];
        try {
            /*
             * proc_open with an argument array rather than a shell string.
             * The old form pasted host, port, user and database name straight
             * into a command line, and passed the password through putenv --
             * which puts it in the process table, where `ps` on this host shows
             * it to anyone. The password now goes to psql's own stdin channel
             * via the environment of the child alone, and the .sql arrives on
             * stdin instead of through a shell redirect.
             */
            $descriptors = [0 => ['file', $file, 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
            $proc = proc_open(
                ['psql', '-h', $host, '-p', (string) $port, '-U', $user, '-d', $dbname,
                 '-v', 'ON_ERROR_STOP=1'],
                $descriptors,
                $pipes,
                null,
                ['PGPASSWORD' => $password] + $_ENV
            );
            if (!is_resource($proc)) {
                throw new RuntimeException('psql tidak dapat dijalankan');
            }
            stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            foreach ($pipes as $p) { if (is_resource($p)) fclose($p); }
            if (proc_close($proc) !== 0) {
                throw new RuntimeException($stderr !== '' ? $stderr : 'psql exited non-zero');
            }
            echo json_encode(['success' => true, 'message' => 'Database berhasil dipulihkan']);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => 'Restore gagal: ' . am2_safe_error($e, 'api_settings')]);
        }
    }
}
?>
