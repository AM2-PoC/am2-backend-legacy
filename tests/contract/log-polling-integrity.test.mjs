/**
 * The log endpoint never loses a row.
 *
 * Three defects shipped in the delta-polling work, and all three were invisible
 * to a test that matches source text: a shared watermark across two separately
 * limited queries, a shared `before` taken as min() of two tails, and a
 * `complete` flag the client read on every response. Each one silently dropped
 * events from an audit console -- the failure mode where nothing looks wrong,
 * because the missing rows are missing from the screen too.
 *
 * So this file runs the real fetch_logs.php in a real PHP process against a
 * dataset it knows the whole of, drives it exactly as the page does, and
 * asserts on the set of rows that came back. A stub config.php stands in for
 * the database: the questions here are about windows, ordering and limits, not
 * about SQL execution, and a test that needs a database is a test that needs
 * credentials.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

/** Rows per category per request, as the endpoint defines it. */
const LIMIT = 100;

/**
 * A stub config.php: a PDO that answers from a fixture instead of connecting.
 *
 * It reads the same window the real query describes -- by looking at which
 * bound parameter arrived and which direction the SQL asked for -- so the
 * behaviour under test is the endpoint's own construction of that query, not a
 * re-implementation of it here.
 */
const STUB_CONFIG = `<?php
$FIXTURE = json_decode(file_get_contents(getenv('AM2_FIXTURE')), true);

class FakeStatement {
    public function __construct(private string $sql, private array $fixture) {}
    private array $bound = [];
    public function bindValue($k, $v, $t = null): bool { $this->bound[ltrim((string)$k, ':')] = $v; return true; }
    public function execute($params = null): bool { return true; }
    public function fetchAll($mode = null): array {
        $ptt = str_contains($this->sql, 'public.ptt_logs');
        $rows = $this->fixture[$ptt ? 'ptt' : 'adm'];
        $cat  = $ptt ? 'ptt' : 'adm';

        if (isset($this->bound["since_$cat"])) {
            $mark = $this->bound["since_$cat"];
            $rows = array_values(array_filter($rows, fn($r) => $r['raw_time'] > $mark));
        }
        if (isset($this->bound["before_$cat"])) {
            $mark = $this->bound["before_$cat"];
            $rows = array_values(array_filter($rows, fn($r) => $r['raw_time'] < $mark));
        }

        usort($rows, fn($a, $b) => $a['raw_time'] <=> $b['raw_time']);
        // The endpoint chooses the direction; honouring it is the whole point.
        if (!preg_match('/ORDER BY [a-z]+\\.[a-z_]+ ASC/i', $this->sql)) $rows = array_reverse($rows);
        if (preg_match('/LIMIT (\\d+)/', $this->sql, $m)) $rows = array_slice($rows, 0, (int) $m[1]);
        return $rows;
    }
}

class FakePDO {
    public function __construct(private array $fixture) {}
    public function exec($sql) { return 0; }
    public function prepare($sql, $options = []) { return new FakeStatement($sql, $this->fixture); }
}

$pdo = new FakePDO($FIXTURE);

/** The real one renders a sentence; these tests only care which rows arrive. */
function am2_log_text($code, $params, $keterangan) { return (string) ($code ?? $keterangan ?? ''); }
`;

/** A session file the endpoint's own session_start() will pick up. */
const SESSION = 'admin_logged_in|b:1;admin_id|s:4:"ADM1";admin_role|s:10:"superadmin";';

function makeWorkspace(fixture) {
    const dir = mkdtempSync(join(tmpdir(), 'am2-logs-'));
    writeFileSync(join(dir, 'config.php'), STUB_CONFIG);
    copyFileSync(join(WEBADMIN, 'fetch_logs.php'), join(dir, 'fetch_logs.php'));
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture));
    writeFileSync(join(dir, 'sess_am2contract'), SESSION);
    /*
     * The CLI fills neither $_GET nor the session cookie. Both are the web
     * server's job, and supplying them here is what lets the endpoint run
     * unmodified -- the alternative is a test-only branch inside fetch_logs.php,
     * which would make the tested code differ from the shipped code.
     */
    writeFileSync(join(dir, 'prepend.php'), `<?php
$_COOKIE[session_name()] = 'am2contract';
parse_str((string) getenv('QUERY_STRING'), $_GET);
`);
    return dir;
}

