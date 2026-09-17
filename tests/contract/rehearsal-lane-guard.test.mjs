import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rehearsal = readFileSync(join(ROOT, 'infra/scripts/rehearse-staging-artifact.sh'), 'utf8');

// The whole call on its own line, so a commented-out call or one softened with
// `|| true` cannot satisfy it. Output goes to stderr; stdout is the receipt path.
const GUARD_CALL = String.raw`\n"\$release\/infra\/scripts\/verify-webadmin-guard\.sh" --lane staging >&2\n`;

test('the rehearsal checks the candidate lane before rolling back', () => {
    assert.match(rehearsal,
        new RegExp(String.raw`candidate_pid=\$\(switch_and_restart "\$release"\)[\s\S]*?${GUARD_CALL}[\s\S]*?rollback_pid=`),
        'staging rehearsal does not check the candidate lane (page assets, auth guard) before rollback');
});

test('the rehearsal checks the re-promoted lane before writing its receipt', () => {
    assert.match(rehearsal,
        new RegExp(String.raw`repromoted_pid=\$\(switch_and_restart "\$release"\)[\s\S]*?${GUARD_CALL}[\s\S]*?receipt=`),
        'staging rehearsal writes a verified receipt without checking the re-promoted lane');
});
