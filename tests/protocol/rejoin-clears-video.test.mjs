// Rejoining a channel while streaming must end the stream for everyone watching.
//
// `join_channel` leaves the old room first, unconditionally: it removes the
// socket from `activeVideoRooms` and from the Redis set, broadcasts
// `ptt_active_status`, and stops. Video state is corrected and nobody is told,
// so the channel keeps its incoming-video view up with no frames behind it.
//
// A rejoin is not a corner case. The handset re-sends join_channel after every
// reconnect, so any stream interrupted by a network flap ends this way -- the
// streamer silently stops being a streamer and the room is never informed.
//
// This is the fifth place the same shape appeared: audio handled carefully,
// video handled less carefully in the same function. The others were
// `ws.on('close')`, `join_channel`'s arrival side, the private binary path, and
// the transmit authorization shared by audio and video key-down.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const TIMEOUT = 8000;
const CHANNEL = 'ct_channel_a';

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

async function waitFor(ws, type, ms = TIMEOUT) {
    const deadline = Date.now() + ms;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(`${ws.label}: no ${type} within ${ms}ms; saw [${ws.inbox.map((m) => m.type).join(', ')}]`);
        }
        await new Promise((r) => setTimeout(r, 40));
    }
}

async function signIn(ws, username) {
    send(ws, 'app_login', {
        username,
        password: env.CT_PTT_PASS,
        current_device_id: `switch-${username}-${Date.now()}`,
    });
    return waitFor(ws, 'login_success');
}

let streamer, observer;
let streamerName = null;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    streamer = await connect('streamer');
    observer = await connect('observer');
    await signIn(streamer, 'CT_A1');
    await signIn(observer, 'CT_A2');
    for (const ws of [streamer, observer]) {
        send(ws, 'join_channel', { new_channel_slug: CHANNEL });
        await waitFor(ws, 'join_channel_success');
    }

    observer.inbox.length = 0;
    send(streamer, 'ptt_video_start', { channel_slug: CHANNEL });
    const announced = await waitFor(observer, 'video_stream_status');
    [streamerName] = announced.data?.streamers ?? [];
});

after(async () => {
    if (streamer && streamer.readyState === WebSocket.OPEN) {
        send(streamer, 'join_channel', { new_channel_slug: CHANNEL });
        await new Promise((r) => setTimeout(r, 200));
        streamer.close();
    }
    if (observer && observer.readyState === WebSocket.OPEN) observer.close();
});

describe('a streamer that rejoins its channel', () => {
    test('is no longer announced as streaming', async () => {
        assert.ok(streamerName, 'the stream was never announced');
        observer.inbox.length = 0;

        send(streamer, 'join_channel', { new_channel_slug: CHANNEL });
        await waitFor(streamer, 'join_channel_success');

        let status;
        try {
            status = await waitFor(observer, 'video_stream_status', 5000);
        } catch {
            assert.fail(
                'the channel was never told the stream ended: the rejoining socket '
                + 'is removed from activeVideoRooms and from Redis, and only '
                + 'ptt_active_status is broadcast, so every viewer holds an '
                + 'incoming-video view with nothing arriving behind it',
            );
        }
        assert.ok(
            !(status.data?.streamers ?? []).includes(streamerName),
            `${streamerName} is still announced as streaming after rejoining `
            + `(streamers: [${(status.data?.streamers ?? []).join(', ')}])`,
        );
    });
});
