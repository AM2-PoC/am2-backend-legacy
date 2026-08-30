// The token login path, exercised rather than read.
//
// The relay has offered a revocable device token since 80ab744: the first
// password login hands one back, the handset keeps it instead of the password,
// and presents it from then on. None of it worked. protocol.js called
// userForDeviceToken and issueDeviceToken and imported neither, so both were
// ReferenceErrors -- and neither was visible. The issuing call sits in a try
// that logs and continues, so login_success carried device_token: null and
// nothing complained; the verifying call left through the login catch-all,
// which told the handset "Database Timeout / Connection Error".
//
// Every gate passed. node --check parses without resolving names, and this
// suite -- the one that runs a real relay against a real database -- never
// logged anybody in with a token, so the feature was never once executed.
// A handset in the field sat reconnecting against a relay that appeared fine.
//
// So this signs in the way a handset does on its second run, and it does it
// against the running relay. A static test cannot replace it: the next fault
// in this path will be a wrong column or a missing grant, and only a real
// query finds those.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const TIMEOUT = 8000;
const UNIT = 'CT_A1';

function connect(label) {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.label = label;
    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try { ws.inbox.push(JSON.parse(data.toString())); } catch { /* never */ }
    });
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        setTimeout(() => reject(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, type, data = {}) => ws.send(JSON.stringify({ type, data }));

/** The relay's answer to a login attempt, whichever way it went. */
async function answer(ws, ms = TIMEOUT) {
    const deadline = Date.now() + ms;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === 'login_success' || m.type === 'login_error');
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(
                `${ws.label}: no answer to app_login within ${ms}ms; `
                + `saw [${ws.inbox.map((m) => m.type).join(', ')}]`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

const device = () => `harness-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let sockets = [];
async function client(label) {
    const ws = await connect(label);
    sockets.push(ws);
    return ws;
}

before(() => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
});

after(() => {
    for (const ws of sockets) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
    sockets = [];
});

describe('signing in with a device token', () => {
    let issued = null;
    const deviceId = device();

    test('a password login is handed a token to keep', async () => {
        // This is the assertion that was false for the whole life of the
        // feature, while the relay reported a successful login.
        const ws = await client('first-run');
        send(ws, 'app_login', {
            username: UNIT, password: env.CT_PTT_PASS, current_device_id: deviceId,
        });
        const res = await answer(ws);
        assert.equal(res.type, 'login_success', `rejected: ${res.data?.message ?? '?'}`);
        issued = res.data?.device_token;
        assert.ok(typeof issued === 'string' && issued.length > 0,
            'login_success carries no device_token, so the handset keeps the password instead');
    });

    test('the token signs the same handset in again, with no password', async () => {
        assert.ok(issued, 'nothing was issued to present');
        const ws = await client('second-run');
        send(ws, 'app_login', { username: UNIT, token: issued, current_device_id: deviceId });
        const res = await answer(ws);
        assert.equal(res.type, 'login_success',
            `a token the relay issued was refused: ${res.data?.message ?? '?'} `
            + `(code ${res.data?.code ?? 'none'})`);
    });

    test('a token the relay never issued is refused as a revocation', async () => {
        // Not as a database problem. The handset acts on the code: this one
        // means erase it and ask for the password, and nothing else does.
        const ws = await client('stranger');
        send(ws, 'app_login', {
            username: UNIT, token: 'f'.repeat(64), current_device_id: device(),
        });
        const res = await answer(ws);
        assert.equal(res.type, 'login_error');
        assert.equal(res.data?.code, 'token_revoked',
            `an unknown token is reported as ${res.data?.code ?? 'nothing'}, `
            + 'which does not tell the handset to stop presenting it');
    });

    test('a wrong password is refused as a credential, not as an outage', async () => {
        const ws = await client('wrong-password');
        send(ws, 'app_login', {
            username: UNIT, password: 'not the password', current_device_id: device(),
        });
        const res = await answer(ws);
        assert.equal(res.type, 'login_error');
        assert.equal(res.data?.code, 'credential_rejected',
            `a wrong password is reported as ${res.data?.code ?? 'nothing'}`);
    });
});
