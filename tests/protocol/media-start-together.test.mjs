// One press starts two media, and both must be authorized.
//
// In the video screen a press calls startVideoStream(), which emits
// ptt_video_start, and starts PTTService, which emits ptt_audio_start. Two
// messages from one button, milliseconds apart, and both run through
// authorizeChannelTransmit.
//
// That helper guards against an older lookup overwriting a newer decision by
// stamping a generation on the socket and re-reading it after the database
// answers. The generation was shared by both media, so the second message to
// arrive invalidated the first: the first lookup returned, found the generation
// moved, and reported 'stale'.
//
// Stale means ptt_video_start returns before `ws.channelVideoAuthorized = true`
// ever runs -- and every binary type 2 frame is gated on exactly that flag. So
// the audio of a press was authorized and its video was not, silently, for the
// whole transmission. The listener heard the sender and saw nothing, and no
// video_stream_status was broadcast either, so their screen showed no incoming
// view at all rather than an empty one.
//
// Which medium loses depends only on arrival order, which makes it look
// intermittent. It is not: it is whichever message the client sends first.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const TIMEOUT = 8000;
const CHANNEL = 'ct_channel_a';
const SETTLE_MS = 600;

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
        current_device_id: `together-${username}-${Date.now()}`,
    });
    return waitFor(ws, 'login_success');
}

function mediaFrame(binaryType, bytes = 64) {
    const frame = Buffer.alloc(bytes);
    frame[0] = binaryType;
    return frame;
}

let sender, listener;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    sender = await connect('sender');
    listener = await connect('listener');
    await signIn(sender, 'CT_A1');
    await signIn(listener, 'CT_A2');
    for (const ws of [sender, listener]) {
        send(ws, 'join_channel', { new_channel_slug: CHANNEL });
        await waitFor(ws, 'join_channel_success');
    }
});

after(async () => {
    if (sender?.readyState === WebSocket.OPEN) {
        send(sender, 'ptt_video_end', { channel_slug: CHANNEL });
        send(sender, 'ptt_audio_end', { channel_slug: CHANNEL, trace_id: 88001 });
        await new Promise((r) => setTimeout(r, 200));
    }
    for (const ws of [sender, listener]) {
        if (ws?.readyState === WebSocket.OPEN) ws.close();
    }
    await new Promise((r) => setTimeout(r, 200));
});

describe('a press that starts video and audio at once', () => {
    test('authorizes both, not whichever arrived last', async () => {
        // Back to back with no await between them, which is what the two call
        // sites in the video screen actually produce.
        listener.inbox.length = 0;
        listener.binary.length = 0;
        send(sender, 'ptt_video_start', { channel_slug: CHANNEL });
        send(sender, 'ptt_audio_start', { channel_slug: CHANNEL, trace_id: 88001 });

        const refusals = [];
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        for (const message of sender.inbox) {
            if (message.type === 'ptt_error') refusals.push(message.data?.message ?? '?');
        }
        assert.deepEqual(
            refusals, [],
            'one medium was refused because the other superseded its authorization',
        );
    });

    test('the channel is told a stream started', async () => {
        const status = listener.inbox.find((m) => m.type === 'video_stream_status');
        assert.ok(
            status && (status.data?.streamers ?? []).length > 0,
            'no streamer was announced, so the listener never shows an incoming view',
        );
    });

    test('video frames reach the listener', async () => {
        listener.binary.length = 0;
        sender.send(mediaFrame(2, 2048), { binary: true });
        sender.send(mediaFrame(1, 48), { binary: true });
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        const audio = listener.binary.filter((f) => f[0] === 1).length;
        const video = listener.binary.filter((f) => f[0] === 2).length;
        assert.equal(audio, 1, 'audio did not arrive, so the comparison below means nothing');
        assert.equal(
            video, 1,
            'audio arrived and video did not: channelVideoAuthorized was never set, '
            + 'so every type 2 frame was dropped at the relay for the whole transmission',
        );
    });
});
