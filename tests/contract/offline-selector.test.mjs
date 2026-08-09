import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const selector = resolve('tests/offline-tests.sh');

test('offline selector rejects a large network-bound test without a pipefail race', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am2-offline-selector-'));
    try {
        // Put the match first and enough output after it to overflow a pipe. With
        // `sed | grep -q` under pipefail, grep exits at the first match and sed can
        // receive SIGPIPE; the failed pipeline then incorrectly selects this file.
        writeFileSync(join(dir, 'large-network.test.mjs'),
            "fetch('https://example.invalid');\n" + 'const padding = 1;\n'.repeat(100000));
        const run = spawnSync('bash', [selector], {
            encoding: 'utf8',
            env: { ...process.env, OFFLINE_TEST_DIR: dir },
        });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout, '', 'network-bound test was incorrectly selected');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
