<?php
header('Content-Type: application/json');
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] == 'POST') {
    $username = $_POST['username'] ?? '';
    $password = $_POST['password'] ?? '';

    try {
        $stmt = $pdo->prepare("SELECT id, username, password_hash, role, status FROM public.admin WHERE username = ?");
        $stmt->execute([$username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($user && password_verify($password, $user['password_hash'])) {
            if ($user['status'] !== 'active') {
                echo json_encode(['success' => false, 'message' => 'Akun Anda sedang dinonaktifkan.']);
            } else {
                echo json_encode([
                    'success' => true,
                    'message' => 'Login Berhasil',
                    'admin_id' => (int)$user['id'],
                    'username' => $user['username'],
                    'role' => $user['role']
                ]);
            }
        } else {
            echo json_encode(['success' => false, 'message' => 'Username atau Password salah.']);
        }
    } catch (PDOException $e) {
        echo json_encode(['success' => false, 'message' => 'Kesalahan sistem: ' . am2_safe_error($e, 'api_login')]);
    }
} else {
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
}
?>
