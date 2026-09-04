<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
// config.php authenticates. This file used to repeat the check itself, which
// is how it came to disagree with the eleven api_*.php files about what
// authentication means.
require_once 'config.php';

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
                /*
                 * Who is transmitting, from the column the relay maintains.
                 *
                 * This was derived from the newest ptt_logs row inside a
                 * seven-second window, which meant a transmission stopped
                 * being shown as one at its eighth second. Over thirty days of
                 * real traffic that is 38.9% of transmissions -- the median is
                 * 4.4s, the 90th percentile 26.2s, the longest 899s. And the
                 * ordering below is by this value, so at second eight the unit
                 * also jumped out of the top of the list while being watched.
                 *
                 * users.is_speaking is set true on PUSH and false on RELEASE,
                 * on channel change, on disconnect and at relay start, so it is
                 * the live answer rather than an inference from a log. It also
                 * removes a per-row scan of a 122k-row table from a query that
                 * runs every three seconds for every open map.
                 */
                CASE WHEN u.is_speaking THEN 1 ELSE 0 END as is_speaking
            FROM public.users u 
            LEFT JOIN public.channels c ON u.current_channel = c.name
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
