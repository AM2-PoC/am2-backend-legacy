<?php
header('Content-Type: application/json');
require_once 'config.php';

function syncUserChannels($userId) {
    $url = "http://localhost:5000/api/admin/sync-channels?userId=" . urlencode($userId);
    @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 2]]));
}

$admin_id = $_GET['admin_id'] ?? $_POST['admin_id'] ?? null;
$admin_role = $_GET['role'] ?? $_POST['role'] ?? 'admin';

$method = $_SERVER['REQUEST_METHOD'];

if ($method == 'GET') {
    $action = $_GET['action'] ?? '';

    if ($action == 'get_users_access') {
        $ch_id = (int)$_GET['channel_id'];
        try {
            $stmt = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
            $stmt->execute([$ch_id]);
            echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        } catch (PDOException $e) {
            echo json_encode(['error' => $e->getMessage()]);
        }
        exit;
    }

    try {
        if ($admin_role === 'superadmin') {
            $stmt = $pdo->prepare("
                SELECT c.*, a.username as creator_name, 'OWNER' as ownership_type,
                (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
                (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id) as total_access
                FROM public.channels c
                LEFT JOIN public.admin a ON c.created_by = a.id
                ORDER BY c.display_name ASC
            ");
            $stmt->execute();
        } else {
            $stmt = $pdo->prepare("
                SELECT DISTINCT ON (c.id) c.*, a.username as creator_name,
                CASE WHEN c.created_by = ? THEN 'OWNER' ELSE 'DELEGATED' END as ownership_type,
                (SELECT COUNT(*) FROM public.users u WHERE u.current_channel = c.name AND u.status = 'online') as online_count,
                (SELECT COUNT(*) FROM public.user_channels uc WHERE uc.channel_id = c.id AND uc.user_id IN (SELECT id FROM public.users WHERE admin_id = ?)) as total_access
                FROM public.channels c
                LEFT JOIN public.admin a ON c.created_by = a.id
                LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
                WHERE c.created_by = ? OR amc.admin_id = ?
                ORDER BY c.id, c.display_name ASC
            ");
            $stmt->execute([$admin_id, $admin_id, $admin_id, $admin_id]);
        }
        $channels = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode($channels);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action == 'add') {
        $display_name = strtoupper(trim($_POST['display_name'] ?? ''));
        $name = strtolower(str_replace(' ', '_', $display_name));
        $category = 'public';

        try {
            $stmt = $pdo->prepare("INSERT INTO public.channels (name, display_name, category, created_by) VALUES (?, ?, ?, ?)");
            $stmt->execute([$name, $display_name, $category, $admin_id]);
            echo json_encode(['success' => true]);
        } catch (PDOException $e) {
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
    }
    elseif ($action == 'delete') {
        $id = (int)($_POST['id'] ?? 0);
        try {
            $pdo->beginTransaction();

            if ($admin_role !== 'superadmin') {
                $stmt_check = $pdo->prepare("SELECT id FROM public.channels WHERE id = ? AND created_by = ?");
                $stmt_check->execute([$id, $admin_id]);
                if (!$stmt_check->fetch()) {
                    echo json_encode(['success' => false, 'message' => 'Hanya pemilik (Owner) atau Superadmin yang dapat menghapus channel ini.']);
                    $pdo->rollBack();
                    exit;
                }
            }

            $stmt_get = $pdo->prepare("SELECT name FROM public.channels WHERE id = ?");
            $stmt_get->execute([$id]);
            $channel_info = $stmt_get->fetch(PDO::FETCH_ASSOC);

            if ($channel_info) {
                $channel_name = $channel_info['name'];
                $pdo->prepare("UPDATE public.users SET current_channel = NULL WHERE current_channel = ?")->execute([$channel_name]);
                $pdo->prepare("DELETE FROM public.ptt_logs WHERE channel_id = ?")->execute([$id]);
                $pdo->prepare("DELETE FROM public.admin_managed_channels WHERE channel_id = ?")->execute([$id]);
                $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ?")->execute([$id]);
                $pdo->prepare("DELETE FROM public.channels WHERE id = ?")->execute([$id]);

                $pdo->commit();
                echo json_encode(['success' => true]);
            } else {
                echo json_encode(['success' => false, 'message' => 'Channel tidak ditemukan']);
            }
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
    }
    elseif ($action == 'save_access') {
        $ch_id = (int)$_POST['channel_id'];
        $selected_users = json_decode($_POST['users'] ?? '[]', true);
        try {
            $pdo->beginTransaction();
            if ($admin_role === 'superadmin') {
                $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ?")->execute([$ch_id]);
            } else {
                $pdo->prepare("DELETE FROM public.user_channels WHERE channel_id = ? AND user_id IN (SELECT id FROM public.users WHERE admin_id = ?)")->execute([$ch_id, $admin_id]);
            }
            if (!empty($selected_users)) {
                $stmt_ins = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, 'false', 'FULL DUPLEX')");
                foreach ($selected_users as $u_id) { $stmt_ins->execute([$u_id, $ch_id]); }
            }
            $pdo->commit();
            foreach ($selected_users as $uid) { syncUserChannels($uid); }
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
    }
}
?>
