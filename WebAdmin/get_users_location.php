<?php
session_start();
require_once 'config.php';
am2_api_auth();

if (ob_get_length()) ob_clean();

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

/*
 * Who is asking, taken from the session.
 *
 * This is the endpoint livetrack.php polls, and it had no tenant filter at all
 * -- every branch admin saw every branch's units, by name, channel and live
 * coordinates, and so did anyone who could reach the host, because it required
 * no session either.
 *
 * The scope comes from the session and nowhere else: a caller that can name its
 * own admin_id can name somebody else's.
 */
if (empty($_SESSION['admin_logged_in'])) {
    header('Content-Type: application/json', true, 401);
    exit(json_encode(['error' => 'Unauthorized']));
}

$session_admin_id = $_SESSION['admin_id'] ?? null;
$scoped = strtolower((string) ($_SESSION['admin_role'] ?? '')) !== 'superadmin';

try {
    $sql = "SELECT
                u.id, 
                u.name, 
                u.latitude as lat, 
                u.longitude as lng, 
                u.accuracy, 
                u.status,
                u.updated_at,
                c.display_name as active_channel_name 
            FROM public.users u 
            LEFT JOIN public.channels c ON u.last_channel_id = c.id
            WHERE u.status = 'online' 
              AND u.latitude IS NOT NULL 
              AND u.latitude != 0";

    if ($scoped) {
        $sql .= " AND u.admin_id = :admin_id";
    }

    if ($search !== '') {
        $sql .= " AND (u.id::text ILIKE :s OR u.name ILIKE :s)";
    }

    $sql .= " ORDER BY u.updated_at DESC";

    $stmt = $pdo->prepare($sql);

    $params = [];
    if ($scoped)        $params['admin_id'] = $session_admin_id;
    if ($search !== '') $params['s'] = "%$search%";
    $stmt->execute($params);

    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $formattedUsers = array_map(function($user) {
        return [
            'id'           => $user['id'],
            'name'         => $user['name'],
            'lat'          => (float)$user['lat'],
            'lng'          => (float)$user['lng'],
            'accuracy'     => (float)$user['accuracy'],
            'status'       => $user['status'],
            'is_online'    => ($user['status'] === 'online'),
            'channel_name' => $user['active_channel_name'] ?? 'No Channel',
            'updated_at'   => $user['updated_at']
        ];
    }, $users);

    header('Content-Type: application/json');
    echo json_encode($formattedUsers);

} catch (PDOException $e) {
    header('Content-Type: application/json', true, 500);
    echo json_encode([
        'error' => 'Database Error',
        'message' => am2_safe_error($e, 'get_users_location')
    ]);
}
?>
