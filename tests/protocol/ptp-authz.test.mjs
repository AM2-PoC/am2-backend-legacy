// Who is allowed to ring, answer, and push audio at whom.
//
// The private-call family used to take its target straight from the frame.
// `accept_ptp` was the sharpest: it set ptpTargetId on whichever socket the
// caller named, with no check that the named socket had ever invited anyone. So
// one frame from any authenticated unit would reroute a stranger's live audio to
// the sender and drop that stranger out of the channel broadcast — across
// tenants, since activeConnections is a flat global map.
//
// These tests assert the consequence rather than the guard: after a forged
// accept, the victim's audio must still reach the channel and must not reach the
// attacker. A test that only checked for a `ptp_failed` reply would pass while
// the socket was quietly rewritten anyway.
//
// Requires infra/scripts/ptt-harness-fixtures.sh to have run.
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
    ws.binary = [];
    ws.label = label;
    ws.on('message', (data, isBinary) => {
        if (isBinary) { ws.binary.push(Buffer.from(data)); return; }
        try { ws.inbox.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    return new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        setTimeout(() => reject(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, type, data = {}) => ws.send(JSON.stringify({ type, data }));
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ws, type, ms = TIMEOUT) {
    const deadline = Date.now() + ms;
    for (;;) {
        const hit = ws.inbox.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
            throw new Error(`${ws.label}: no ${type} within ${ms}ms; saw [${ws.inbox.map((m) => m.type).join(', ')}]`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

async function signIn(ws, username) {
    send(ws, 'app_login', {
        username,
        password: env.CT_PTT_PASS,
        current_device_id: `ptp-authz-${username}-${Date.now()}`,
    });
    return Promise.race([
        waitFor(ws, 'login_success'),
        waitFor(ws, 'login_error').then((m) => {
            throw new Error(`${username} rejected: ${m.data?.message ?? '?'}`);
        }),
    ]);
}

let victim, attacker, witness;
let victimId, attackerId;

/*
 * The three roles are chosen so the two outcomes are distinguishable.
 *
 * CT_A1 and CT_A2 are the only fixture units in ct_channel_a, so the witness
 * has to be CT_A2 and the attacker has to be someone outside the channel --
 * otherwise "the attacker received the audio" and "the attacker received the
 * channel broadcast like any other member" are the same observation.
 */

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    [victim, attacker, witness] = await Promise.all([
        connect('victim'), connect('attacker'), connect('witness'),
    ]);
    victimId = String((await signIn(victim, 'CT_A1')).data.id ?? 'CT_A1');
    await signIn(witness, 'CT_A2');
    attackerId = String((await signIn(attacker, 'CT_A3')).data.id ?? 'CT_A3');

    // Only the two channel members join; the attacker deliberately stays out.
    send(victim, 'join_channel', { new_channel_slug: CHANNEL });
    send(witness, 'join_channel', { new_channel_slug: CHANNEL });
    await settle(800);
});

after(() => {
    for (const ws of [victim, attacker, witness]) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
});

describe('a private call needs an invitation that exists', () => {
    test('accepting a call nobody made is refused', async () => {
        attacker.inbox.length = 0;
        send(attacker, 'accept_ptp', { target_id: victimId });
        const res = await waitFor(attacker, 'ptp_failed');
        assert.match(String(res.data?.message ?? ''), /tidak ditemukan|offline|no pending/i,
            'the relay accepted an answer to a call that was never placed');
    });

    test("and it does not seize a transmission already in flight", async () => {
        /*
         * The exploit, reproduced in the order that actually reaches it.
         *
         * ptt_audio_start calls clearPtpSession() first, so a forged pairing
         * made *before* the victim keys the mic is torn down by the keying
         * itself -- which is why a naive version of this test passed against
         * vulnerable code and taught us nothing. The window that matters is a
         * transmission already under way: binary frames consult ptpTargetId
         * before anything else, so writing it mid-transmission reroutes live
         * audio away from the channel and into the attacker's socket.
         */
        victim.inbox.length = 0;
        attacker.binary.length = 0;
        witness.binary.length = 0;

        send(victim, 'ptt_audio_start');
        await settle(400);
        victim.send(Buffer.from([1, 0, 0]), { binary: true });
        await settle(400);
        assert.ok(witness.binary.length > 0, 'the channel never carried the first frame');

        // Now, mid-transmission, the forged answer.
        attacker.inbox.length = 0;
        send(attacker, 'accept_ptp', { target_id: victimId });
        await settle(700);

        const before = witness.binary.length;
        attacker.binary.length = 0;
        victim.send(Buffer.from([1, 7, 7]), { binary: true });
        await settle(700);

        assert.equal(attacker.binary.length, 0,
            'a forged answer redirected a live transmission into the attacker\'s socket');
        assert.ok(witness.binary.length > before,
            'the channel stopped receiving the victim mid-transmission');

        send(victim, 'ptt_audio_end');
        await settle(300);
    });

    test('an invitation that was actually sent can be accepted', async () => {
        // The other half: the guard must not have broken the real flow.
        victim.inbox.length = 0;
        attacker.inbox.length = 0;

        send(victim, 'request_ptp', { target_id: attackerId });
        const invite = await waitFor(attacker, 'ptp_invitation');
        assert.equal(String(invite.data?.sender_id), victimId);

        send(attacker, 'accept_ptp', { target_id: victimId });
        const confirmed = await waitFor(victim, 'ptp_confirmed');
        assert.equal(String(confirmed.data?.target_id), attackerId);

        send(attacker, 'cancel_ptp', {});
        await settle(300);
    });

    test('an invitation cannot be redeemed twice', async () => {
        // Accepting consumes it. Otherwise one real invitation becomes a
        // standing permit to re-pair at any later moment.
        attacker.inbox.length = 0;
        send(attacker, 'accept_ptp', { target_id: victimId });
        const res = await waitFor(attacker, 'ptp_failed');
        assert.ok(res, 'the same invitation was accepted a second time');
    });

    test('cancelling a pending invitation invalidates it for both peers', async () => {
        victim.inbox.length = 0;
        attacker.inbox.length = 0;

        send(victim, 'request_ptp', { target_id: attackerId });
        await waitFor(attacker, 'ptp_invitation');
        send(victim, 'cancel_ptp');
        await waitFor(attacker, 'ptp_cancelled');

        attacker.inbox.length = 0;
        victim.inbox.length = 0;
        send(attacker, 'accept_ptp', { target_id: victimId });
        await waitFor(attacker, 'ptp_failed');
        await settle(700);
        assert.equal(victim.inbox.some((m) => m.type === 'ptp_confirmed'), false,
            'a cancelled invitation still established a private session');
    });

    test('an audio invitation cannot be accepted as video', async () => {
        victim.inbox.length = 0;
        attacker.inbox.length = 0;

        send(victim, 'request_ptp', { target_id: attackerId });
        await waitFor(attacker, 'ptp_invitation');
        attacker.inbox.length = 0;
        send(attacker, 'accept_ptp_video', { target_id: victimId });
        await waitFor(attacker, 'ptp_failed');
        send(victim, 'cancel_ptp');
        await settle(300);
    });
});

describe('private calls are tenant isolated', () => {
    test('a unit cannot invite a unit owned by another admin', async () => {
        const outsider = await connect('other-tenant');
        try {
            const outsiderId = String((await signIn(outsider, 'CT_B1')).data.id ?? 'CT_B1');
            victim.inbox.length = 0;
            outsider.inbox.length = 0;
            send(victim, 'request_ptp', { target_id: outsiderId });
            const res = await waitFor(victim, 'ptp_failed');
            assert.ok(res, 'cross-tenant invitation was not rejected');
            await settle(700);
            assert.equal(outsider.inbox.some((m) => m.type === 'ptp_invitation'), false,
                'cross-tenant unit received a private invitation');
        } finally {
            outsider.close();
        }
    });
});

describe('an unauthenticated socket cannot reach anyone', () => {
    test('ptt_video_end_private from a stranger delivers nothing', async () => {
        /*
         * This handler had no session check at all -- the only one in the file
         * that would act for a socket that never logged in. Enumerating a uid
         * was enough to push a state change into that unit's client.
         */
        const stranger = await connect('stranger');
        victim.inbox.length = 0;
        stranger.send(JSON.stringify({
            type: 'ptt_video_end_private', data: { target_id: victimId },
        }));
        await settle(800);
        stranger.close();

        const leaked = victim.inbox.filter((m) => m.type === 'video_stream_status');
        assert.deepEqual(leaked, [],
            'a socket that never signed in delivered a frame to a signed-in unit');
    });

    test('ptt_audio_end_private from a stranger delivers nothing', async () => {
        // Its session check wrapped only the database write; the send sat
        // outside it.
        const stranger = await connect('stranger2');
        victim.inbox.length = 0;
        stranger.send(JSON.stringify({
            type: 'ptt_audio_end_private', data: { target_id: victimId },
        }));
        await settle(800);
        stranger.close();

        const leaked = victim.inbox.filter((m) => m.type === 'ptt_active_status');
        assert.deepEqual(leaked, [],
            'a socket that never signed in delivered a frame to a signed-in unit');
    });
});
