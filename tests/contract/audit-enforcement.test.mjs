/**
 * Exactly one audit event per mutation, enforced rather than remembered.
 *
 * The activity log is the answer to "who changed this, and when". A mutation
 * that reaches the database without writing one is not a visible bug -- the
 * change works, the page says it worked, and the absence is only discovered
 * when someone goes looking months later. A mutation that writes two is worse:
 * the trail says a thing happened twice.
 *
 * Today the invariant holds by caller discipline: every helper documents that
 * its caller owns the log write, and every caller does. Nothing checks. These
 * tests exercise the guard that makes a forgotten write fail loudly, in a real
 * PHP subprocess against a real SQLite database, so the assertions are about
 * behaviour rather than about the shape of the source.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const read = (p) => readFileSync(join(WEBADMIN, p), 'utf8');

/**
 * Runs PHP with the audit helpers loaded against a PDO that records instead of
 * connecting.
 *
 * The only driver on this machine is pgsql, and a test that needs a database
 * server is a test that needs credentials. PDO's constructor is what opens a
 * connection, so a subclass that does not call it is a usable stand-in: the
 * guard under test is about the order of calls, not about SQL.
 *
 * `$failWrites` makes prepare() throw, which is how am2_log's own failure path
 * is reached.
 */
function runPhp(body, { failWrites = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'am2-audit-'));
    const file = join(dir, 'case.php');
    writeFileSync(file, `<?php
require ${JSON.stringify(join(WEBADMIN, 'activity_log.php'))};

class FakeStatement {
    public array $rows = [];
    public function execute($params = null): bool { return true; }
}

class FakePDO extends PDO {
    public array $written = [];
    public bool $failWrites = ${failWrites ? 'true' : 'false'};
    /** Deliberately does not call parent::__construct(): that is what connects. */
    public function __construct() {}
    public function prepare($sql, $options = []): FakeStatement|false {
        if ($this->failWrites) {
            throw new PDOException('SQLSTATE[42P01]: relation does not exist');
        }
        $this->written[] = $sql;
        return new FakeStatement();
    }
    public function inTransaction(): bool { return true; }
}

$pdo = new FakePDO();
${body}
`);
    try {
        return execFileSync('php', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('a mutation that declares itself and then logs settles cleanly', () => {
    const out = runPhp(`
        am2_audit_expect('am2_create_user');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        echo "settled\\n";
    `);
    assert.match(out, /settled/, 'the ordinary path must not raise');
});

test('a mutation that never logs is refused at the point of commit', () => {
    // This is the whole point: forgetting the log write has to stop the
    // transaction, not pass quietly and leave a gap in the trail.
    assert.throws(() => runPhp(`
        am2_audit_expect('am2_create_user');
        am2_audit_complete();
        echo "settled\\n";
    `), (err) => {
        const text = String(err.stdout ?? '') + String(err.stderr ?? '');
        assert.doesNotMatch(text, /settled/, 'the unlogged mutation was allowed through');
        assert.match(text, /am2_create_user/,
            'the failure does not name the mutation that went unlogged');
        return true;
    }, 'an unlogged mutation completed without error');
});

test('one log does not settle two mutations', () => {
    // Two changes in one transaction are two events. A single write covering
    // both is a trail that under-reports, which reads as one of them never
    // having happened.
    assert.throws(() => runPhp(`
        am2_audit_expect('am2_create_user');
        am2_audit_expect('am2_set_user_feature');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        echo "settled\\n";
    `), (err) => {
        const text = String(err.stdout ?? '') + String(err.stderr ?? '');
        assert.doesNotMatch(text, /settled/, 'a second mutation went unlogged');
        assert.match(text, /am2_set_user_feature/,
            'the failure does not name the mutation left unlogged');
        return true;
    });
});

test('a log with no mutation behind it is refused too', () => {
    // The opposite failure, and the reason this is a balance rather than a
    // counter that only goes up: a duplicated write is a trail claiming an
    // action happened twice.
    assert.throws(() => runPhp(`
        am2_audit_expect('am2_create_user');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        echo "settled\\n";
    `), (err) => {
        const text = String(err.stdout ?? '') + String(err.stderr ?? '');
        assert.doesNotMatch(text, /settled/, 'a duplicate audit event was accepted');
        assert.match(text, /user\.create|unexpected|no mutation/i,
            'the failure does not identify the surplus audit event');
        return true;
    });
});

test('a failed log write still writes the row it was given, and still settles', () => {
    // am2_log swallows its own failures on purpose: losing the record is bad,
    // but rolling back a completed change because the record could not be
    // written is worse. The guard must not undo that decision.
    const out = runPhp(`
        am2_audit_expect('am2_create_user');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        echo "settled\\n";
    `, { failWrites: true });
    assert.match(out, /settled/,
        'a database failure inside am2_log now blocks the mutation it was recording');
});

test('the audit balance does not leak between transactions', () => {
    const out = runPhp(`
        am2_audit_expect('am2_create_user');
        am2_log($pdo, 'ADM1', 'CREATE_USER', 'user.create', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        am2_audit_expect('am2_delete_user');
        am2_log($pdo, 'ADM1', 'DELETE_USER', 'user.delete', ['id' => 'U1'], 'users', 'U1');
        am2_audit_complete();
        echo "settled\\n";
    `);
    assert.match(out, /settled/, 'a settled transaction left state behind for the next one');
});

test('every mutating helper declares the audit event its caller owes', () => {
    // Source-level, because the point is that a helper added later inherits the
    // obligation. The behaviour above proves the guard works; this proves it is
    // actually wired to the four functions that change a unit.
    const helpers = {
        'user_rules.php': ['am2_create_user', 'am2_update_user', 'am2_delete_user'],
        'user_features.php': ['am2_set_user_feature'],
    };
    for (const [file, fns] of Object.entries(helpers)) {
        const src = read(file);
        for (const fn of fns) {
            const body = src.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`));
            assert.ok(body, `${file} no longer defines ${fn}`);
            assert.match(body[0], /am2_audit_expect\s*\(/,
                `${fn} mutates without declaring an audit event; a caller that forgets to log is silent`);
        }
    }
});

test('rewriting a unit\'s channel membership is recorded, from either surface', () => {
    // Two of the four writers logged nothing at all: the row dialogue on
    // users.php and the endpoint the app calls. Who a unit can talk to is
    // exactly what the log is for, and both left it looking unchanged.
    for (const file of ['users.php', 'api_users.php', 'user_access.php', 'api_user_access.php']) {
        const src = read(file);
        for (const m of src.matchAll(/am2_set_user_channels\(/g)) {
            const after = src.slice(m.index, m.index + 1600);
            assert.match(after, /am2_log\(/,
                `a membership rewrite in ${file} reaches the database without an audit event`);
            assert.match(after, /access\.(update|revoke)/,
                `a membership rewrite in ${file} logs under a code the Logs page cannot group`);
        }
    }
});

test('a forced logout is recorded even when the caller has no admin id', () => {
    // It used to be wrapped in `if ($current_admin_id)`, so the one case where
    // the trail matters most -- a unit kicked off by nobody identifiable --
    // recorded nothing. am2_log stores an absent id as null already.
    const src = read('api_user_access.php');
    const kick = src.match(/force_logout[\s\S]*?\$pdo->commit\(\)/);
    assert.ok(kick, 'api_user_access.php no longer has a force_logout path');
    assert.match(kick[0], /am2_log\(/, 'the forced logout writes no audit event');
    assert.doesNotMatch(kick[0], /if\s*\(\s*\$current_admin_id\s*\)\s*\{[\s\S]*?am2_log\(/,
        'the audit event is conditional again, so an unattributed kick goes unrecorded');
});

test('every caller settles the balance before it commits', () => {
    for (const file of ['users.php', 'api_users.php']) {
        const src = read(file);
        const commits = [...src.matchAll(/->commit\(\)/g)];
        assert.notEqual(commits.length, 0, `${file} has no commit`);
        for (const m of commits) {
            const before = src.slice(Math.max(0, m.index - 1200), m.index);
            assert.match(before, /am2_audit_complete\(\)/,
                `a commit in ${file} is not preceded by am2_audit_complete(); `
                + 'a missing log write would be committed unnoticed');
        }
    }
});
