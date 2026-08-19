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
const NETWORK_OR_CREDENTIAL = {
    '.mjs': /^\s*import .*['"]\.\/helpers\.mjs|fetch\(|https?:\/\/|new WebSocket/m,
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
