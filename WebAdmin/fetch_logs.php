<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
date_default_timezone_set('Asia/Jakarta');
// config.php authenticates. The private check this replaces answered an
// unauthenticated caller with HTTP 200 and an `error` field -- a refusal no
// status-reading client could see, which is the shape of bug that had Admin
// Native reporting "Gagal memperbarui fitur" for an expired session.
require_once 'config.php';

$current_admin_id = $_SESSION['admin_id'];
$role_admin = strtolower($_SESSION['admin_role'] ?? '');

/**
 * How much of the log this request wants.
 *
 * `since` is a watermark: the newest event time the caller already holds. With
 * one, this answers only what has happened after it, which for a poll is
 * usually nothing at all. Without it, the caller is starting fresh and gets a
 * page of the newest rows.
 *
 * `before` is the other direction -- rows older than this one -- which is what
 * makes the log deeper than the newest 200 events. Both are timestamps rather
 * than ids, because the two categories come from separate tables whose ids are
 * independent, and the page merges them on time.
 *
 * Each comes in a per-category form too (`since_ptt`, `before_adm`), which is
 * what the page sends: the two tables are limited separately, so one mark for
 * both loses rows from whichever is quieter. See the block above $sinceShared.
 *
 * The two directions are mutually exclusive: asking for both would describe a
 * window this endpoint has no reason to serve, and `since` is what a poll sends.
 */

$stamp = static function ($raw): string {
    $v = trim((string) $raw);
    if ($v === '') return '';
    try {
        // DateTimeImmutable rather than strtotime(): strtotime returns a
        // second-resolution integer, which rounds a watermark down to .000000.
        // The comparison is strictly greater-than, so every poll then returned
        // the rows from that same second again -- the exact traffic this
        // parameter exists to avoid.
        return (new DateTimeImmutable($v))->format('Y-m-d H:i:s.u');
    } catch (Exception $e) {
        return '';
    }
};

$sinceShared  = $stamp($_GET['since'] ?? '');
$beforeShared = $stamp($_GET['before'] ?? '');

$since  = [
    'ptt' => $stamp($_GET['since_ptt'] ?? '') ?: $sinceShared,
    'adm' => $stamp($_GET['since_adm'] ?? '') ?: $sinceShared,
];
$before = [
    'ptt' => $stamp($_GET['before_ptt'] ?? '') ?: $beforeShared,
    'adm' => $stamp($_GET['before_adm'] ?? '') ?: $beforeShared,
];

$polling = $since['ptt'] !== '' || $since['adm'] !== '';
if ($polling) {
    $before = ['ptt' => '', 'adm' => ''];
}

$paging = !$polling && ($before['ptt'] !== '' || $before['adm'] !== '');

const AM2_LOG_FETCH = 100;

function am2_log_bounds(array $rows): array
{
    $times = [];
    foreach ($rows as $row) {
        if (!empty($row['raw_time'])) $times[] = (string) $row['raw_time'];
    }
    return [
        'newest' => $times ? max($times) : null,
        'oldest' => $times ? min($times) : null,
        'more'   => count($rows) >= AM2_LOG_FETCH,
    ];
}

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    $ptt_window = $adm_window = '';
    $ptt_order  = $adm_order  = 'DESC';
    if ($polling) {
        if ($since['ptt'] !== '') { $ptt_window = ' AND l.event_time > :since_ptt'; $ptt_order = 'ASC'; }
        if ($since['adm'] !== '') { $adm_window = ' AND a.waktu > :since_adm';      $adm_order = 'ASC'; }
    } else {
        if ($before['ptt'] !== '') $ptt_window = ' AND l.event_time < :before_ptt';
        if ($before['adm'] !== '') $adm_window = ' AND a.waktu < :before_adm';
    }

    $skip_ptt = $paging && $before['ptt'] === '';
    $skip_adm = $paging && $before['adm'] === '';

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
                $where_ptt $ptt_window ORDER BY l.event_time $ptt_order LIMIT " . AM2_LOG_FETCH;

    $stmt_ptt = $pdo->prepare($sql_ptt);
    if($role_admin !== 'superadmin') $stmt_ptt->bindValue(':admin_id', $current_admin_id);
    if ($polling && $since['ptt'] !== '')   $stmt_ptt->bindValue(':since_ptt', $since['ptt']);
    if (!$polling && $before['ptt'] !== '') $stmt_ptt->bindValue(':before_ptt', $before['ptt']);
    $ptt_logs = [];
    if (!$skip_ptt) {
        $stmt_ptt->execute();
        $ptt_logs = $stmt_ptt->fetchAll(PDO::FETCH_ASSOC);
    }

    $where_adm = ($role_admin === 'superadmin') ? "WHERE 1=1" : "WHERE a.admin_id = :admin_id";
    $sql_adm = "SELECT a.id, a.aksi, to_char(a.waktu, 'HH24:MI:SS') as jam,
                to_char(a.waktu, 'DD/MM/YYYY') as tanggal,
                a.waktu as raw_time,
                a.event_code, a.event_params, a.keterangan,
                COALESCE(adm.username, 'System/External') as pelaksana,
                a.admin_id::text as pelaksana_id, 'ADM' as kategori
                FROM public.admin_activity_logs a
                LEFT JOIN public.admin adm ON a.admin_id = adm.id
                $where_adm $adm_window ORDER BY a.waktu $adm_order LIMIT " . AM2_LOG_FETCH;

    $stmt_adm = $pdo->prepare($sql_adm);
    if($role_admin !== 'superadmin') $stmt_adm->bindValue(':admin_id', $current_admin_id);
    if ($polling && $since['adm'] !== '')   $stmt_adm->bindValue(':since_adm', $since['adm']);
    if (!$polling && $before['adm'] !== '') $stmt_adm->bindValue(':before_adm', $before['adm']);
    $adm_logs = [];
    if (!$skip_adm) {
        $stmt_adm->execute();
        $adm_logs = $stmt_adm->fetchAll(PDO::FETCH_ASSOC);
    }

    foreach ($adm_logs as &$row) {
        $row['target'] = am2_log_text($row['event_code'], $row['event_params'], $row['keterangan']);
        unset($row['event_code'], $row['event_params'], $row['keterangan']);
    }
    unset($row);

    if ($polling && !$ptt_logs && !$adm_logs) {
        http_response_code(204);
        exit;
    }

    header('Content-Type: application/json');
    echo json_encode([
        'ptt' => $ptt_logs,
        'adm' => $adm_logs,

        'cursor' => [
            'ptt' => am2_log_bounds($ptt_logs),
            'adm' => am2_log_bounds($adm_logs),
        ],
    ]);

} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['error' => am2_safe_error($e, 'fetch_logs')]);
}
?>
