<?php
require_once __DIR__ . '/session_boot.php';
am2_session_boot();
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
 * Each comes in a per-category form too (`since_ptt`, `before_adm`), which is
 * what the page sends: the two tables are limited separately, so one mark for
 * both loses rows from whichever is quieter. See the block above $sinceShared.
 *
 * The two directions are mutually exclusive: asking for both would describe a
 * window this endpoint has no reason to serve, and `since` is what a poll sends.
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

/*
 * One watermark per category, because the two come from separate tables that
 * are limited separately.
 *
 * A single watermark shared by both is what silently dropped rows. Each query
 * takes the newest AM2_LOG_FETCH rows in its own window; if PTT is busy and ADM
 * is quiet, the two answers end at different times. Advancing one shared
 * watermark to the newer of them steps over every row the other table had
 * between the two -- and nothing ever asks for them again, because the
 * watermark only moves forward. In an audit console that is a gap no one can
 * see.
 *
 * The bare `since`/`before` are still accepted and fill both, so a bookmarked
 * URL still works and the fresh-start case stays one parameter.
 */
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

// Mutually exclusive per category: a poll sends `since`, paging sends `before`,
// and a request carrying both would describe a window this endpoint has no
// reason to serve.
$polling = $since['ptt'] !== '' || $since['adm'] !== '';
if ($polling) {
    $before = ['ptt' => '', 'adm' => ''];
}
/*
 * A request carrying any `before` is paging, and a category it does not mention
 * is one the caller has already read to the end. Without this that silence
 * would read as "start fresh" and the newest hundred rows would be sent back
 * for a category that asked for nothing.
 */
$paging = !$polling && ($before['ptt'] !== '' || $before['adm'] !== '');

/** Rows per category per request. Twenty on screen, so a hundred is five pages. */
const AM2_LOG_FETCH = 100;

/**
 * Where one category's answer starts and ends, and whether it was cut short.
 *
 * Per category, never across both. Taking min() across the two tails was the
 * bug in the paging direction: when PTT and ADM both fill their limit and end
 * at different times, the older tail becomes the next `before`, and every row
 * the other table held between the two tails is skipped for good. The caller
 * now pages each category by its own tail, so neither can step over the other.
 *
 * `more` says the query hit its limit, so there is certainly another page. The
 * caller uses it to keep paging, and -- while polling -- to come back at once
 * instead of waiting out the interval on a backlog.
 */
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

    /*
     * Bound, never interpolated: these arrive from the query string. A
     * timestamp that does not parse makes the comparison false rather than
     * breaking the statement, so a malformed watermark returns nothing new
     * instead of an error page.
     *
     * Order follows direction. Polling reads oldest-first: when more than a
     * page has arrived since the watermark, ASC returns the oldest of the
     * backlog, so the watermark advances to a row with nothing unseen behind
     * it and the next poll continues from there. DESC would return the newest
     * page and strand everything under it. Paging backwards keeps DESC, which
     * is already contiguous in its own direction.
     */
    $ptt_window = $adm_window = '';
    $ptt_order  = $adm_order  = 'DESC';
    if ($polling) {
        if ($since['ptt'] !== '') { $ptt_window = ' AND l.event_time > :since_ptt'; $ptt_order = 'ASC'; }
        if ($since['adm'] !== '') { $adm_window = ' AND a.waktu > :since_adm';      $adm_order = 'ASC'; }
    } else {
        if ($before['ptt'] !== '') $ptt_window = ' AND l.event_time < :before_ptt';
        if ($before['adm'] !== '') $adm_window = ' AND a.waktu < :before_adm';
    }

    // A category left out of a paging request is finished, not starting over.
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
    if ($polling && !$ptt_logs && !$adm_logs) {
        http_response_code(204);
        exit;
    }

    header('Content-Type: application/json');
    echo json_encode([
        'ptt' => $ptt_logs,
        'adm' => $adm_logs,
        /*
         * Where each category starts, ends, and whether it was cut short, so
         * the caller can advance one without stepping over the other.
         *
         * This replaces a single `oldest` and a single `complete`. `complete`
         * meant "neither query filled its limit", which is true of essentially
         * every poll -- they return a row or two -- so the client, which read
         * it on every response rather than only while paging, switched off
         * "load older" the first time anything happened.
         */
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
