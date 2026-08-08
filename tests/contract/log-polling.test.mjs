/**
 * What the Activity Log costs to keep open.
 *
 * The page polls every four seconds and the endpoint answers with the newest
 * 100 rows of each category every time -- measured at 46KB a response, which is
 * 39.5MB an hour for one tab left open, to deliver the nought or one row that
 * actually changed. A dispatch console is left open all shift, on several
 * screens.
 *
 * Two separate things are checked here: that the endpoint can answer "nothing
 * new" cheaply, and that the client stops asking when nobody is looking.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const read = (p) => readFileSync(join(WEBADMIN, p), 'utf8');
const endpoint = read('fetch_logs.php');
const pageSrc = read('logs.php');

test('the endpoint accepts a watermark, so a poll can ask only for what is new', () => {
    assert.match(endpoint, /\$_GET\[['"]since/,
        'fetch_logs.php takes no `since` parameter, so every poll re-sends rows the client already has');
});

test('the watermark is bound as a parameter, not pasted into the SQL', () => {
    // It arrives from the query string. The rest of this file parameterises
    // its admin scoping already; a watermark spliced into the statement would
    // be the one place it did not.
    const spliced = endpoint.match(/(?:>|>=|<)\s*['"]?\s*\{?\$(?:since|_GET)/);
    assert.equal(spliced, null,
        `the watermark is interpolated into SQL: ${spliced?.[0]}`);
    assert.match(endpoint, /bindValue\(\s*['"]:since|:since_\w+/,
        'nothing binds a :since placeholder');
});

test('nothing new is answered without a body', () => {
    // 204 is the whole point: a poll that finds no new rows should cost the
    // headers and nothing else.
    assert.match(endpoint, /http_response_code\(\s*204\s*\)/,
        'the endpoint has no empty-result path, so "nothing changed" still ships every row');
});

test('the watermark keeps sub-second precision', () => {
    // strtotime() returns whole seconds, so a watermark round-tripped through
    // it lands on .000000. The comparison is strictly greater-than, so every
    // poll then re-sent every row from that same second -- measured: three
    // consecutive polls each returned the same 891 bytes instead of 204.
    // Comments stripped first: this file explains why strtotime is wrong, and
    // an explanation of a mistake is not the mistake.
    const code = endpoint.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /strtotime\s*\(/,
        'the watermark is parsed with strtotime, which truncates to the second and '
        + 'makes each poll re-send the rows it just delivered');
    assert.match(endpoint, /H:i:s\.u/,
        'the watermark is not formatted with microseconds, so it cannot address a single row');
});

test('a malformed watermark starts from the newest rows rather than erroring', () => {
    // Binding stops it reaching the SQL parser, but a bound value that is not a
    // timestamp still aborts the statement -- so a stale bookmark produced a
    // system error where the honest answer is to start over.
    assert.match(endpoint, /try\s*\{[\s\S]*DateTimeImmutable[\s\S]*catch/,
        'the timestamp is not validated before it reaches the database');
});

test('the endpoint can be asked for older rows, so the log is not capped at 200', () => {
    assert.match(endpoint, /\$_GET\[['"]before/,
        'fetch_logs.php takes no `before` parameter, so nothing beyond the newest 100 per '
        + 'category is reachable at all');
});

test('the page keeps a watermark and sends it', () => {
    assert.match(pageSrc, /since=/, 'logs.php never sends a watermark, so the endpoint cannot answer cheaply');
});

test('a poll that returns nothing new leaves the rendered rows alone', () => {
    // Re-rendering on an empty response would throw away scroll position and
    // any row the reader was looking at, for no new information.
    assert.match(pageSrc, /=== 204|status === 204|\.status\s*===\s*204/,
        'the page does not recognise a 204, so an empty poll still re-renders the table');
});

test('polling stops when the tab is hidden', () => {
    // The shell already does this for its own status poll. The log page, which
    // is the expensive one, did not.
    assert.match(pageSrc, /visibilitychange/,
        'the log page polls at the same rate in a hidden tab as in a visible one');
});

test('the interval backs off when nothing is happening, and recovers when it is', () => {
    // A fixed four seconds is right during an incident and wasteful at 3am.
    assert.match(pageSrc, /\bMIN_EVERY\b|\bMAX_EVERY\b|backoff/i,
        'the poll interval is fixed, so a quiet console costs the same as a busy one');
    const max = pageSrc.match(/MAX_EVERY\s*=\s*(\d+)/);
    assert.ok(max, 'no upper bound on the backoff');
    assert.ok(Number(max[1]) >= 15000,
        `the backoff tops out at ${max[1]}ms, which barely reduces anything`);
});

test('the log page still constructs every row without innerHTML', () => {
    assert.doesNotMatch(pageSrc, /\binnerHTML\s*=/,
        'log rows carry admin-typed free text; innerHTML makes that an injection point');
});

test('the ids the polling loop writes into are unchanged', () => {
    for (const id of ['log-table-body', 'logSearchInput', 'last-update-time',
                      'logPager', 'logCount', 'logEmpty', 'logStale']) {
        assert.match(pageSrc, new RegExp(`['"\`]${id}['"\`]|id="${id}"`), `#${id} is gone`);
    }
});
