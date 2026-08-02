<?php
header('Content-Type: application/json');
require_once 'config.php';

$current_admin_id = $_GET['admin_id'] ?? $_POST['admin_id'] ?? null;
$admin_role = $_GET['role'] ?? $_POST['role'] ?? 'admin';

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    if ($admin_role === 'superadmin') {
        $query = "
            SELECT 
                TO_CHAR(series.jam, 'HH24:00') as jam,
                COUNT(l.id) as total
            FROM (
                SELECT generate_series(NOW() - INTERVAL '23 hours', NOW(), '1 hour') as jam
            ) series
            LEFT JOIN public.ptt_logs l ON TO_CHAR(l.event_time, 'HH24:00') = TO_CHAR(series.jam, 'HH24:00')
                 AND l.event_time > NOW() - INTERVAL '24 hours'
            GROUP BY series.jam
            ORDER BY series.jam ASC
        ";
        $stmt = $pdo->query($query);
    } else {
        $query = "
            SELECT 
                TO_CHAR(series.jam, 'HH24:00') as jam,
                COUNT(l.id) as total
            FROM (
                SELECT generate_series(NOW() - INTERVAL '23 hours', NOW(), '1 hour') as jam
            ) series
            LEFT JOIN public.ptt_logs l ON TO_CHAR(l.event_time, 'HH24:00') = TO_CHAR(series.jam, 'HH24:00')
                 AND l.event_time > NOW() - INTERVAL '24 hours'
            LEFT JOIN public.users u ON l.user_id = u.id AND u.admin_id = :admin_id
            GROUP BY series.jam
            ORDER BY series.jam ASC
        ";
        $stmt = $pdo->prepare($query);
        $stmt->execute(['admin_id' => $current_admin_id]);
    }

    $ptt_activity = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $labels = array_column($ptt_activity, 'jam');
    $values = array_map('intval', array_column($ptt_activity, 'total'));

    echo json_encode([
        'labels' => $labels,
        'values' => $values,
        'status' => 'success',
        'timestamp' => date('Y-m-d H:i:s')
    ]);

} catch (PDOException $e) {
    echo json_encode(['error' => $e->getMessage()]);
}
?>
