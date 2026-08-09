<?php
header('Content-Type: application/json');
require_once 'config.php';
am2_api_auth();

$category = $_GET['category'] ?? 'ALL';

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    $results = [];

    if ($category === 'ALL' || $category === 'PTT') {
        $sql_ptt = "SELECT l.id::text, to_char(l.event_time, 'HH24:MI:SS') as jam,
                    to_char(l.event_time, 'DD/MM/YYYY') as tanggal,
                    l.event_time::text as raw_time,
                    COALESCE(u.name, 'Unknown User') as pelaksana,
                    u.id::text as pelaksana_id,
                    COALESCE(c.display_name, 'P2P / System') as target,
                    l.event_type as aksi,
                    'PTT' as kategori
                    FROM public.ptt_logs l
                    LEFT JOIN public.users u ON l.user_id = u.id
                    LEFT JOIN public.channels c ON l.channel_id = c.id
                    ORDER BY l.event_time DESC LIMIT 50";
        $stmt = $pdo->query($sql_ptt);
        $results = array_merge($results, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    if ($category === 'ALL' || $category === 'ADM') {
        $sql_adm = "SELECT a.id::text, to_char(a.waktu, 'HH24:MI:SS') as jam,
                    to_char(a.waktu, 'DD/MM/YYYY') as tanggal,
                    a.waktu::text as raw_time,
                    COALESCE(adm.username, 'System') as pelaksana,
                    a.admin_id::text as pelaksana_id,
                    a.event_code, a.event_params, a.keterangan,
                    a.aksi,
                    'ADM' as kategori
                    FROM public.admin_activity_logs a
                    LEFT JOIN public.admin adm ON a.admin_id = adm.id
                    ORDER BY a.waktu DESC LIMIT 50";
        /*
         * Rendered server-side, so this endpoint's shape does not move.
         *
         * The Admin Native log screen reads `target` as a finished string and
         * `aksi` as the code it groups by. Both are exactly what they were:
         * the structure went into the database, not into this response.
         */
        $adm = $pdo->query($sql_adm)->fetchAll(PDO::FETCH_ASSOC);
        foreach ($adm as &$row) {
            $row['target'] = am2_log_text($row['event_code'], $row['event_params'], $row['keterangan']);
            unset($row['event_code'], $row['event_params'], $row['keterangan']);
        }
        unset($row);
        $results = array_merge($results, $adm);
    }

    if ($category === 'ALL') {
        usort($results, function($a, $b) {
            return strcmp($b['raw_time'], $a['raw_time']);
        });
        $results = array_slice($results, 0, 50);
    }

    echo json_encode($results);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => am2_safe_error($e, 'api_logs')]);
}
?>
