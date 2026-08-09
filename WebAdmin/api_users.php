<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();

function syncUserChannels($userId) {
    $url = AM2_NODE_BASE . "/api/admin/sync-channels?userId=" . urlencode($userId);
    @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 2]]));
}

function notifyPermissionUpdate($userId, $maps, $p2p, $video, $duplex = 'HALF DUPLEX') {
    $url = AM2_NODE_BASE . "/api/admin/update-permissions";
    $data = [
        'userId' => $userId,
        'enable_maps' => (bool)$maps,
        'enable_p2p' => (bool)$p2p,
        'enable_ptt_video' => (bool)$video,
        'duplex_mode' => $duplex
    ];
    $options = [
        'http' => [
            'header'  => "Content-type: application/json\r\n" . am2_node_auth_header(),
            'method'  => 'POST',
            'content' => json_encode($data),
            'timeout' => 2
        ]
    ];
    @file_get_contents($url, false, stream_context_create($options));
}

$admin_id = $_GET['admin_id'] ?? $_POST['admin_id'] ?? null;
$admin_role = $_GET['role'] ?? $_POST['role'] ?? 'admin';

$method = $_SERVER['REQUEST_METHOD'];

if ($method == 'GET') {
    $action = $_GET['action'] ?? '';

    if ($action == 'get_user_channels') {
        $u_id = $_GET['u_id'] ?? '';
        try {
            $stmt = $pdo->prepare("SELECT DISTINCT channel_id FROM public.user_channels WHERE user_id = ?");
            $stmt->execute([$u_id]);
            echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
        } catch (PDOException $e) {
            echo json_encode(['error' => am2_safe_error($e, 'api_users')]);
        }
        exit;
    }

    $search = isset($_GET['search']) ? trim($_GET['search']) : '';
    $sql = "SELECT u.id, u.name, u.status, u.admin_id, u.current_channel,
                   COALESCE(p.enable_maps, false) as enable_maps,
                   COALESCE(p.enable_p2p, false) as enable_p2p,
                   COALESCE(p.enable_ptt_video, false) as enable_ptt_video,
                   COALESCE(p.duplex_mode, 'HALF DUPLEX') as duplex_mode
            FROM public.users u
            LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
            WHERE u.role = 'user'";

    $params = [];

    if (strtolower($admin_role) !== 'superadmin') {
        $sql .= " AND u.admin_id = ?";
        $params[] = $admin_id;
    }

    if ($search !== '') {
        $sql .= " AND (u.name ILIKE ? OR u.id::text ILIKE ?)";
        $params[] = "%$search%";
        $params[] = "%$search%";
    }

    try {
        $stmt = $pdo->prepare($sql . " ORDER BY u.name ASC");
        $stmt->execute($params);
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($users as &$u) {
            $u['enable_maps'] = (bool)$u['enable_maps'];
            $u['enable_p2p'] = (bool)$u['enable_p2p'];
            $u['enable_ptt_video'] = (bool)$u['enable_ptt_video'];
            $u['admin_id'] = $u['admin_id'] ? (int)$u['admin_id'] : null;
        }

        echo json_encode($users);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => am2_safe_error($e, 'api_users')]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action == 'add' || $action == 'edit') {
        $id = trim($_POST['id'] ?? '');
        $name = strtoupper(trim($_POST['name'] ?? ''));
        $password = $_POST['password'] ?? '';

        if (empty($id) || empty($name)) {
            echo json_encode(['success' => false, 'message' => 'Data tidak lengkap']);
            exit;
        }

        try {
            $pdo->beginTransaction();
            if ($action == 'add') {
                $pass_hash = password_hash($password, PASSWORD_BCRYPT);
                $stmt = $pdo->prepare("INSERT INTO public.users (id, name, password, role, status, admin_id, created_at, updated_at) VALUES (?, ?, ?, 'user', 'offline', ?, NOW(), NOW())");
                $stmt->execute([$id, $name, $pass_hash, $admin_id]);

                $stmt_p = $pdo->prepare("INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode, updated_at) VALUES (?, false, false, false, 'HALF DUPLEX', NOW())");
                $stmt_p->execute([$id]);
            } else {
                $sql = "UPDATE public.users SET name = ?, updated_at = NOW() WHERE id = ?";
                $params = [$name, $id];
                if (!empty($password)) {
                    $sql = "UPDATE public.users SET name = ?, password = ?, updated_at = NOW() WHERE id = ?";
                    $params = [$name, password_hash($password, PASSWORD_BCRYPT), $id];
                }
                $pdo->prepare($sql)->execute($params);
            }

            $pdo->commit();
            echo json_encode(['success' => true, 'message' => 'User berhasil ' . ($action == 'add' ? 'ditambahkan' : 'diperbarui')]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => 'Gagal: ' . am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'save_user_channels') {
        $u_id = $_POST['u_id'] ?? '';
        $channels = json_decode($_POST['channels'] ?? '[]', true) ?: [];
        $channels = array_unique(array_filter($channels));

        try {
            $pdo->beginTransaction();
            $pdo->prepare("DELETE FROM public.user_channels WHERE user_id = ?")->execute([$u_id]);

            if (!empty($channels)) {
                $stmt = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, ?, 'FULL DUPLEX')");
                foreach ($channels as $idx => $ch_id) {
                    $is_default = ($idx === 0);
                    $stmt->execute([$u_id, $ch_id, $is_default ? 'true' : 'false']);
                    if ($is_default) {
                        $pdo->prepare("UPDATE public.users SET last_channel_id = ? WHERE id = ?")->execute([$ch_id, $u_id]);
                    }
                }
            } else {
                $pdo->prepare("UPDATE public.users SET last_channel_id = NULL WHERE id = ?")->execute([$u_id]);
            }

            $pdo->commit();
            syncUserChannels($u_id);
            echo json_encode(['success' => true]);
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'update_feature') {
        $target_uid = $_POST['u_id'] ?? '';
        if (!am2_admin_owns_user($pdo, $admin_id, $admin_role, $target_uid)
            && am2_api_authz_denied('feature-foreign-user')) {
            exit;
        }

        $u_id = $_POST['u_id'] ?? '';
        $feature = $_POST['feature'] ?? '';

        if ($feature === 'duplex_mode') {
            $val = $_POST['val'];
            $sql_val = $pdo->quote($val);
        } else {
            $val = ($_POST['val'] === 'true') ? 'true' : 'false';
            $sql_val = $val;
        }

        // $feature is interpolated as a column name below. users.php has always
        // validated it against an allow-list; this copy never did, and this file
        // takes its caller's word for who they are.
        //
        // duplex_mode belongs here. It has its own branch eight lines above --
        // which is the proof the app calls this endpoint with it -- and leaving
        // it out made every FULL/HALF toggle in Admin Native answer "Fitur tidak
        // valid". users.php keeps its own list and still accepts it, so the
        // panel works and this would not have shown up in panel testing.
        //
        // Safe to interpolate for the same reason as the rest: the column name
        // is a literal from this list, and the value took the $pdo->quote()
        // branch above.
        //
        // Checked before the transaction is opened, so the exit below does not
        // leave one dangling for the request to unwind.
        $allowed = ['enable_maps', 'enable_p2p', 'enable_ptt_video', 'duplex_mode'];
        if (!in_array($feature, $allowed, true)) {
            echo json_encode(['success' => false, 'message' => 'Fitur tidak valid']);
            exit;
        }

        try {
            $pdo->beginTransaction();

            $sql = "INSERT INTO public.user_app_permissions (user_id, $feature, updated_at)
                    VALUES (?, $sql_val, NOW())
                    ON CONFLICT (user_id)
                    DO UPDATE SET $feature = EXCLUDED.$feature, updated_at = NOW()";
            $pdo->prepare($sql)->execute([$u_id]);

            $p = $pdo->prepare("SELECT * FROM public.user_app_permissions WHERE user_id = ?");
            $p->execute([$u_id]);
            $row = $p->fetch(PDO::FETCH_ASSOC);

            $pdo->commit();
            notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
            echo json_encode(['success' => true]);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]);
        }
    }
    elseif ($action == 'delete') {
        $id = $_POST['id'] ?? '';
        if (!am2_admin_owns_user($pdo, $admin_id, $admin_role, $id)
            && am2_api_authz_denied('delete-foreign-user')) {
            exit;
        }

        try {
            $pdo->prepare("DELETE FROM public.users WHERE id = ? AND role = 'user'")->execute([$id]);
            echo json_encode(['success' => true]);
        } catch (PDOException $e) { echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_users')]); }
    }
}
?>
