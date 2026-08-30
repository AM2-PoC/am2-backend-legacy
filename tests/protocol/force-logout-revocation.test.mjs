// A force logout is not complete until the token just used by that device is
// rejected by the real relay and real database.
import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL, sql } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');
const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const API_URL = process.env.CT_NODE_URL || NODE_URL;
const API_KEY = process.env.AM2_API_KEY || 'dev-local-key';
const TIMEOUT = 8000;
const UNIT = 'CT_A1';
const sockets = [];

function connect(label) {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.label = label;
    ws.on('message', (raw, binary) => {
        if (binary) return;
        try { ws.inbox.push(JSON.parse(raw.toString())); } catch { /* diagnostics below */ }
    });
    sockets.push(ws);
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        setTimeout(() => reject(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, type, data) => ws.send(JSON.stringify({ type, data }));
async function answer(ws) {
    const deadline = Date.now() + TIMEOUT;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === 'login_success' || m.type === 'login_error');
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`${ws.label}: no login answer`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

after(() => {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.close();
});

describe('force logout revokes the active device token', () => {
    const deviceId = `force-logout-${Date.now()}`;
    let token;

    test('fixture password login issues the token', async () => {
        assert.ok(env.CT_PTT_PASS, 'missing CT_PTT_PASS');
        const ws = await connect('issued');
        send(ws, 'app_login', {
            username: UNIT,
            password: env.CT_PTT_PASS,
            current_device_id: deviceId,
        });
        const result = await answer(ws);
        assert.equal(result.type, 'login_success', result.data?.message);
        token = result.data?.device_token;
        assert.ok(token);
    });

    test('admin force logout removes only that device row before replying', async () => {
        const response = await fetch(`${API_URL}/api/admin/force-logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-AM2-Api-Key': API_KEY,
            },
            body: JSON.stringify({ userId: UNIT }),
        });
        assert.equal(response.status, 200, await response.text());
        const rows = sql(
            `SELECT count(*) FROM public.device_tokens WHERE user_id = '${UNIT}' AND device_id = '${deviceId}'`,
        );
        assert.equal(Number(rows[0][0]), 0, 'force logout replied while the token row remained');
    });

    test('the same token is rejected after force logout', async () => {
        assert.ok(token, 'nothing was issued');
        const ws = await connect('revoked');
        send(ws, 'app_login', { username: UNIT, token, current_device_id: deviceId });
        const result = await answer(ws);
        assert.equal(result.type, 'login_error');
        assert.equal(result.data?.code, 'token_revoked');
    });
});
