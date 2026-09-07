// Force logout means the credential cannot immediately sign itself back in.
//
// This exercises the transaction as code, not as text: a source assertion can
// find BEGIN, DELETE and COMMIT in unrelated branches and still pass while the
// token survives. The fake client records the exact query order and can fail at
// the revocation boundary so rollback is observable without a database service.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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
                return { rows: [{ current_device_id: deviceId, force_logout: false }], rowCount: 1 };
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

    test('the panel delegates force logout instead of duplicating the transaction', () => {
        const rules = readFileSync(new URL('../../WebAdmin/user_rules.php', import.meta.url), 'utf8');
        assert.doesNotMatch(rules, /function am2_force_logout_user\(/);
        assert.doesNotMatch(rules, /UPDATE\s+(?:public\.)?users\s+SET[\s\S]{0,240}?force_logout\s*=|current_device_id\s+FROM\s+public\.users/i);
    });
});
