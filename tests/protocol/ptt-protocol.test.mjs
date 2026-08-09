// The WebSocket protocol the field app speaks.
//
// This is the surface that `ws` sits directly under, so it is what a `ws`
// upgrade can break. It exercises a real two-client push-to-talk exchange
// against the staging relay: sign in, join, key the mic, relay an audio frame,
// release.
//
// Requires infra/scripts/ptt-harness-fixtures.sh to have run.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire('/var/www/am2/staging/current/server/');
const WebSocket = require('ws');

const WS_URL = NODE_URL.replace(/^http/, 'ws');
const TIMEOUT = 8000;
const CHANNEL = 'ct_channel_a';

/** A connected client with a small inbox, so tests can await a message type. */
function connect(label) {
    const ws = new WebSocket(WS_URL);
    ws.inbox = [];
    ws.binary = [];
    ws.label = label;
    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            ws.binary.push(Buffer.from(data));
            return;
        }
        try {
            ws.inbox.push(JSON.parse(data.toString()));
        } catch {
            /* the relay never sends malformed json; ignore if it does */
        }
    });
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        setTimeout(() => reject(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, type, data = {}) => ws.send(JSON.stringify({ type, data }));

async function waitFor(ws, type, ms = TIMEOUT) {
    const deadline = Date.now() + ms;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(
                `${ws.label}: no ${type} within ${ms}ms; saw [${ws.inbox.map((m) => m.type).join(', ')}]`
            );
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

async function signIn(ws, username) {
    send(ws, 'app_login', {
        username,
        password: env.CT_PTT_PASS,
        current_device_id: `harness-${username}-${Date.now()}`,
    });
    const res = await Promise.race([
        waitFor(ws, 'login_success'),
        waitFor(ws, 'login_error').then((m) => {
            throw new Error(`${username} rejected: ${m.data?.message ?? '?'}`);
        }),
    ]);
    return res;
}

let speaker, listener;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    speaker = await connect('speaker');
    listener = await connect('listener');
});

after(() => {
    for (const ws of [speaker, listener]) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
});

describe('push-to-talk over the relay', () => {
    test('both clients sign in', async () => {
        const a = await signIn(speaker, 'CT_A1');
        const b = await signIn(listener, 'CT_A2');
        assert.ok(a.data, 'login_success carries a data payload');
        assert.ok(b.data);
    });

    test('both clients join the same channel', async () => {
        // app_login authenticates but does not put the socket in a room; the
        // client has to ask. Audio only fans out within channelRooms.
        for (const ws of [speaker, listener]) {
            send(ws, 'join_channel', { new_channel_slug: CHANNEL });
            await waitFor(ws, 'join_channel_success');
        }
    });

    test('the relay reports who is online in the channel', async () => {
        const msg = await waitFor(listener, 'users_online');
        assert.ok(Array.isArray(msg.data?.users ?? msg.data),
            'users_online carries a list');
    });

    test('keying the mic is announced to the channel', async () => {
        listener.inbox.length = 0;
        send(speaker, 'ptt_audio_start');
        const status = await waitFor(listener, 'ptt_active_status');
        assert.ok(status.data !== undefined);
    });

    test('an audio frame reaches the other client', async () => {
        // Byte 0 is the type tag: 1 audio, 2 video. The relay drops audio from a
        // client that has not keyed the mic, so ordering matters here.
        listener.binary.length = 0;
        const frame = Buffer.concat([Buffer.from([1]), Buffer.from('harness-audio-payload')]);
        speaker.send(frame);

        const deadline = Date.now() + TIMEOUT;
        while (listener.binary.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(listener.binary.length > 0, 'no audio frame relayed');
        assert.equal(listener.binary[0][0], 1, 'the type tag must survive the relay');
        assert.match(listener.binary[0].toString(), /harness-audio-payload/);
    });

    test('the speaker does not hear itself', async () => {
        speaker.binary.length = 0;
        speaker.send(Buffer.concat([Buffer.from([1]), Buffer.from('echo-check')]));
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(speaker.binary.length, 0, 'frames must not be echoed to the sender');
    });

    test('releasing the mic is announced', async () => {
        listener.inbox.length = 0;
        send(speaker, 'ptt_audio_end');
        await waitFor(listener, 'ptt_active_status');
    });

    test('audio is dropped once the mic is released', async () => {
        listener.binary.length = 0;
        speaker.send(Buffer.concat([Buffer.from([1]), Buffer.from('should-not-arrive')]));
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(listener.binary.length, 0,
            'the relay only forwards audio from a client in activeSpeakers');
    });

    test('an unauthenticated socket is ignored', async () => {
        const stranger = await connect('stranger');
        stranger.send(Buffer.concat([Buffer.from([1]), Buffer.from('no-session')]));
        listener.binary.length = 0;
        await new Promise((r) => setTimeout(r, 600));
        assert.equal(listener.binary.length, 0);
        stranger.close();
    });

    test('a bad password is refused', async () => {
        const ws = await connect('badpass');
        send(ws, 'app_login', {
            username: 'CT_A1', password: 'definitely-wrong',
            current_device_id: 'harness-badpass',
        });
        const err = await waitFor(ws, 'login_error');
        assert.ok(err.data?.message, 'login_error carries a message the app displays');
        ws.close();
    });
});
