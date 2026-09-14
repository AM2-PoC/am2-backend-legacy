import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const selector = fileURLToPath(new URL('../offline-tests.sh', import.meta.url));

/*
 * The selector reads every contract file's text, this one included. Fixture
 * fragments that would make a file look excluded -- a network call, a helpers
 * import, the exclusion marker -- are assembled from pieces so this suite is
 * not excluded by its own fixtures, which is how it went unrun before.
 */
const NETWORK_CALL = ['fe', 'tch(', "'htt", 'ps:', '//example.invalid', "');"].join('');
const HELPERS = ['./help', 'ers.mjs'].join('');
const MARKER = ['// offline-', 'tests: exclude'].join('');

function select(files) {
    const dir = mkdtempSync(join(tmpdir(), 'am2-offline-selector-'));
    try {
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
        const run = spawnSync('bash', [selector], {
            encoding: 'utf8',
            env: { ...process.env, OFFLINE_TEST_DIR: dir },
        });
        assert.equal(run.status, 0, run.stderr);
        return run.stdout.split('\n').filter(Boolean);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('network-looking text alone does not exclude a suite', () => {
    // Exclusion is declared, not guessed. A suite that stubs curl or builds a
    // URL string is offline; guessing from text kept the promotion gate suite
    // out of CI for its whole life.
    const selected = select({ 'looks-networked.test.mjs': `const call = "${NETWORK_CALL}";\n` });
    assert.deepEqual(selected, ['looks-networked.test.mjs']);
});

test('a helpers import excludes a suite even when it spans lines', () => {
    const selected = select({
        'credential.test.mjs': `import {\n    asSuper,\n    sql,\n} from '${HELPERS}';\n`,
        'plain.test.mjs': 'const value = 1;\n',
    });
    assert.deepEqual(selected, ['plain.test.mjs']);
});

test('a bare or re-exporting helpers import also excludes a suite', () => {
    const selected = select({
        'bare.test.mjs': `import '${HELPERS}';\n`,
        'reexport.test.mjs': `export { sql } from '${HELPERS}';\n`,
        'plain.test.mjs': 'const value = 1;\n',
    });
    assert.deepEqual(selected, ['plain.test.mjs']);
});

test('a helpers mention after an unterminated import does not exclude a suite', () => {
    // Semicolon-less code: the import pattern has to end at its own specifier,
    // not run on to a later line that only mentions the helper. Overrunning
    // there would exclude an offline suite silently.
    const selected = select({
        'semicolonless.test.mjs': `import test from 'node:test'\n// values come from '${HELPERS}'\nconst value = 1\n`,
    });
    assert.deepEqual(selected, ['semicolonless.test.mjs']);
});

test('an explicit marker excludes a suite', () => {
    const selected = select({
        'restart-job.test.mjs': `${MARKER} -- run by the restart-safety job\nconst value = 1;\n`,
        'plain.test.mjs': 'const value = 1;\n',
    });
    assert.deepEqual(selected, ['plain.test.mjs']);
});

test('offline selector excludes a large marked test without a pipefail race', () => {
    // Put the exclusion first and enough output after it to overflow a pipe.
    // With `sed | grep -q` under pipefail, grep exits at the first match and sed
    // can receive SIGPIPE; the failed pipeline then wrongly selects the file.
    const selected = select({
        'large-excluded.test.mjs': `${MARKER}\n${NETWORK_CALL}\n` + 'const padding = 1;\n'.repeat(100000),
    });
    assert.deepEqual(selected, [], 'a large excluded test was incorrectly selected');
});
