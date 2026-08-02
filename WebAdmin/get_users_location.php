<?php
require_once 'config.php';

if (ob_get_length()) ob_clean();

$search = isset($_GET['search']) ? trim($_GET['search']) : '';

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

    if ($search !== '') {
        $sql .= " AND (u.id::text ILIKE :s OR u.name ILIKE :s)";
    }

    $sql .= " ORDER BY u.updated_at DESC";

    $stmt = $pdo->prepare($sql);

    if ($search !== '') {
        $stmt->execute(['s' => "%$search%"]);
    } else {
        $stmt->execute();
    }

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
        'message' => $e->getMessage()
    ]);
}
?>
