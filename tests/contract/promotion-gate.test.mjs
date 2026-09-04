// The gates between a release and production, written down and sequenced.
//
// On 2026-09-04 at 11:29:06 a release was promoted to production with none of
// them: no staging acceptance, no rollback target recorded, no smoke against
// the production environment, no separate approval. It was not the cause of the
// deletion six minutes later -- the vulnerability predated it -- but the gates
// existed on paper and were skipped, which is the only interesting fact about
// them.
//
// Later the same day the same gates were run correctly, by hand, one command at
// a time. That is the failure mode this file exists to end: a sequence that
// lives in a runbook and in whoever happens to be doing it. The steps were
// already scripted individually; what was missing was something that refuses to
// continue when one of them fails.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const GATE = 'infra/scripts/promote-to-production.sh';

describe('production promotion gate', () => {
    test('the gate exists and is runnable', () => {
        assert.ok(existsSync(join(ROOT, GATE)), `${GATE} does not exist`);
        assert.ok(statSync(join(ROOT, GATE)).mode & 0o111, `${GATE} is not executable`);
    });

    test('it runs every step that was skipped on 11:29, in order', () => {
        const s = read(GATE);
        // Named individually rather than counted, because "some checks ran" is
        // exactly what a skipped gate looks like from the outside.
        for (const step of ['verify-release-runtime.sh', 'smoke-release.sh',
                            'verify-webadmin-guard.sh']) {
            assert.ok(s.includes(step), `the gate never runs ${step}`);
        }
        const order = ['verify-release-runtime.sh', 'smoke-release.sh'];
        assert.ok(s.indexOf(order[0]) < s.indexOf(order[1]),
            'the release is smoked before it is verified');
    });

    test('the rollback target is verified too, not just recorded', () => {
        // Writing down what to roll back to proves nothing if that release can
        // no longer start. Both were checked by hand today; the gate has to do
        // it or the rollback is a hope rather than a plan.
        const s = read(GATE);
        assert.match(s, /rollback/i);
        assert.match(s, /verify-release-runtime\.sh[^\n]*\$\{?(old|rollback|previous)/i,
            'the rollback target is never verified, only named');
    });

    test('it refuses to continue when a gate fails', () => {
        const s = read(GATE);
        assert.match(s, /set -euo pipefail/,
            'a failing gate would be stepped over rather than stopping the promotion');
        assert.doesNotMatch(s, /\|\|\s*true\s*$/m,
            'a gate result is discarded');
    });

    test('it will not promote a SHA that staging never ran', () => {
        /*
         * The gate that would have caught 11:29. Production took a release
         * built from a SHA that no staging release had ever been built from,
         * and nothing anywhere noticed.
         */
        const s = read(GATE);
        assert.match(s, /staging/,
            'the gate does not look at staging at all');
        assert.match(s, /\.release-sha/,
            'the gate cannot tell which SHA staging is running');
    });

    test('it records who promoted what, and when', () => {
        // The artifact-only plan asks for an immutable receipt naming actor,
        // source SHA and release. Today the only record that production moved
        // at 11:29 was the symlink's own mtime.
        const s = read(GATE);
        assert.match(s, /receipt|RECEIPT/,
            'a promotion leaves no record beyond a symlink mtime');
    });

    test('it is the runbook, so the runbook stops describing the steps twice', () => {
        const doc = read('docs/how-to/deploy-and-roll-back.md');
        assert.match(doc, /promote-to-production\.sh/,
            'the runbook still asks a person to sequence the gates by hand');
    });
});
