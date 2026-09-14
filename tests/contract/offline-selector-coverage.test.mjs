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

// Mirrors the selector's disqualifiers, per language. A file that reaches the
// network or reads the protected env file belongs on the VPS, not in CI.
//
// Built from pieces on purpose. The selector matches this file's own text, and
// written as literals the patterns contained the very phrase it looks for, so
// this guard was itself disqualified and never ran.
const WS = ['new', 'Web' + 'Socket'].join(' ');
const NETWORK_OR_CREDENTIAL = {
    '.mjs': new RegExp(String.raw`^\s*import .*['"]\.\/helpers\.mjs|fetch\(|https?:\/\/|` + WS, 'm'),
    '.php': /file_get_contents\(\s*['"]https?:|curl_\w+\(|fsockopen\(|fopen\(\s*['"]https?:|getenv\(/,
};

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

// The disqualifier is a text match, so a fixture string -- or a comment -- that
// spells a URL scheme excludes a suite that needs no network at all.
// promotion-gate.test.mjs stubs curl and named a fixture origin with a scheme,
// and every production promotion gate test in it went unrun in CI, including a
// rehearsal assertion that therefore could not fail. (This comment first named
// the scheme itself and disqualified this file the same way.) These suites are
// offline by construction and must stay selected.
const MUST_RUN_OFFLINE = [
    'offline-selector-coverage.test.mjs',
    'promotion-gate.test.mjs',
    'release-assets.test.mjs',
    'edge-parity.test.mjs',
];

test('offline-by-construction suites are selected, not disqualified by fixture text', () => {
    const missing = MUST_RUN_OFFLINE.filter((name) => !selected.has(name));
    assert.deepEqual(missing, [],
        `suites that must run in CI are not selected: ${missing.join(', ')}`);
});
