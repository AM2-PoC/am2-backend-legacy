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
 * They are mutually exclusive: asking for both would describe a window this
 * endpoint has no reason to serve, and `since` is the one a poll sends.
 */
/**
 * A timestamp Postgres will accept, or '' if it is not one.
 *
 * Validated here rather than left to the database: binding is what stops the
 * value reaching the parser as SQL, but a bound value that is not a timestamp
 * still aborts the statement -- and a stale bookmark or a hand-edited URL then
 * produced "Terjadi kesalahan sistem" where the honest answer is simply to
 * start from the newest rows.
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

$since  = $stamp($_GET['since'] ?? '');
$before = $stamp($_GET['before'] ?? '');
if ($since !== '') {
    $before = '';
}

/** Rows per category per request. Twenty on screen, so a hundred is five pages. */
const AM2_LOG_FETCH = 100;

/**
 * The oldest raw_time in a response, or null if it is empty.
 *
 * The caller pages backwards by handing this back as `before`. Taken across
 * both categories because the page merges them into one list, so the older of
 * the two tails is where the next page has to start -- using either one alone
 * would silently skip rows from the other.
 */
function am2_log_oldest(array $ptt, array $adm): ?string
{
    $times = [];
    foreach ([$ptt, $adm] as $set) {
        foreach ($set as $row) {
            if (!empty($row['raw_time'])) $times[] = (string) $row['raw_time'];
        }
    }
    return $times ? min($times) : null;
}

try {
    $pdo->exec("SET TIME ZONE 'Asia/Jakarta'");

    // Bound, never interpolated: these arrive from the query string. A
    // timestamp that does not parse makes the comparison false rather than
    // breaking the statement, so a malformed watermark returns nothing new
    // instead of an error page.
    $bounds = [];
    if ($since !== '')  $bounds[] = 'since';
    if ($before !== '') $bounds[] = 'before';

    $ptt_window = '';
    $adm_window = '';
    if ($since !== '') {
        $ptt_window = ' AND l.event_time > :since_ptt';
        $adm_window = ' AND a.waktu > :since_adm';
    } elseif ($before !== '') {
        $ptt_window = ' AND l.event_time < :before_ptt';
        $adm_window = ' AND a.waktu < :before_adm';
    }

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
                $where_ptt $ptt_window ORDER BY l.event_time DESC LIMIT " . AM2_LOG_FETCH;

    $stmt_ptt = $pdo->prepare($sql_ptt);
    if($role_admin !== 'superadmin') $stmt_ptt->bindValue(':admin_id', $current_admin_id);
    if ($since !== '')  $stmt_ptt->bindValue(':since_ptt', $since);
    if ($before !== '') $stmt_ptt->bindValue(':before_ptt', $before);
    $stmt_ptt->execute();
    $ptt_logs = $stmt_ptt->fetchAll(PDO::FETCH_ASSOC);

    $where_adm = ($role_admin === 'superadmin') ? "WHERE 1=1" : "WHERE a.admin_id = :admin_id";
    $sql_adm = "SELECT a.id, a.aksi, to_char(a.waktu, 'HH24:MI:SS') as jam,
                to_char(a.waktu, 'DD/MM/YYYY') as tanggal,
                a.waktu as raw_time,
                a.event_code, a.event_params, a.keterangan,
                COALESCE(adm.username, 'System/External') as pelaksana,
                a.admin_id::text as pelaksana_id, 'ADM' as kategori
                FROM public.admin_activity_logs a
                LEFT JOIN public.admin adm ON a.admin_id = adm.id
                $where_adm $adm_window ORDER BY a.waktu DESC LIMIT " . AM2_LOG_FETCH;

    $stmt_adm = $pdo->prepare($sql_adm);
    if($role_admin !== 'superadmin') $stmt_adm->bindValue(':admin_id', $current_admin_id);
    if ($since !== '')  $stmt_adm->bindValue(':since_adm', $since);
    if ($before !== '') $stmt_adm->bindValue(':before_adm', $before);
    $stmt_adm->execute();
    $adm_logs = $stmt_adm->fetchAll(PDO::FETCH_ASSOC);

    /*
     * The sentence is made here, in the language being read.
     *
     * `target` stays a plain string because that is what both readers of this
     * shape expect. Rows written before migration 002 have no code and render
     * from their keterangan, which is what that column is now for.
     */
    foreach ($adm_logs as &$row) {
        $row['target'] = am2_log_text($row['event_code'], $row['event_params'], $row['keterangan']);
        unset($row['event_code'], $row['event_params'], $row['keterangan']);
    }
    unset($row);

    /*
     * Nothing new: headers and no body.
     *
     * This is the answer to almost every poll -- the console is open all shift
     * and events arrive in bursts -- and it used to cost a full 46KB of rows
     * the caller already had. Only for a watermarked request: a caller with no
     * watermark is starting fresh, and an empty table is a legitimate empty
     * body it should be told about rather than left guessing.
     */
    if ($since !== '' && !$ptt_logs && !$adm_logs) {
        http_response_code(204);
        exit;
    }

    header('Content-Type: application/json');
    echo json_encode([
        'ptt' => $ptt_logs,
        'adm' => $adm_logs,
        // The oldest row in this response, so the caller can ask for the page
        // before it. Absent when there is nothing older to ask for.
        'oldest' => am2_log_oldest($ptt_logs, $adm_logs),
        'complete' => count($ptt_logs) < AM2_LOG_FETCH && count($adm_logs) < AM2_LOG_FETCH,
    ]);

} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['error' => am2_safe_error($e, 'fetch_logs')]);
}
?>
