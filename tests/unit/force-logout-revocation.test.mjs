// Force logout means the credential cannot immediately sign itself back in.
//
// This exercises the transaction as code, not as text: a source assertion can
// find BEGIN, DELETE and COMMIT in unrelated branches and still pass while the
// token survives. The fake client records the exact query order and can fail at
// the revocation boundary so rollback is observable without a database service.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { forceLogoutUser } = require('../../server/lib/force-logout');
const routes = readFileSync(new URL('../../server/lib/routes.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

function database({ deviceId = 'device-a', failOnDelete = false } = {}) {
    const calls = [];
    let released = false;
    const client = {
        async query(sql, params = []) {
            calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
            if (/SELECT current_device_id/i.test(sql)) {
                return { rows: [{ current_device_id: deviceId }], rowCount: 1 };
            }
            if (/DELETE FROM public\.device_tokens/i.test(sql)) {
                if (failOnDelete) throw new Error('delete failed');
                return { rows: [], rowCount: 1 };
            }
            if (/UPDATE public\.users/i.test(sql)) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release() { released = true; },
    };
    return {
        pool: { async connect() { return client; } },
        calls,
        released: () => released,
    };
}

const indexOf = (calls, pattern) => calls.findIndex(({ sql }) => pattern.test(sql));

function routeBlock(name) {
    const start = routes.indexOf(name);
    assert.ok(start >= 0, `${name} route is missing`);
    const end = routes.indexOf('\n    });', start);
    assert.ok(end > start, `${name} route is not closed`);
    return routes.slice(start, end);
}

function runPanelHelperPhp(body, { inTransaction = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'am2-token-revoke-'));
    const file = join(dir, 'case.php');
    const rules = new URL('../../WebAdmin/user_rules.php', import.meta.url).pathname;
    writeFileSync(file, `<?php
function am2_require_transaction(PDO $pdo, string $fn): void {
    if (!$pdo->inTransaction()) throw new LogicException($fn . '() must run inside a transaction');
}
function am2_audit_expect($fn): void {}
class FakeStatement {
    private array $rows = [];
    public function __construct(private FakePDO $pdo, private string $sql) {}
    public function execute($params = null): bool {
        $this->pdo->calls[] = [$this->sql, $params];
        if (stripos($this->sql, 'SELECT current_device_id') !== false) {
            $this->rows = $this->pdo->selectRows;
        }
        return true;
    }
    public function fetch($mode = null): mixed {
        return array_shift($this->rows) ?: false;
    }
}
class FakePDO extends PDO {
    public array $calls = [];
    public array $selectRows = [];
    public function __construct(private bool $tx) {}
    public function inTransaction(): bool { return $this->tx; }
    public function prepare($sql, $options = []): FakeStatement|false {
        return new FakeStatement($this, (string)$sql);
    }
}
require ${JSON.stringify(rules)};
$pdo = new FakePDO(${inTransaction ? 'true' : 'false'});
${body}
`);
    try {
        return execFileSync('php', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('force logout revokes the active device credential', () => {
    test('user state and the matching user+device token commit together', async () => {
        const db = database();
        const result = await forceLogoutUser(db.pool, 'CT_A1');
        const begin = indexOf(db.calls, /^BEGIN$/);
        const locked = indexOf(db.calls, /SELECT current_device_id.*FOR UPDATE/i);
        const revoked = indexOf(db.calls, /DELETE FROM public\.device_tokens/i);
        const offline = indexOf(db.calls, /UPDATE public\.users/i);
        const committed = indexOf(db.calls, /^COMMIT$/);

        assert.ok(begin >= 0 && locked > begin && revoked > locked && offline > revoked && committed > offline,
            `wrong transaction order: ${db.calls.map((c) => c.sql).join(' | ')}`);
        assert.deepEqual(db.calls[revoked].params, ['CT_A1', 'device-a']);
        assert.match(db.calls[revoked].sql, /user_id = \$1/i);
        assert.match(db.calls[revoked].sql, /device_id IS NOT DISTINCT FROM \$2/i);
        assert.equal(result.tokensRevoked, 1);
        assert.equal(db.released(), true);
    });

    test('a token-revocation failure rolls the user-state change back', async () => {
        const db = database({ failOnDelete: true });
        await assert.rejects(forceLogoutUser(db.pool, 'CT_A1'), /delete failed/);
        assert.ok(indexOf(db.calls, /^ROLLBACK$/) >= 0, 'failure never rolls back');
        assert.equal(indexOf(db.calls, /^COMMIT$/), -1, 'partial force logout was committed');
        assert.equal(db.released(), true);
    });

    test('a legacy null device id revokes only the null-device token set', async () => {
        const db = database({ deviceId: null });
        await forceLogoutUser(db.pool, 'CT_A1');
        const revoked = indexOf(db.calls, /DELETE FROM public\.device_tokens/i);
        assert.deepEqual(db.calls[revoked].params, ['CT_A1', null]);
    });

    test('both relay force-logout paths revoke before notifying the socket', () => {
        assert.match(routes, /forceLogoutUser/);
        for (const { marker, block } of [
            { marker: "app.post('/api/admin/force-logout'", block: routeBlock("app.post('/api/admin/force-logout'") },
            {
                marker: 'if (isExpired || isInactive)',
                block: routes.slice(
                    routes.indexOf('if (isExpired || isInactive)'),
                    routes.indexOf('continue;', routes.indexOf('if (isExpired || isInactive)')) + 'continue;'.length,
                ),
            },
        ]) {
            assert.match(block, /await forceLogoutUser\(pool, uid\)/,
                `${marker} still clears only current_device_id`);
            assert.ok(block.indexOf('await forceLogoutUser(pool, uid)') < block.indexOf("type: 'force_logout'"),
                `${marker} notifies the handset before revocation commits`);
        }
    });

    test('the panel helper locks the user and revokes only the active device', () => {
        const output = runPanelHelperPhp(`
            $pdo->selectRows = [['current_device_id' => 'device-a']];
            am2_force_logout_user($pdo, 'CT_A1');
            echo json_encode($pdo->calls);
        `);
        const calls = JSON.parse(output);
        const selected = calls.findIndex(([sql]) => /SELECT current_device_id.*FOR UPDATE/i.test(sql));
        const revoked = calls.findIndex(([sql]) => /DELETE FROM public\.device_tokens/i.test(sql));
        const offline = calls.findIndex(([sql]) => /UPDATE public\.users/i.test(sql));
        assert.ok(selected >= 0 && revoked > selected && offline > revoked,
            `wrong panel transaction order: ${JSON.stringify(calls)}`);
        assert.match(calls[revoked][0], /user_id = \?/i);
        assert.match(calls[revoked][0], /device_id IS NOT DISTINCT FROM \?/i);
        assert.deepEqual(calls[revoked][1], ['CT_A1', 'device-a']);

        assert.throws(() => runPanelHelperPhp(
            `am2_force_logout_user($pdo, 'CT_A1');`,
            { inTransaction: false },
        ), /must run inside a transaction/);
    });
});
