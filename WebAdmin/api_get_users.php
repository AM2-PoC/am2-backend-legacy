<?php
require_once 'config.php';
am2_api_auth();

// Identity is resolved by the server; see am2_api_identity().
[$admin_id, $admin_role] = am2_api_identity();
$is_superadmin = ($admin_role === 'superadmin');

date_default_timezone_set('Asia/Jakarta');

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    $sql = "SELECT
                u.id, u.name, u.latitude, u.longitude, u.accuracy, u.status, u.updated_at,
                c.display_name as channel_name,
                COALESCE(last_log.speaking_state, 0) as is_speaking
            FROM public.users u
            LEFT JOIN public.channels c ON u.current_channel = c.name
            LEFT JOIN LATERAL (
                SELECT
                    CASE
                        WHEN l.event_type IN ('PUSH', 'PUSH_PRIVATE')
                             AND l.event_time > (NOW() - INTERVAL '7 seconds') THEN 1
                        ELSE 0
                    END as speaking_state
                FROM public.ptt_logs l
                WHERE l.user_id = u.id
                ORDER BY l.event_time DESC
                LIMIT 1
            ) last_log ON TRUE
            WHERE u.status = 'online'";

    if (!$is_superadmin) {
        // Previously this was `if (!$is_superadmin && $admin_id)`, so dropping
        // the parameter dropped the filter and returned every online user's
        // position instead of none.
        if (!$admin_id) {
            echo json_encode([]);
            exit;
        }
        $sql .= " AND u.admin_id = :admin_id";
    }

    $sql .= " ORDER BY is_speaking DESC, u.name ASC";

    $stmt = $pdo->prepare($sql);
    if (!$is_superadmin) {
        $stmt->bindValue(':admin_id', $admin_id);
    }
    $stmt->execute();
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $results = [];
    foreach ($users as $user) {
        $is_stale = (strtotime('now') - strtotime($user['updated_at']) > 60) ? true : false;
        $results[] = [
            'id'           => $user['id'],
            'name'         => htmlspecialchars($user['name']),
            'lat'          => (float)$user['latitude'],
            'lng'          => (float)$user['longitude'],
            'accuracy'     => (float)$user['accuracy'],
            'is_online'    => 1,
            'is_speaking'  => (int)$user['is_speaking'],
            'is_stale'     => $is_stale,
            'channel_name' => $user['channel_name'] ?? 'Standby',
            'updated_at'   => $user['updated_at']
        ];
    }

    header('Content-Type: application/json');
    echo json_encode($results);

} catch (PDOException $e) {
    header('Content-Type: application/json', true, 500);
    echo json_encode(['error' => am2_safe_error($e, 'api_get_users')]);
}
?>
