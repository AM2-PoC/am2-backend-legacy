/**
 * The selector coverage guard is checked by CI itself, not only by the guard.
 *
 * offline-selector-coverage.test.mjs asserts that offline suites stay selected,
 * but it is a selected suite too. If its own text ever trips the selector again
 * -- it did, twice -- it silently stops running, and the entry naming itself can
 * never fail. The workflow step that runs the selector is the one place that
 * always executes, so it must refuse a run without the guard.
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
const workflow = readFileSync(join(ROOT, '.github/workflows/source-checks.yml'), 'utf8');

test('the offline job refuses a selection without the coverage guard', () => {
    const step = workflow.match(/mapfile -t files < <\(\.\/tests\/offline-tests\.sh\)[\s\S]*?node --test/);
    assert.ok(step, 'the offline test step no longer runs the selector');
    assert.match(step[0], /grep -qx offline-selector-coverage\.test\.mjs/,
        'CI would run a selection that silently dropped the selector coverage guard');
});