/** One request. Returns { status, body } exactly as the page would see it. */
function request(dir, params = {}) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const args = [
        '-d', `session.save_path=${dir}`,
        '-d', 'auto_prepend_file=prepend.php',
        '-d', 'error_reporting=E_ALL & ~E_DEPRECATED',
        'fetch_logs.php',
    ];
    let out;
    try {
        out = execFileSync('php', args, {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, AM2_FIXTURE: join(dir, 'fixture.json'), QUERY_STRING: qs },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        throw new Error(`php failed: ${String(err.stderr ?? '')}\n${String(err.stdout ?? '')}`);
    }
    const trimmed = out.trim();
    if (trimmed === '') return { status: 204, body: null };
    return { status: 200, body: JSON.parse(trimmed) };
}

/** `n` rows for one category, one millisecond apart, oldest first. */
function series(kategori, n, startMs = 0) {
    return Array.from({ length: n }, (_, i) => {
        const t = new Date(Date.UTC(2026, 0, 1) + (startMs + i) * 1000);
        return {
            id: `${kategori}-${i}`,
            kategori: kategori.toUpperCase(),
            raw_time: t.toISOString().replace('T', ' ').replace('Z', '').padEnd(26, '0'),
            aksi: 'X', jam: '00:00:00', tanggal: '01/01/2026',
            target: 't', pelaksana: 'p', pelaksana_id: 'ADM1',
            event_code: null, event_params: null, keterangan: 'k',
        };
    });
}

const idsOf = (body) => [...(body?.ptt ?? []), ...(body?.adm ?? [])].map((r) => r.id);

