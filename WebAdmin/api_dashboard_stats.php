<?php
header('Content-Type: application/json');
require_once 'config.php';

$admin_id = $_GET['admin_id'] ?? null;
$admin_role = $_GET['role'] ?? 'admin';

try {
    if ($admin_role === 'superadmin') {
        $total_user = $pdo->query("SELECT COUNT(*) FROM public.users")->fetchColumn() ?: 0;
        $user_online = $pdo->query("SELECT COUNT(*) FROM public.users WHERE status = 'online'")->fetchColumn() ?: 0;
        $total_channel = $pdo->query("SELECT COUNT(*) FROM public.channels")->fetchColumn() ?: 0;
    } else {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ?");
        $stmt->execute([$admin_id]);
        $total_user = $stmt->fetchColumn() ?: 0;

        $stmt = $pdo->prepare("SELECT COUNT(*) FROM public.users WHERE admin_id = ? AND status = 'online'");
        $stmt->execute([$admin_id]);
        $user_online = $stmt->fetchColumn() ?: 0;

        $stmt = $pdo->prepare("
            SELECT COUNT(DISTINCT c.id)
            FROM public.channels c
            LEFT JOIN public.admin_managed_channels amc ON c.id = amc.channel_id
            WHERE c.created_by = ? OR amc.admin_id = ?
        ");
        $stmt->execute([$admin_id, $admin_id]);
        $total_channel = $stmt->fetchColumn() ?: 0;
    }

    echo json_encode([
        'total_user' => (int)$total_user,
        'user_online' => (int)$user_online,
        'total_channel' => (int)$total_channel
    ]);
} catch (PDOException $e) {
    echo json_encode(['error' => am2_safe_error($e, 'api_dashboard_stats')]);
}
?>
