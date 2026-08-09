<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();

$current_admin_id = $_GET['admin_id'] ?? $_POST['admin_id'] ?? null;
$admin_role = $_GET['role'] ?? $_POST['role'] ?? 'admin';
// 24h buckets by hour, 7d buckets by day. Anything else falls back to 24h
// rather than erroring, so a stale bookmark still renders.
$range = ($_GET['range'] ?? '24h') === '7d' ? '7d' : '24h';
$bucket   = $range === '7d' ? "TO_CHAR(series.jam, 'DD/MM')" : "TO_CHAR(series.jam, 'HH24:00')";
$stepExpr = $range === '7d'
    ? "generate_series(date_trunc('day', NOW()) - INTERVAL '6 days', date_trunc('day', NOW()), '1 day')"
    : "generate_series(NOW() - INTERVAL '23 hours', NOW(), '1 hour')";
$matchExpr = $range === '7d'
    ? "date_trunc('day', l.event_time) = series.jam"
    : "TO_CHAR(l.event_time, 'HH24:00') = TO_CHAR(series.jam, 'HH24:00')";
$window = $range === '7d' ? "7 days" : "24 hours";

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    if ($admin_role !== 'superadmin' && $current_admin_id === null) {
        // Without an admin_id there is no branch to scope to. Answering with
        // the global figure is what made this leak in the first place.
        echo json_encode(['error' => 'admin_id is required']);
        exit;
    }

    if ($admin_role === 'superadmin') {
        $query = "
            SELECT
                {$bucket} as jam,
                COUNT(l.id) as total
            FROM (
                SELECT {$stepExpr} as jam
            ) series
            LEFT JOIN public.ptt_logs l ON {$matchExpr}
                 AND l.event_time > NOW() - INTERVAL '{$window}'
            GROUP BY series.jam
            ORDER BY series.jam ASC
        ";
        $stmt = $pdo->query($query);
    } else {
        $query = "
            SELECT
                {$bucket} as jam,
                COUNT(l.id) as total
            FROM (
                SELECT {$stepExpr} as jam
            ) series
            LEFT JOIN public.ptt_logs l ON {$matchExpr}
                 AND l.event_time > NOW() - INTERVAL '{$window}'
                 AND l.user_id IN (SELECT id FROM public.users WHERE admin_id = :admin_id)
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
    echo json_encode(['error' => am2_safe_error($e, 'api_dashboard_chart')]);
}
?>