test('a backlog larger than one page is delivered whole, not just its newest page', () => {
    /*
     * The bug: the poll ordered DESC and took the newest LIMIT rows, then the
     * page advanced its watermark to the newest of them -- stepping over
     * everything underneath, permanently, because a watermark only moves
     * forward. A tab left hidden for an hour hit this every time, since polling
     * stops while the tab is hidden and resumes with an hour-old mark.
     */
    const total = LIMIT * 2 + 7;
    const dir = makeWorkspace({ ptt: series('ptt', total), adm: [] });
    try {
        const seen = new Set();
        let since = '1970-01-01 00:00:00.000000';
        for (let guard = 0; guard < 10; guard++) {
            const { status, body } = request(dir, { since_ptt: since, since_adm: since });
            if (status === 204) break;
            idsOf(body).forEach((id) => seen.add(id));
            if (!body.cursor.ptt.more) break;
            since = body.cursor.ptt.newest;
        }
        assert.equal(seen.size, total,
            `${total - seen.size} of ${total} rows were never delivered; a poll that `
            + 'advances past its own backlog loses the rows it skipped');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('paging backwards keeps every row when both categories fill their page', () => {
    /*
     * The bug: one `before` for both tables, taken as min() of the two tails.
     * With PTT and ADM ending at different times, the older tail became the
     * next request and every row the other table held between the two tails was
     * skipped for good. Interleaved timestamps are what make the two tails
     * differ, so the fixture interleaves them.
     */
    const ptt = series('ptt', LIMIT + 40, 0);
    const adm = series('adm', LIMIT + 40, 0).map((r, i) => ({
        ...r,
        // Half a second off, so the two categories' tails never coincide.
        raw_time: r.raw_time.replace('.000000', '.500000'),
        id: `adm-${i}`,
    }));
    const dir = makeWorkspace({ ptt, adm });
    try {
        const seen = new Set();
        let { body } = request(dir);                   // fresh load, newest page
        idsOf(body).forEach((id) => seen.add(id));
        let cursor = body.cursor;

        for (let guard = 0; guard < 10; guard++) {
            if (!cursor.ptt.more && !cursor.adm.more) break;
            const params = {};
            if (cursor.ptt.more) params.before_ptt = cursor.ptt.oldest;
            if (cursor.adm.more) params.before_adm = cursor.adm.oldest;
            const res = request(dir, params);
            if (res.status === 204) break;
            idsOf(res.body).forEach((id) => seen.add(id));
            // A category not asked for this round keeps its own state.
            cursor = {
                ptt: cursor.ptt.more ? res.body.cursor.ptt : cursor.ptt,
                adm: cursor.adm.more ? res.body.cursor.adm : cursor.adm,
            };
        }

        assert.equal(seen.size, ptt.length + adm.length,
            `${ptt.length + adm.length - seen.size} rows were skipped while paging; `
            + 'one shared tail across two separately limited queries loses the gap between them');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a category already read to the end is not sent again', () => {
    // The other half of per-category paging: a request that names only one
    // category must not be read as a fresh start for the other, or the newest
    // hundred rows come back for a category that asked for nothing.
    const dir = makeWorkspace({ ptt: series('ptt', 10), adm: series('adm', 10) });
    try {
        const { body } = request(dir, { before_ptt: '2026-01-01 00:00:05.000000' });
        assert.equal((body.adm ?? []).length, 0,
            'a paging request re-sent a category it did not ask about');
        assert.ok((body.ptt ?? []).length > 0, 'the category that was asked for returned nothing');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('nothing new is 204, and only for a request that already holds something', () => {
    const dir = makeWorkspace({ ptt: series('ptt', 3), adm: [] });
    try {
        const poll = request(dir, { since_ptt: '2030-01-01 00:00:00.000000',
                                    since_adm: '2030-01-01 00:00:00.000000' });
        assert.equal(poll.status, 204, 'a poll with nothing new still sent a body');

        // A caller with no watermark is starting fresh; an empty table is a
        // legitimate empty body it should be told about rather than left
        // guessing at.
        const fresh = request(makeWorkspace({ ptt: [], adm: [] }));
        assert.equal(fresh.status, 200, 'a fresh start against an empty log answered 204');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('polling never reports on how deep the log is', () => {
    /*
     * The bug this replaces: the response carried one `complete` meaning
     * "neither query filled its page", which is true of essentially every poll,
     * and the page read it on every response rather than only while paging. So
     * the first event to arrive switched off "load older" permanently -- about
     * four seconds after the page opened.
     *
     * The shape now makes that mistake unavailable: `more` is per category and
     * describes the direction that was actually asked for.
     */
    const dir = makeWorkspace({ ptt: series('ptt', 5), adm: [] });
    try {
        const { body } = request(dir, { since_ptt: '2026-01-01 00:00:00.000000',
                                        since_adm: '2026-01-01 00:00:00.000000' });
        assert.ok(body.cursor, 'the response carries no cursor');
        assert.equal(body.complete, undefined,
            'the single `complete` flag is back; a poll reporting on paging depth '
            + 'is what disabled "load older" after the first event');
        for (const cat of ['ptt', 'adm']) {
            assert.ok(Object.hasOwn(body.cursor[cat], 'more'),
                `the ${cat} cursor does not say whether more rows exist`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a malformed watermark starts from the newest rows instead of erroring', () => {
    const dir = makeWorkspace({ ptt: series('ptt', 5), adm: [] });
    try {
        const { status, body } = request(dir, { since_ptt: 'not-a-timestamp' });
        assert.equal(status, 200, 'a hand-edited watermark produced no body');
        assert.equal(body.error, undefined, `a malformed watermark errored: ${body.error}`);
        assert.equal((body.ptt ?? []).length, 5,
            'a malformed watermark should fall back to a fresh page, not an empty one');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the watermark keeps microsecond resolution', () => {
    // strtotime() rounds to the second, and the comparison is strictly
    // greater-than, so a rounded-down watermark re-sent every row from that
    // same second on every poll -- the exact traffic the parameter exists to
    // avoid. Asserted through behaviour: two rows inside one second.
    const rows = series('ptt', 1);
    rows.push({ ...rows[0], id: 'ptt-1', raw_time: rows[0].raw_time.replace('.000000', '.500000') });
    const dir = makeWorkspace({ ptt: rows, adm: [] });
    try {
        const { body } = request(dir, { since_ptt: rows[0].raw_time });
        assert.deepEqual((body?.ptt ?? []).map((r) => r.id), ['ptt-1'],
            'a watermark inside a second either re-sent the row it already held '
            + 'or skipped the one after it');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
