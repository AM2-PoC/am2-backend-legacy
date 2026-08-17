// A video streamer that disappears must stop being a streamer.
//
// `ws.on('close')` removes the socket from `activeSpeakers` -- its comment says
// "mencegah audio nyangkut", prevent stuck audio -- and does nothing about
// `activeVideoRooms` or the Redis `video:<room>` set that mirrors it. Video was
// simply forgotten in the half of the lifecycle that nobody drives by hand.
//
// So a handset that was streaming and then died -- app killed, screen off,
// battery, tunnel -- stays listed as a streamer forever. Every other client
// keeps the incoming-video view up and the local preview hidden, with no frames
// ever arriving behind it: a black screen that no amount of client-side work
// can clear, because the relay is still telling them someone is on camera.
//
// It is worse than in-memory state. The entry is persisted to Redis, so it
// survives a relay restart, and `join_channel` restores it from Redis into
// `activeVideoRooms` for every later joiner. One crash while streaming poisons
// the channel indefinitely.
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
        current_device_id: `videoclean-${username}-${Date.now()}`,
    });
    return waitFor(ws, 'login_success');
}

const streamersIn = (message) => message.data?.streamers ?? [];

// The relay announces streamers by display name, not by id, so the name is
// taken from the announcement rather than assumed.
let streamerName = null;
let streamer, observer;

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
});

after(() => {
    for (const ws of [streamer, observer]) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
});

describe('a video streamer that vanishes', () => {
    test('is announced to the channel when it starts', async () => {
        observer.inbox.length = 0;
        send(streamer, 'ptt_video_start', { channel_slug: CHANNEL });
        const status = await waitFor(observer, 'video_stream_status');
        const streamers = streamersIn(status);
        assert.equal(streamers.length, 1, `expected exactly one streamer, saw [${streamers.join(', ')}]`);
        [streamerName] = streamers;
    });

    test('stops being a streamer when its socket dies without ptt_video_end', async () => {
        // A handset sends no courteous goodbye when it is killed, loses power,
        // or drives into a tunnel. This is the ordinary case, not an edge case,
        // and it is the one nothing cleans up.
        assert.ok(streamerName, 'the start announcement did not name a streamer');
        observer.inbox.length = 0;
        streamer.terminate();

        let status;
        try {
            status = await waitFor(observer, 'video_stream_status', 6000);
        } catch {
            assert.fail(
                'the channel was never told the streamer left: close cleans up '
                + 'activeSpeakers and says nothing about activeVideoRooms, so every '
                + 'client keeps the incoming-video view up with no frames behind it',
            );
        }
        assert.ok(
            !streamersIn(status).includes(streamerName),
            `${streamerName} is still announced as streaming after its socket died `
            + `(streamers: [${streamersIn(status).join(', ')}])`,
        );
    });

    test('does not reappear in the next announcement the channel receives', async () => {
        // The ghost lives in `activeVideoRooms`, which every announcement is
        // built from. So the next real stream carries it along -- one crash
        // makes every later announcement in that channel wrong, and the entry is
        // persisted to Redis, so it outlives the relay process too.
        observer.inbox.length = 0;
        send(observer, 'ptt_video_start', { channel_slug: CHANNEL });
        const status = await waitFor(observer, 'video_stream_status');
        try {
            assert.ok(
                !streamersIn(status).includes(streamerName),
                `${streamerName} rode along in a later announcement `
                + `(streamers: [${streamersIn(status).join(', ')}])`,
            );
        } finally {
            send(observer, 'ptt_video_end', { channel_slug: CHANNEL });
        }
    });
});
