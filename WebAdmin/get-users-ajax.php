<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Content-Type: application/json', true, 401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

date_default_timezone_set('Asia/Jakarta');

$current_admin_id = $_SESSION['admin_id'] ?? null;
$is_superadmin = (isset($_SESSION['admin_role']) && $_SESSION['admin_role'] === 'superadmin');

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    $sql = "SELECT
                u.id, 
                u.name, 
                u.entity_type,
                u.latitude, 
                u.longitude, 
                u.accuracy, 
                u.status, 
                u.updated_at,
                u.location_updated_at,
                CASE
                    WHEN u.latitude IS NULL OR u.longitude IS NULL
                      OR u.latitude NOT BETWEEN -90 AND 90
                      OR u.longitude NOT BETWEEN -180 AND 180
                      OR (u.latitude = 0 AND u.longitude = 0)
                    THEN false ELSE true
                END AS has_location,
                CASE
                    WHEN u.location_updated_at IS NULL THEN NULL
                    ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - u.location_updated_at))))::bigint
                END AS location_age_seconds,
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

    if (!$is_superadmin && $current_admin_id) {
        $sql .= " AND u.admin_id = :admin_id";
    }

    $sql .= " ORDER BY is_speaking DESC, u.name ASC";
    
    $stmt = $pdo->prepare($sql);
    if (!$is_superadmin && $current_admin_id) {
        $stmt->bindValue(':admin_id', $current_admin_id);
    }
    $stmt->execute();
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $results = [];
    foreach ($users as $user) {
        $age = $user['location_age_seconds'] === null
            ? null
            : (int) $user['location_age_seconds'];
        $freshness = $age === null
            ? 'stale'
            : ($age < 60 ? 'fresh' : ($age <= 300 ? 'delayed' : 'stale'));

        $results[] = [
            'id'           => $user['id'],
            'name'         => $user['name'],
            'entity_type'  => $user['entity_type'],
            'lat'          => $user['latitude'] === null ? null : (float)$user['latitude'],
            'lng'          => $user['longitude'] === null ? null : (float)$user['longitude'],
            'accuracy'     => $user['accuracy'] === null ? null : (float)$user['accuracy'],
            'is_online'    => 1,
            'is_speaking'  => (int)$user['is_speaking'],
            'has_location' => (bool)$user['has_location'],
            'freshness'    => $freshness,
            'is_stale'     => $freshness === 'stale',
            'location_age_seconds' => $age,
            'location_updated_at' => $user['location_updated_at'],
            'channel_name' => $user['channel_name'] ?? 'Standby',
            'updated_at'   => $user['updated_at']
        ];
    }

    header('Content-Type: application/json');
    echo json_encode($results);

} catch (PDOException $e) {
    header('Content-Type: application/json', true, 500);
    echo json_encode([
        'error' => 'Database Sync Failed',
        'details' => am2_safe_error($e, 'get-users-ajax')
    ]);
}
?>
