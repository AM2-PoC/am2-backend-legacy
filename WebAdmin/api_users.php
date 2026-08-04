<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();



// Identity is resolved by the server; see am2_api_identity().
[$admin_id, $admin_role] = am2_api_identity();

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
            // A form is not an authorization: the ids arrive over POST, and this
            // path never checked them against who is asking. The panel has.
            if (am2_first_foreign_channel($pdo, $admin_id, $admin_role, $channels) !== null) {
                echo json_encode(['success' => false, 'message' => 'Akses ditolak']);
                exit;
            }

            $pdo->beginTransaction();

            // The same call the panel makes. What it replaces deleted every
            // membership and rebuilt it as FULL DUPLEX with the first entry as
            // default -- so re-saving a list from the app reset every
            // permission and moved where the unit comes up.
            am2_set_user_channels($pdo, (string) $u_id, $channels);

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

        try {
            // The asking admin's own rights, which this path never read. An
            // admin told they may not manage video could enable it from the
            // app, because only the panel was checking.
            $stmtAuth = $pdo->prepare(
                "SELECT can_manage_maps, can_manage_p2p, can_manage_video
                 FROM public.admin WHERE id = ?");
            $stmtAuth->execute([$admin_id]);
            $auth = $stmtAuth->fetch(PDO::FETCH_ASSOC) ?: [];
            if ($admin_role === 'superadmin') {
                $auth = ['can_manage_maps' => true, 'can_manage_p2p' => true,
                         'can_manage_video' => true];
            }

            $pdo->beginTransaction();
            $val = am2_feature_value($feature, $_POST['val'] ?? '');
            $row = am2_set_user_feature($pdo, (string) $u_id, $feature, $_POST['val'] ?? '', $auth);

            $stmtName = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtName->execute([$u_id]);
            $targetName = $stmtName->fetchColumn() ?: $u_id;

            [$logCode, $logParams] = am2_feature_log(
                $feature, (string) $val, (string) $u_id, (string) $targetName);
            $logParams['via'] = 'mobile';
            am2_log($pdo, $admin_id, 'UPDATE_FEATURE', $logCode, $logParams, 'users', (string) $u_id);

            $pdo->commit();
            notifyPermissionUpdate($u_id, $row['enable_maps'], $row['enable_p2p'], $row['enable_ptt_video'], $row['duplex_mode']);
            echo json_encode(['success' => true]);
        } catch (InvalidArgumentException | RuntimeException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => am2_feature_reason($e)]);
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
