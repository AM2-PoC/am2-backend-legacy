<?php
session_start();
date_default_timezone_set('Asia/Jakarta');
require_once 'config.php';

if (!isset($_SESSION['admin_logged_in'])) {
    header('Content-Type: application/json');
    exit(json_encode(['error' => 'Unauthorized']));
}

$current_admin_id = $_SESSION['admin_id'];
$role_admin = strtolower($_SESSION['admin_role'] ?? '');

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    $where_ptt = ($role_admin === 'superadmin') ? "WHERE 1=1" : "WHERE u.admin_id = :admin_id";
    $sql_ptt = "SELECT l.id, l.event_type as aksi, to_char(l.event_time, 'HH24:MI:SS') as jam,
                to_char(l.event_time, 'DD/MM/YYYY') as tanggal,
                l.event_time as raw_time,
                COALESCE(c.display_name, 'P2P / System') as target,
                COALESCE(u.name, 'Unknown User') as pelaksana,
                u.id::text as pelaksana_id, 'PTT' as kategori
                FROM public.ptt_logs l
                LEFT JOIN public.users u ON l.user_id = u.id
                LEFT JOIN public.channels c ON l.channel_id = c.id
                $where_ptt ORDER BY l.event_time DESC LIMIT 100";

    $stmt_ptt = $pdo->prepare($sql_ptt);
    if($role_admin !== 'superadmin') $stmt_ptt->bindValue(':admin_id', $current_admin_id);
    $stmt_ptt->execute();
    $ptt_logs = $stmt_ptt->fetchAll(PDO::FETCH_ASSOC);

    $where_adm = ($role_admin === 'superadmin') ? "WHERE 1=1" : "WHERE a.admin_id = :admin_id";
    $sql_adm = "SELECT a.id, a.aksi, to_char(a.waktu, 'HH24:MI:SS') as jam,
                to_char(a.waktu, 'DD/MM/YYYY') as tanggal,
                a.waktu as raw_time,
                a.keterangan as target,
                COALESCE(adm.username, 'System/External') as pelaksana,
                a.admin_id::text as pelaksana_id, 'ADM' as kategori
                FROM public.admin_activity_logs a
                LEFT JOIN public.admin adm ON a.admin_id = adm.id
                $where_adm ORDER BY a.waktu DESC LIMIT 100";

    $stmt_adm = $pdo->prepare($sql_adm);
    if($role_admin !== 'superadmin') $stmt_adm->bindValue(':admin_id', $current_admin_id);
    $stmt_adm->execute();
    $adm_logs = $stmt_adm->fetchAll(PDO::FETCH_ASSOC);

    header('Content-Type: application/json');
    echo json_encode(['ptt' => $ptt_logs, 'adm' => $adm_logs]);

} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['error' => am2_safe_error($e, 'fetch_logs')]);
}
?>
