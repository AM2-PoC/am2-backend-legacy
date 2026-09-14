// Every contract test must be either selected to run or provably disqualified.
//
// The selector globbed *.test.mjs only, so the two *.test.php contract files
// were invisible to it: never selected, never deliberately excluded, and so
// never run. One of them had been calling a function that was never written,
// and nothing said so for six days. The selector's own header states the
// failure mode -- a test that never runs looks exactly like a test that
// passes -- so this guard asserts the selector actually sees every extension
// present in the directory, not just the one it was written for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractDir = here;
const selector = path.join(here, '..', 'offline-tests.sh');

const selected = new Set(
    execFileSync(selector, { encoding: 'utf8' }).split('\n').filter(Boolean),
);

// Mirrors the selector's exclusions, per language. A .mjs suite is excluded
// only when it says so: it imports the credential helper (on any number of
// lines) or carries the offline-tests exclude marker. Guessing from text that
// looked networked kept offline suites out of CI.
//
// Built from pieces on purpose: the selector reads this file's text too.
const HELPERS_IMPORT = new RegExp(String.raw`^\s*(?:import|export)\s[^;'"]*?['"]\.\/` + 'help' + String.raw`ers\.mjs['"]`, 'm');
const EXCLUDE_MARKER = new RegExp('^\\s*//\\s*offline-' + 'tests:\\s*exclude', 'm');
const NETWORK_OR_CREDENTIAL = {
    '.mjs': { test: (body) => HELPERS_IMPORT.test(body) || EXCLUDE_MARKER.test(body) },
    '.php': /file_get_contents\(\s*['"]https?:|curl_\w+\(|fsockopen\(|fopen\(\s*['"]https?:|getenv\(/,
};

// The exclude marker is a declaration, and every declaration is listed here, so
// adding one is a visible diff rather than a suite quietly leaving CI. The
// selector's own rules cannot catch an overused marker: they are the marker.
const MARKED_FOR_EXCLUSION = ['relay-watchdog.test.mjs'];

test('only the listed suites declare themselves excluded from the offline job', () => {
    const marked = readdirSync(contractDir)
        .filter((name) => name.endsWith('.test.mjs'))
        .filter((name) => EXCLUDE_MARKER.test(readFileSync(path.join(contractDir, name), 'utf8')))
        .sort();
    assert.deepEqual(marked, MARKED_FOR_EXCLUSION,
        'a suite declares the offline-tests exclude marker without being listed');
});

test('no contract test is invisible to the offline selector', () => {
    const invisible = [];
    for (const name of readdirSync(contractDir)) {
        const ext = path.extname(name);
        if (!/\.test\.[a-z]+$/.test(name) || !(ext in NETWORK_OR_CREDENTIAL)) continue;
        const body = readFileSync(path.join(contractDir, name), 'utf8');
        const disqualified = NETWORK_OR_CREDENTIAL[ext].test(body);
        if (!disqualified && !selected.has(name)) invisible.push(name);
    }
    assert.deepEqual(
        invisible,
        [],
        `offline tests the selector never emits: ${invisible.join(', ')}`,
    );
});

// The disqualifier used to be a text match, so a fixture string -- or a comment
// -- that spelled a URL scheme excluded a suite that needs no network at all.
// promotion-gate.test.mjs stubs curl and named a fixture origin with a scheme,
// and every production promotion gate test in it went unrun in CI, including a
// rehearsal assertion that therefore could not fail. (This comment first named
// the scheme itself and disqualified this file the same way.) These suites are
// offline by construction and must stay selected.
const MUST_RUN_OFFLINE = [
    // Listed for the record; this entry cannot fail if the guard drops out,
    // which is why source-checks.yml also refuses a selection without it.
    'offline-selector-coverage.test.mjs',
    'ci-selector-guard.test.mjs',
    'offline-selector.test.mjs',
    'promotion-gate.test.mjs',
    'release-assets.test.mjs',
    'edge-parity.test.mjs',
];

test('offline-by-construction suites are selected, not disqualified by fixture text', () => {
    const missing = MUST_RUN_OFFLINE.filter((name) => !selected.has(name));
    assert.deepEqual(missing, [],
        `suites that must run in CI are not selected: ${missing.join(', ')}`);
});
