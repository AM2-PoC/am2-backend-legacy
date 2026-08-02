<?php
header('Content-Type: application/json');
require_once 'config.php';

$method = $_SERVER['REQUEST_METHOD'];

if (isset($_GET['action']) && $_GET['action'] == 'export_db') {
    $admin_id = (int)($_GET['admin_id'] ?? 0);
    $role = $_GET['role'] ?? 'admin';

    $stmt = $pdo->prepare("SELECT username FROM public.admin WHERE id = ?");
    $stmt->execute([$admin_id]);
    $admin_user = $stmt->fetchColumn() ?: "admin";

    $timestamp = date('Ymd_His');
    $filename = ($role === 'superadmin' ? "FULL_BACKUP_" : "BACKUP_" . strtoupper($admin_user) . "_") . $timestamp . ".sql";

    header('Content-Type: application/octet-stream');
    header("Content-disposition: attachment; filename=\"" . $filename . "\"");

    putenv("PGPASSWORD=" . $password);

    if ($role === 'superadmin') {
        $command = "pg_dump -h " . $host . " -p " . $port . " -U " . $user . " -d " . $dbname . " -n public";
    } else {
        $command = "pg_dump -h " . $host . " -p " . $port . " -U " . $user . " -d " . $dbname . " -t public.users -t public.channels --column-inserts";
    }

    passthru($command);
    exit;
}

if ($method == 'GET') {
    $action = $_GET['action'] ?? '';
    $admin_id = (int)($_GET['admin_id'] ?? 0);
    $role = $_GET['role'] ?? 'admin';

    if ($action == 'check_update') {
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
    $admin_id = (int)($_POST['admin_id'] ?? 0);

    if ($action == 'update_password') {
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
        if (!isset($_FILES['sql_file'])) {
            echo json_encode(['success' => false, 'message' => 'File .sql tidak ditemukan']);
            exit;
        }
        $file = $_FILES['sql_file']['tmp_name'];
        try {
            putenv("PGPASSWORD=" . $password);
            $command = "psql -h " . $host . " -p " . $port . " -U " . $user . " -d " . $dbname . " < " . $file;
            shell_exec($command);
            echo json_encode(['success' => true, 'message' => 'Database berhasil dipulihkan']);
        } catch (Exception $e) {
            echo json_encode(['success' => false, 'message' => 'Restore gagal: ' . am2_safe_error($e, 'api_settings')]);
        }
    }
}
?>
