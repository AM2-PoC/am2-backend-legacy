import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Who may be deleted, decided once.
 *
 * Deleting an admin took a branch with it on 2026-09-04: 186 units, by cascade,
 * from one POST. The database now refuses that outright (migration 006), which
 * is the guard that holds no matter which path tries. This is the other half --
 * telling the operator *why*, before they hit a foreign key error that says
 * "Terjadi kesalahan sistem" and nothing else.
 *
 * It also closes a split. admin_panel.php enforced three rules through
 * am2_adm_undeletable() -- not a superadmin, not the master row, not yourself --
 * while api_admin_panel.php enforced one, inline, as `role != 'superadmin'` in
 * the DELETE itself. So through the API the master admin and your own account
 * were deletable and through the page they were not. Two paths, two answers,
 * one of them the endpoint that was exploited.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const phpFunction = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() is not defined`);
    return source.slice(start, source.indexOf('\n}', start));
};

test('the rule lives in one place and both paths use it', () => {
    const rules = read('WebAdmin/admin_rules.php');
    assert.match(rules, /function am2_admin_undeletable\(/,
        'there is no shared rule to use');
    for (const f of ['WebAdmin/admin_panel.php', 'WebAdmin/api_admin_panel.php']) {
        assert.match(read(f), /am2_admin_undeletable\(/,
            `${f} still decides for itself who may be deleted`);
    }
});

test('an admin that still owns units is refused, with the number', () => {
    /*
     * A count, not a yes or no. "This cannot be deleted" invites the operator
     * to go looking for the obstacle; "this still owns 186 units" tells them
     * what to do next, and makes the size of what they were about to destroy
     * the first thing they read.
     */
    const body = phpFunction(read('WebAdmin/admin_rules.php'), 'am2_admin_undeletable');
    assert.match(body, /FROM public\.users/i,
        'nothing counts what the admin still owns');
    assert.match(body, /count/i);
});

test('the three rules that were already there survive', () => {
    const body = phpFunction(read('WebAdmin/admin_rules.php'), 'am2_admin_undeletable');
    for (const key of ['locked_super', 'locked_master', 'locked_self']) {
        assert.ok(body.includes(key), `the ${key} rule was dropped in the move`);
    }
});

test('the API path stops carrying its own weaker copy', () => {
    // `WHERE id = ? AND role != 'superadmin'` protected the superadmin row and
    // nothing else, so the master admin and your own account were deletable
    // here and not on the page.
    const api = read('WebAdmin/api_admin_panel.php');
    assert.doesNotMatch(api, /DELETE FROM public\.admin WHERE id = \? AND role != 'superadmin'/,
        'the API still enforces a different, weaker rule than the page');
});

test('a refusal is not reported as a system error', () => {
    // am2_safe_error() answers "Terjadi kesalahan sistem", which is right for a
    // failing query and wrong for a rule doing its job. The operator learns
    // nothing and the log records an error that is not one.
    const api = read('WebAdmin/api_admin_panel.php');
    const start = api.indexOf("$action == 'delete'");
    const block = api.slice(start, api.indexOf("elseif ($action == 'delegate')", start));
    assert.match(block, /am2_admin_undeletable/,
        'the API reaches the database before it checks the rule');
});
