<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

$method = $_SERVER['REQUEST_METHOD'];



if ($method == 'GET') {
    // Identity is resolved by the server; see am2_api_identity().
    [$admin_id, $admin_role] = am2_api_identity();
    $is_superadmin = ($admin_role === 'superadmin');
    $search = isset($_GET['search']) ? trim($_GET['search']) : '';
    $params = [];

    $sql = "SELECT u.id, u.name,
               STRING_AGG(CASE WHEN uc.is_default THEN '*' || c.display_name ELSE c.display_name END, ', ' ORDER BY uc.is_default DESC) as allowed_channels,
               COALESCE(json_agg(c.id ORDER BY uc.is_default DESC) FILTER (WHERE c.id IS NOT NULL), '[]') as channel_ids_json,
               COALESCE(json_agg(uc.permission ORDER BY uc.is_default DESC) FILTER (WHERE uc.permission IS NOT NULL), '[]') as permissions_json,
               MAX(CASE WHEN uc.is_default THEN uc.channel_id END) as default_id
               FROM public.users u
               LEFT JOIN public.user_channels uc ON u.id = uc.user_id
               LEFT JOIN public.channels c ON uc.channel_id = c.id
               WHERE u.role = 'user'";

    if (!$is_superadmin) {
        $sql .= " AND u.admin_id = ?";
        $params[] = $admin_id;
    }

    if ($search !== '') {
        $sql .= " AND (u.name ILIKE ? OR u.id::text ILIKE ?)";
        $params[] = "%$search%";
        $params[] = "%$search%";
    }

    $sql .= " GROUP BY u.id, u.name ORDER BY u.name ASC";

    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $result = $stmt->fetchAll(PDO::FETCH_ASSOC);

        foreach ($result as &$row) {
            $row['id'] = (string)$row['id'];
            $row['channel_ids_json'] = json_decode($row['channel_ids_json'] ?? '[]', true) ?: [];
            $row['permissions_json'] = json_decode($row['permissions_json'] ?? '[]', true) ?: [];
            $row['default_id'] = $row['default_id'] ? (int)$row['default_id'] : null;
        }

        echo json_encode($result);
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => am2_safe_error($e, 'api_user_access')]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';
    // Identity is resolved by the server; see am2_api_identity().
    [$current_admin_id, $current_admin_role] = am2_api_identity();

    if ($action == 'force_logout') {
        $user_id = (string)($_POST['user_id'] ?? '');
        if (!am2_admin_owns_user($pdo, $current_admin_id, $current_admin_role, $user_id)
            && am2_api_authz_denied('kick-foreign-user')) {
            exit;
        }

        try {
            $pdo->beginTransaction();

            $stmtU = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtU->execute([$user_id]);
            $target_name = $stmtU->fetchColumn() ?: "ID: $user_id";

            // Declared where the change is made, as on the panel's own path.
            am2_audit_expect('force_logout');
            $sqlKick = "UPDATE public.users SET force_logout = TRUE, status = 'offline', current_device_id = NULL WHERE id = ?";
            $pdo->prepare($sqlKick)->execute([$user_id]);

            /*
             * Same event as the panel's, with where it came from as a
             * parameter. It used to be the string " (via Mobile)" glued onto
             * the end of the sentence, which meant the two could not be grouped
             * and neither could be translated.
             *
             * Unconditional now. It used to be skipped when the caller had no
             * admin id, which is the one case where the trail matters most: a
             * unit kicked off by nobody identifiable left no record that it had
             * been kicked at all. am2_log() already stores an absent id as
             * null, so the row says what is true.
             */
            am2_log($pdo, $current_admin_id, 'FORCE_LOGOUT', 'user.force_logout',
                    ['name' => $target_name, 'via' => 'mobile'], 'users', (string) $user_id);

            am2_audit_complete();
            $pdo->commit();
            notifyForceLogout($user_id);
            echo json_encode(['success' => true, 'message' => 'User berhasil dikeluarkan.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_user_access')]);
        }
    }
    elseif ($action == 'update_access') {
        $user_id = (string)($_POST['user_id'] ?? '');
        if (!am2_admin_owns_user($pdo, $current_admin_id, $current_admin_role, $user_id)
            && am2_api_authz_denied('access-foreign-user')) {
            exit;
        }

        $selected_channels = $_POST['channels'] ?? [];
        $default_channel_id = $_POST['default_channel'] ?? null;
        $permissions_input = json_decode($_POST['permissions'] ?? '[]', true);

        $selected_channels = array_unique(array_filter($selected_channels));

        try {
            $pdo->beginTransaction();

            $stmtUser = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtUser->execute([$user_id]);
            $target_name = $stmtUser->fetchColumn() ?: "ID: $user_id";

            // The same call the panel makes, so the default channel and each
            // permission are decided in one place rather than two that drifted.
            $result = am2_set_user_channels(
                $pdo, (string) $user_id, $selected_channels, $default_channel_id, $permissions_input
            );

            if (!empty($selected_channels)) {
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
                $logParams = ['name' => $target_name, 'channels' => $logChannels, 'via' => 'mobile'];
            } else {
                $logCode   = 'access.revoke';
                $logParams = ['name' => $target_name, 'via' => 'mobile'];
            }

            if ($current_admin_id) {
                am2_log($pdo, $current_admin_id, 'UPDATE_ACCESS', $logCode, $logParams,
                        'users', (string) $user_id);
            }

            am2_audit_complete();
            $pdo->commit();
            syncUserChannels($user_id);
            echo json_encode(['success' => true, 'message' => 'Otoritas akses user berhasil diperbarui.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack(); am2_audit_abandon();
            echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_user_access')]);
        }
    }
}
?>
