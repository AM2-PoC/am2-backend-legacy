// A force logout and a login/rotation for the same user must make one ordered
// database decision. This fake lock holds the login at the users row while force
// logout waits; when login commits first, force logout must revoke the token it
// just issued. A helper that leaves token issuance in a later autocommit query
// makes this test end with a usable token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { forceLogoutUser } = require('../../server/lib/force-logout');
const { commitLoginSession, LoginSessionError } = require('../../server/lib/login-session');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function concurrentDatabase({
    initialDeviceId = null,
    initialForceLogout = false,
    initialPassword = 'hash-current',
    initialTokens = [],
} = {}) {
    let owner = null;
    const waiters = [];
    const tokens = initialTokens.map((token) => ({ ...token }));
    let deviceId = initialDeviceId;
    let forceLogout = initialForceLogout;
    let password = initialPassword;

    async function lock(client) {
        if (!owner) { owner = client; return; }
        await new Promise((resolve) => waiters.push({ client, resolve }));
    }
    async function waitUntil(predicate) {
        while (!predicate()) await tick();
    }
    function unlock(client) {
        if (owner !== client) return;
        const next = waiters.shift();
        if (next) { owner = next.client; next.resolve(); }
        else owner = null;
    }

    function client(name) {
        let locked = false;
        return {
            async query(sql, params = []) {
                const q = String(sql).replace(/\s+/g, ' ').trim();
                if (/^BEGIN$/.test(q)) return { rows: [], rowCount: 0 };
                if (/SELECT .*FROM public\.users.*FOR UPDATE/i.test(q)) {
                    await lock(this); locked = true;
                    return { rows: [{ current_device_id: deviceId, force_logout: forceLogout, password }], rowCount: 1 };
                }
                if (/SELECT user_id, device_id FROM public\.device_tokens/i.test(q)) {
                    const token = tokens.find((item) => item.tokenHash === params[0]);
                    return { rows: token ? [{ user_id: token.userId, device_id: token.deviceId }] : [], rowCount: token ? 1 : 0 };
                }
                if (/INSERT INTO public\.device_tokens/i.test(q)) {
                    tokens.push({ tokenHash: params[0], userId: params[1], deviceId: params[2] });
                    return { rows: [], rowCount: 1 };
                }
                if (/DELETE FROM public\.device_tokens/i.test(q)) {
                    for (let i = tokens.length - 1; i >= 0; i -= 1) {
                        const byHash = /token_hash = \$1/i.test(q) && tokens[i].tokenHash === params[0];
                        const byDevice = /user_id = \$1/i.test(q)
                            && tokens[i].userId === params[0] && tokens[i].deviceId === params[1];
                        if (byHash || byDevice) tokens.splice(i, 1);
                    }
                    return { rows: [], rowCount: 1 };
                }
                if (/UPDATE public\.users.*current_device_id = \$1/i.test(q)) {
                    deviceId = params[0];
                    forceLogout = false;
                    return { rows: [], rowCount: 1 };
                }
                if (/UPDATE public\.users.*current_device_id = NULL/i.test(q)) {
                    deviceId = null;
                    forceLogout = true;
                    return { rows: [], rowCount: 1 };
                }
                if (/^(COMMIT|ROLLBACK)$/.test(q)) {
                    if (locked) { locked = false; unlock(this); }
                    return { rows: [], rowCount: 0 };
                }
                throw new Error(`${name}: unexpected SQL ${q}`);
            },
            release() { if (locked) unlock(this); },
        };
    }

    const clients = [client('login'), client('logout')];
    return {
        pool: { async connect() { return clients.shift(); } },
        tokens,
        state: () => ({ deviceId, forceLogout, password }),
        waiting: () => waitUntil(() => waiters.length > 0),
        changePassword: (next) => { password = next; },
    };
}

test('a force logout racing token rotation leaves no resumable token', async () => {
    const db = concurrentDatabase();
    let allowIssue;
    const issuanceGate = new Promise((resolve) => { allowIssue = resolve; });
    let loginLocked;
    const locked = new Promise((resolve) => { loginLocked = resolve; });

    const login = commitLoginSession(db.pool, {
        userId: 'CT_A1',
        deviceId: 'device-a',
        tokenHash: 'a'.repeat(64),
        beforeIssue: async () => { loginLocked(); await issuanceGate; },
    });
    await locked;

    const logout = forceLogoutUser(db.pool, 'CT_A1');
    await db.waiting();
    assert.equal(db.state().deviceId, null, 'login published session state before its transaction completed');

    allowIssue();
    await login;
    await logout;

    assert.deepEqual(db.tokens, [], 'force logout committed while a newly issued token survived');
    assert.equal(db.state().deviceId, null);
});

test('a login authenticated before force logout cannot publish after it', async () => {
    const db = concurrentDatabase({ initialForceLogout: true });
    await assert.rejects(
        commitLoginSession(db.pool, {
            userId: 'CT_A1',
            deviceId: 'device-a',
            expectedForceLogout: false,
            expectedCurrentDeviceId: null,
        }),
        (error) => error.code === LoginSessionError.AUTH_STATE_CHANGED,
    );
    assert.deepEqual(db.tokens, []);
    assert.deepEqual(db.state(), { deviceId: null, forceLogout: true, password: 'hash-current' });
});

test('a token migrated to another device consumes its source credential', async () => {
    const sourceHash = 'b'.repeat(64);
    const db = concurrentDatabase({
        initialTokens: [{ tokenHash: sourceHash, userId: 'CT_A1', deviceId: 'device-a' }],
    });
    await commitLoginSession(db.pool, {
        userId: 'CT_A1',
        deviceId: 'device-b',
        sourceTokenHash: sourceHash,
        sourceDeviceId: 'device-a',
        expectedForceLogout: false,
        expectedCurrentDeviceId: null,
    });
    assert.equal(db.tokens.some((token) => token.tokenHash === sourceHash), false,
        'the credential from device A survived migration to device B');
    assert.equal(db.tokens.length, 1);
    assert.equal(db.tokens[0].deviceId, 'device-b');
});

test('a password changed after bcrypt validation cannot mint a token', async () => {
    const db = concurrentDatabase({ initialPassword: 'hash-new' });
    await assert.rejects(
        commitLoginSession(db.pool, {
            userId: 'CT_A1',
            deviceId: 'device-a',
            expectedPasswordHash: 'hash-old',
            expectedForceLogout: false,
            expectedCurrentDeviceId: null,
        }),
        (error) => error.code === LoginSessionError.AUTH_STATE_CHANGED,
    );
    assert.deepEqual(db.tokens, []);
    assert.equal(db.state().deviceId, null);
});
