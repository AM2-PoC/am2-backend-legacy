// A private session carries the medium it was accepted for, and nothing else.
//
// The control plane is careful about this. `ptt_video_start_private` demands
// `enable_ptt_video` on both ends and `ptpSessionKind === 'video'`;
// `ptt_audio_start_private` demands `ptpSessionKind === 'audio'`. A comment in
// that handler records an earlier fix: naming any online unit used to be enough
// to start pushing audio at them, so the pairing is now established by
// request/accept and only read afterwards.
//
// The data plane enforces none of it. The binary branch for a private session
// looks up the peer and forwards, without ever reading the frame's media type:
//
//     if (ws.ptpTargetId) {
//         const targetWs = ptpPeerFor(ws, ws.ptpSessionKind);
//         if (targetWs && targetWs.readyState === WebSocket.OPEN
//             && shouldForwardBinary(targetWs, binaryType)) {
//             targetWs.send(message, { binary: true });
//
// So the hardening stopped at the control plane. Two consequences:
//
// Establishing an *audio* call needs only `enable_p2p` -- video permission is
// checked solely by `request_ptp_video`. A unit denied video can therefore open
// an audio call and push video frames through it, and the relay delivers them.
// The per-frame `enable_ptt_video` gate that guards the channel path has no
// counterpart here.
//
// And the peer accepted an audio call. Receiving video in it is a consent
// problem regardless of permissions: their client renders an incoming video
// view for a call they answered as voice.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const TIMEOUT = 8000;
const SETTLE_MS = 700;   // generous: a forwarded frame is one hop on loopback

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
        current_device_id: `ptpkind-${username}-${Date.now()}`,
    });
    return waitFor(ws, 'login_success');
}

/** A frame of the given media type; the payload is irrelevant to forwarding. */
function mediaFrame(binaryType, bytes = 48) {
    const frame = Buffer.alloc(bytes);
    frame[0] = binaryType;
    return frame;
}

let caller, callee;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    caller = await connect('caller');
    callee = await connect('callee');
    await signIn(caller, 'CT_A1');
    await signIn(callee, 'CT_A2');

    // An audio call, accepted as an audio call.
    send(caller, 'request_ptp', { target_id: 'CT_A2' });
    await waitFor(callee, 'ptp_invitation');
    send(callee, 'accept_ptp', { target_id: 'CT_A1' });
    await waitFor(caller, 'ptp_confirmed');
});

after(async () => {
    /*
     * Leave nothing paired, and nothing half-closed.
     *
     * A private session outlives the file that made it: the next file signs the
     * same units in again, and a socket the relay still believes is paired --
     * or still believes is online, because the disconnect grace period has not
     * elapsed -- refuses that login. Cancelling with the wrong peer id and
     * closing in the same tick left exactly that, and it showed up as the next
     * file failing rather than this one.
     */
    if (caller?.readyState === WebSocket.OPEN) send(caller, 'cancel_ptp', { target_id: 'CT_A2' });
    if (callee?.readyState === WebSocket.OPEN) send(callee, 'cancel_ptp', { target_id: 'CT_A1' });
    await new Promise((r) => setTimeout(r, 200));

    await Promise.all([caller, callee].map((ws) => new Promise((resolve) => {
        if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', resolve);
        ws.close();
        setTimeout(resolve, 1000);
    })));
});

describe('a private audio session', () => {
    test('carries the audio it was accepted for', async () => {
        // The guard. A fix that simply stops forwarding would pass the test
        // below and break the product; this is what makes that visible.
        send(caller, 'ptt_audio_start_private', { target_id: 'CT_A2', trace_id: 77001 });
        await waitFor(callee, 'ptt_active_status');

        callee.binary.length = 0;
        caller.send(mediaFrame(1), { binary: true });
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        assert.equal(
            callee.binary.filter((f) => f[0] === 1).length, 1,
            'audio was not delivered in an audio call',
        );
    });

    test('does not carry video the callee never accepted', async () => {
        // No ptt_video_start_private is sent, and none would be honoured: it
        // requires ptpSessionKind === 'video'. The frame is simply pushed onto
        // the socket, which is all an unmodified client would have to do.
        callee.binary.length = 0;
        caller.send(mediaFrame(2, 4096), { binary: true });
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        const video = callee.binary.filter((f) => f[0] === 2);
        assert.equal(
            video.length, 0,
            'video was delivered into a session accepted as audio-only: the peer '
            + 'renders an incoming video view for a call they answered as voice, '
            + 'and enable_ptt_video was never consulted on this path',
        );
    });

    test('still carries audio after a rejected video frame', async () => {
        // A media-type gate must drop the offending frame, not the session.
        callee.binary.length = 0;
        caller.send(mediaFrame(1), { binary: true });
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        assert.equal(
            callee.binary.filter((f) => f[0] === 1).length, 1,
            'the audio path broke after a video frame was refused',
        );
        send(caller, 'ptt_audio_end_private', { target_id: 'CT_A2', trace_id: 77001 });
    });
});
