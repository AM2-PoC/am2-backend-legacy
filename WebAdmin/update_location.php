<?php
require_once 'config.php';
am2_api_auth();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('HTTP/1.1 405 Method Not Allowed');
    exit(json_encode(['status' => 'error', 'message' => 'Gunakan metode POST']));
}

$user_id  = $_POST['user_id'] ?? null;
$latitude  = $_POST['latitude'] ?? null;
$longitude = $_POST['longitude'] ?? null;
$accuracy  = $_POST['accuracy'] ?? 0;

if (!$user_id || !$latitude || !$longitude) {
    echo json_encode(['status' => 'error', 'message' => 'Data tidak lengkap']);
    exit;
}

try {
    $sql = "UPDATE public.users SET
                latitude = :lat, 
                longitude = :lng, 
                accuracy = :acc, 
                status = 'online', 
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = :id";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        'lat' => $latitude,
        'lng' => $longitude,
        'acc' => $accuracy,
        'id'  => $user_id
    ]);

    if ($stmt->rowCount() > 0) {
        echo json_encode([
            'status' => 'success',
            'message' => 'Lokasi diperbarui',
            'user' => $user_id
        ]);
    } else {
        echo json_encode([
            'status' => 'error',
            'message' => 'User ID tidak ditemukan di database'
        ]);
    }

} catch (PDOException $e) {
    header('HTTP/1.1 500 Internal Server Error');
    echo json_encode(['status' => 'error', 'message' => am2_safe_error($e, 'update_location')]);
}
?>
