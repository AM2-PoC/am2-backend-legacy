<?php
header('Content-Type: application/json');
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
require_once __DIR__ . '/config.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    exit(json_encode(['success' => false, 'message' => 'Method not allowed']));
}

$username = trim((string) ($_POST['username'] ?? ''));
$password = (string) ($_POST['password'] ?? '');
$client = am2_client_ip() . '|' . $username;

try {
    if (am2_login_blocked($client)) {
        http_response_code(429);
        exit(json_encode(['success' => false, 'message' => 'Terlalu banyak percobaan login. Coba lagi nanti.']));
    }

    $stmt = $pdo->prepare("SELECT id, username, password_hash, role, status FROM public.admin WHERE username = ?");
    $stmt->execute([$username]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user || !password_verify($password, $user['password_hash'])) {
        am2_login_failed($client);
        http_response_code(401);
        exit(json_encode(['success' => false, 'message' => 'Username atau Password salah.']));
    }
    if ($user['status'] !== 'active') {
        http_response_code(403);
        exit(json_encode(['success' => false, 'message' => 'Akun Anda sedang dinonaktifkan.']));
    }

    am2_session_login();
    am2_login_succeeded($client);
    $_SESSION['admin_logged_in'] = true;
    $_SESSION['last_seen'] = time();
    $_SESSION['admin_id'] = (int) $user['id'];
    $_SESSION['admin_username'] = $user['username'];
    $_SESSION['admin_role'] = $user['role'];

    echo json_encode([
        'success' => true,
        'message' => 'Login Berhasil',
        'admin_id' => (int) $user['id'],
        'username' => $user['username'],
        'role' => $user['role'],
        'csrf_token' => am2_csrf_token(),
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => am2_safe_error($e, 'api_login')]);
}
?>
