// Joining a channel must show what is already happening in it.
//
// `join_channel_success` hands the new arrival the speaker list, so a
// transmission already in progress is visible immediately. It carries nothing
// about video, and no `video_stream_status` is sent alongside it -- the same
// asymmetry that left `ws.on('close')` cleaning up audio and forgetting video.
//
// The relay does restore `activeVideoRooms` from Redis during the join, so it
// knows. It simply never says. A unit that joins while somebody is on camera
// stays blind until the *next* `ptt_video_start`, which on a radio may be
// minutes away or may never come -- the stream it missed is the one already
// running.
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
        current_device_id: `joinvideo-${username}-${Date.now()}`,
    });
    return waitFor(ws, 'login_success');
}

let streamer, joiner;
let streamerName = null;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    streamer = await connect('streamer');
    await signIn(streamer, 'CT_A1');
    send(streamer, 'join_channel', { new_channel_slug: CHANNEL });
    await waitFor(streamer, 'join_channel_success');

    // The join itself now answers with the current streamer list, so that
    // message is already in the inbox and would be mistaken for the
    // announcement below.
    streamer.inbox.length = 0;
    send(streamer, 'ptt_video_start', { channel_slug: CHANNEL });
    // The streamer is told about its own stream, which is where the display
    // name comes from; the relay announces names, not ids.
    const announced = await waitFor(streamer, 'video_stream_status');
    [streamerName] = announced.data?.streamers ?? [];
});

after(async () => {
    if (streamer && streamer.readyState === WebSocket.OPEN) {
        send(streamer, 'ptt_video_end', { channel_slug: CHANNEL });
        await new Promise((r) => setTimeout(r, 200));
        streamer.close();
    }
    if (joiner && joiner.readyState === WebSocket.OPEN) joiner.close();
});

describe('joining a channel with a stream already running', () => {
    test('the arrival is told who is on camera', async () => {
        assert.ok(streamerName, 'the stream was never announced to its own sender');

        joiner = await connect('joiner');
        await signIn(joiner, 'CT_A2');
        send(joiner, 'join_channel', { new_channel_slug: CHANNEL });
        await waitFor(joiner, 'join_channel_success');

        let status;
        try {
            status = await waitFor(joiner, 'video_stream_status', 5000);
        } catch {
            assert.fail(
                'the arrival was never told a stream was running: join_channel_success '
                + 'carries the speaker list and nothing about video, so the unit stays '
                + 'blind until the next ptt_video_start',
            );
        }
        assert.ok(
            (status.data?.streamers ?? []).includes(streamerName),
            `expected ${streamerName} among streamers, `
            + `saw [${(status.data?.streamers ?? []).join(', ')}]`,
        );
    });
});
