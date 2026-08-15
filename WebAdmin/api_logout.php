<?php
header('Content-Type: application/json');
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
require_once __DIR__ . '/config.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    exit(json_encode(['success' => false, 'message' => 'Method not allowed']));
}
if (empty($_SESSION['admin_logged_in'])) {
    http_response_code(401);
    exit(json_encode(['success' => false, 'message' => 'Unauthorized']));
}
am2_csrf_require();
$_SESSION = [];
if (ini_get('session.use_cookies')) {
    $params = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $params['path'] ?? '/', $params['domain'] ?? '',
        (bool) ($params['secure'] ?? false), (bool) ($params['httponly'] ?? true));
}
session_destroy();
echo json_encode(['success' => true]);
?>
