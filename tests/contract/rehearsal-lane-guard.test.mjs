/**
 * The staging rehearsal checks the candidate lane, not only the relay.
 *
 * The page-asset sweep lives in the candidate's verify-webadmin-guard.sh, and
 * only the production promotion gate ran it -- after cutover. The rehearsal
 * checked relay PID, cwd and HTTP, so a release whose pages load an asset the
 * artifact omits passed staging and was first caught on production, which is
 * how the live-track map shipped blank.
 *
 * This lives in its own file on purpose. The rehearsal assertions used to sit
 * in promotion-gate.test.mjs, which the offline selector never runs (it names a
 * fixture URL), so they could not fail in CI.
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
const rehearsal = readFileSync(join(ROOT, 'infra/scripts/rehearse-staging-artifact.sh'), 'utf8');

test('the rehearsal checks the candidate lane before rolling back', () => {
    assert.match(rehearsal,
        /candidate_pid=\$\(switch_and_restart "\$release"\)[\s\S]*?"\$release\/infra\/scripts\/verify-webadmin-guard\.sh" --lane staging[\s\S]*?rollback_pid=/,
        'staging rehearsal does not check the candidate lane (page assets, auth guard) before rollback');
});

test('the rehearsal checks the re-promoted lane before writing its receipt', () => {
    assert.match(rehearsal,
        /repromoted_pid=\$\(switch_and_restart "\$release"\)[\s\S]*?"\$release\/infra\/scripts\/verify-webadmin-guard\.sh" --lane staging[\s\S]*?receipt=/,
        'staging rehearsal writes a verified receipt without checking the re-promoted lane');
});
