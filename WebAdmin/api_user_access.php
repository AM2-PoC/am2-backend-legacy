<?php
header('Content-Type: application/json');
require_once 'config.php';

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

$method = $_SERVER['REQUEST_METHOD'];

function syncUserChannels($userId) {
    $url = "http://localhost:5000/api/admin/sync-channels?userId=" . urlencode($userId);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 2);
        @curl_exec($ch);
        curl_close($ch);
    } else {
        $options = ['http' => ['timeout' => 2]];
        $context = stream_context_create($options);
        @file_get_contents($url, false, $context);
    }
}

function notifyForceLogout($userId) {
    $url = "http://localhost:5000/api/admin/force-logout";
    $data = json_encode(['userId' => $userId]);
    $options = [
        'http' => [
            'header'  => "Content-type: application/json\r\n",
            'method'  => 'POST',
            'content' => $data,
            'timeout' => 2
        ]
    ];
    $context  = stream_context_create($options);
    @file_get_contents($url, false, $context);
}

if ($method == 'GET') {
    $admin_id = $_GET['admin_id'] ?? null;
    $admin_role = $_GET['role'] ?? 'admin';
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
        $sql .= " AND (u.name ILIKE ? u.id::text ILIKE ?)";
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
        echo json_encode(['error' => $e->getMessage()]);
    }
}
elseif ($method == 'POST') {
    $action = $_POST['action'] ?? '';
    $current_admin_id = $_POST['admin_id'] ?? null;

    if ($action == 'force_logout') {
        $user_id = (string)($_POST['user_id'] ?? '');
        try {
            $pdo->beginTransaction();

            $stmtU = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtU->execute([$user_id]);
            $target_name = $stmtU->fetchColumn() ?: "ID: $user_id";

            $sqlKick = "UPDATE public.users SET force_logout = TRUE, status = 'offline', current_device_id = NULL WHERE id = ?";
            $pdo->prepare($sqlKick)->execute([$user_id]);

            if ($current_admin_id) {
                $stmtLog = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'FORCE_LOGOUT', ?, NOW())");
                $stmtLog->execute([$current_admin_id, "Memutus paksa koneksi user: $target_name (via Mobile)"]);
            }

            $pdo->commit();
            notifyForceLogout($user_id);
            echo json_encode(['success' => true, 'message' => 'User berhasil dikeluarkan.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
    }
    elseif ($action == 'update_access') {
        $user_id = (string)($_POST['user_id'] ?? '');
        $selected_channels = $_POST['channels'] ?? [];
        $default_channel_id = $_POST['default_channel'] ?? null;
        $permissions_input = json_decode($_POST['permissions'] ?? '[]', true);

        $selected_channels = array_unique(array_filter($selected_channels));

        try {
            $pdo->beginTransaction();

            $stmtUser = $pdo->prepare("SELECT name FROM public.users WHERE id = ?");
            $stmtUser->execute([$user_id]);
            $target_name = $stmtUser->fetchColumn() ?: "ID: $user_id";

            $pdo->prepare("DELETE FROM public.user_channels WHERE user_id = ?")->execute([$user_id]);

            $channel_names_added = [];

            if (!empty($selected_channels)) {
                if (!$default_channel_id || !in_array($default_channel_id, $selected_channels)) {
                    $default_channel_id = $selected_channels[0];
                }

                $stmtIns = $pdo->prepare("INSERT INTO public.user_channels (user_id, channel_id, is_default, permission) VALUES (?, ?, ?, ?)");
                $stmtChName = $pdo->prepare("SELECT display_name FROM public.channels WHERE id = ?");

                foreach ($selected_channels as $ch_id) {
                    $is_default = ($ch_id == $default_channel_id);
                    $perm = ($permissions_input[$ch_id] ?? '') === 'RX' ? 'RX' : 'FULL DUPLEX';

                    $stmtIns->execute([$user_id, $ch_id, $is_default ? 'true' : 'false', $perm]);

                    if ($is_default) {
                        $pdo->prepare("UPDATE public.users SET last_channel_id = ? WHERE id = ?")->execute([$ch_id, $user_id]);
                    }

                    $stmtChName->execute([$ch_id]);
                    $c_name = $stmtChName->fetchColumn();
                    $channel_names_added[] = $c_name . ($is_default ? " (Utama)" : "") . " [$perm]";
                }
                $keterangan_log = "Update akses $target_name ke: " . implode(", ", $channel_names_added);
            } else {
                $pdo->prepare("UPDATE public.users SET last_channel_id = NULL WHERE id = ?")->execute([$user_id]);
                $keterangan_log = "Mencabut semua akses channel dari user: $target_name";
            }

            if ($current_admin_id) {
                $stmtLogAccess = $pdo->prepare("INSERT INTO public.admin_activity_logs (admin_id, aksi, keterangan, waktu) VALUES (?, 'UPDATE_ACCESS', ?, NOW())");
                $stmtLogAccess->execute([$current_admin_id, $keterangan_log . " (via Mobile)"]);
            }

            $pdo->commit();
            syncUserChannels($user_id);
            echo json_encode(['success' => true, 'message' => 'Otoritas akses user berhasil diperbarui.']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            echo json_encode(['success' => false, 'message' => $e->getMessage()]);
        }
    }
}
?>
