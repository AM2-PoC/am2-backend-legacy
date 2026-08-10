// Permission is checked when the unit transmits, not only when it joined.
//
// is_rx_only was written once, at join, and then stood in for authorization on
// every transmission for the life of the socket. Demoting a unit to RX in the
// database did not reach it: unless something happened to call
// POST /api/admin/set-permission, or the unit rejoined, it kept transmitting on
// a permission it no longer had — for as long as it stayed connected, which on
// a dispatch handset is the whole shift.
//
// These tests change the database underneath a live socket, which is exactly
// the case the cache hid.
//
// Requires infra/scripts/ptt-harness-fixtures.sh to have run.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { env, NODE_URL } from '../contract/helpers.mjs';

const require = createRequire(process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js');
const WebSocket = require('ws');

const WS_URL = (process.env.CT_NODE_URL || NODE_URL).replace(/^http/, 'ws');
const TIMEOUT = 8000;
const CHANNEL = 'ct_channel_a';

/** Staging only, and named here so the guard in the script is not the only one. */
const psql = (sql) => execFileSync('sudo', ['-u', 'postgres', 'psql', '-tAd', 'am2_staging', '-c', sql],
    { encoding: 'utf8' }).trim();

function connect(label) {
    const ws = new WebSocket(WS_URL);
    ws.inbox = []; ws.binary = []; ws.label = label;
    ws.on('message', (d, isBinary) => {
        if (isBinary) { ws.binary.push(Buffer.from(d)); return; }
        try { ws.inbox.push(JSON.parse(d.toString())); } catch { /* ignore */ }
    });
    return new Promise((res, rej) => {
        ws.once('open', () => res(ws));
        ws.once('error', rej);
        setTimeout(() => rej(new Error(`${label}: connect timed out`)), TIMEOUT);
    });
}

const send = (ws, t, data = {}) => ws.send(JSON.stringify({ type: t, data }));
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
        username, password: env.CT_PTT_PASS,
        current_device_id: `transmit-authz-${username}-${Date.now()}`,
    });
    return Promise.race([
        waitFor(ws, 'login_success'),
        waitFor(ws, 'login_error').then((m) => { throw new Error(`${username}: ${m.data?.message}`); }),
    ]);
}

let unit, listener;

before(async () => {
    assert.ok(env.CT_PTT_PASS, 'run infra/scripts/ptt-harness-fixtures.sh first');
    [unit, listener] = await Promise.all([connect('unit'), connect('listener')]);
    await signIn(unit, 'CT_A1');
    await signIn(listener, 'CT_A2');
    send(unit, 'join_channel', { new_channel_slug: CHANNEL });
    send(listener, 'join_channel', { new_channel_slug: CHANNEL });
    await waitFor(unit, 'join_channel_success');
    await settle(400);
});

after(() => {
    // Whatever the tests did to the fixture, put it back.
    try {
        psql(`UPDATE public.user_channels uc SET permission = 'FULL DUPLEX'
              FROM public.channels c WHERE c.id = uc.channel_id
                AND uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);
    } catch { /* the fixture script will repair it on the next run */ }
    for (const ws of [unit, listener]) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    }
});

describe('a permission change reaches a socket that is already connected', () => {
    test('a unit demoted to RX mid-session cannot transmit', async () => {
        /*
         * The socket joined as FULL DUPLEX and never rejoins. Under the cached
         * check it would keep transmitting; the only correct answer is a
         * refusal, because the database no longer says it may.
         */
        psql(`UPDATE public.user_channels uc SET permission = 'RX'
              FROM public.channels c WHERE c.id = uc.channel_id
                AND uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);

        unit.inbox.length = 0;
        listener.binary.length = 0;
        send(unit, 'ptt_audio_start');
        const err = await waitFor(unit, 'ptt_error');
        assert.match(String(err.data?.message ?? ''), /receive-only|member/i,
            'the relay let a demoted unit key the mic');

        // And the refusal has to be real, not just a message: no audio may pass.
        unit.send(Buffer.from([1, 4, 4]), { binary: true });
        await settle(700);
        assert.equal(listener.binary.length, 0,
            'the demoted unit still put audio on the channel');
    });

    test('restoring the permission lets it transmit again', async () => {
        // The other half: the check must read the database each time, not latch
        // the first refusal.
        psql(`UPDATE public.user_channels uc SET permission = 'FULL DUPLEX'
              FROM public.channels c WHERE c.id = uc.channel_id
                AND uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);

        unit.inbox.length = 0;
        listener.binary.length = 0;
        send(unit, 'ptt_audio_start');
        await settle(500);
        const refused = unit.inbox.find((m) => m.type === 'ptt_error');
        assert.equal(refused, undefined, `still refused after restore: ${refused?.data?.message}`);

        unit.send(Buffer.from([1, 5, 5]), { binary: true });
        await settle(700);
        assert.ok(listener.binary.length > 0, 'audio did not resume after the permission came back');
        send(unit, 'ptt_audio_end');
        await settle(300);
    });

    test('losing membership entirely is refused too', async () => {
        // Not just a demotion: a row that is gone must not read as "allowed".
        const row = psql(`SELECT uc.channel_id FROM public.user_channels uc
                          JOIN public.channels c ON c.id = uc.channel_id
                          WHERE uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);
        psql(`DELETE FROM public.user_channels WHERE user_id = 'CT_A1' AND channel_id = ${row}`);
        try {
            unit.inbox.length = 0;
            send(unit, 'ptt_audio_start');
            const err = await waitFor(unit, 'ptt_error');
            assert.match(String(err.data?.message ?? ''), /member/i,
                'a unit with no membership row was allowed to transmit');
        } finally {
            psql(`INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
                  VALUES ('CT_A1', ${row}, true, 'FULL DUPLEX')
                  ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = 'FULL DUPLEX'`);
        }
    });

    test('losing membership entirely also refuses channel video', async () => {
        const row = psql(`SELECT uc.channel_id FROM public.user_channels uc
                          JOIN public.channels c ON c.id = uc.channel_id
                          WHERE uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);
        psql(`DELETE FROM public.user_channels WHERE user_id = 'CT_A1' AND channel_id = ${row}`);
        try {
            unit.inbox.length = 0;
            listener.inbox.length = 0;
            send(unit, 'ptt_video_start');
            const err = await waitFor(unit, 'ptt_error');
            assert.match(String(err.data?.message ?? ''), /member/i,
                'video was allowed after channel membership was deleted');
            await settle(500);
            assert.equal(listener.inbox.some((m) => m.type === 'video_stream_status'), false,
                'a non-member was announced as a video streamer');
        } finally {
            psql(`INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
                  VALUES ('CT_A1', ${row}, true, 'FULL DUPLEX')
                  ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = 'FULL DUPLEX'`);
        }
    });

    test('a unit demoted to RX cannot start channel video', async () => {
        psql(`UPDATE public.user_channels uc SET permission = 'RX'
              FROM public.channels c WHERE c.id = uc.channel_id
                AND uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);

        unit.inbox.length = 0;
        listener.inbox.length = 0;
        send(unit, 'ptt_video_start');
        const err = await waitFor(unit, 'ptt_error');
        assert.match(String(err.data?.message ?? ''), /receive-only/i,
            'RX permission still allowed channel video');
        await settle(500);
        assert.equal(listener.inbox.some((m) =>
            m.type === 'video_stream_status'
            && m.data?.streamers?.includes('Contract Unit A1')), false,
        'RX unit was announced as a channel video streamer');
    });

    test('restoring FULL DUPLEX lets channel video start again', async () => {
        psql(`UPDATE public.user_channels uc SET permission = 'FULL DUPLEX'
              FROM public.channels c WHERE c.id = uc.channel_id
                AND uc.user_id = 'CT_A1' AND c.name = '${CHANNEL}'`);

        unit.inbox.length = 0;
        listener.inbox.length = 0;
        send(unit, 'ptt_video_start');
        await waitFor(listener, 'video_stream_status');
        assert.equal(unit.inbox.some((m) => m.type === 'ptt_error'), false,
            'video stayed refused after permission restoration');
        send(unit, 'ptt_video_end');
        await settle(300);
    });
});

describe('joining a channel you do not belong to says so', () => {
    test('join_channel answers instead of going quiet', async () => {
        /*
         * There was no else branch: the handset asked, the relay logged
         * nothing, sent nothing, and the client waited for a success that was
         * never coming. From the field that is indistinguishable from the relay
         * being down.
         */
        unit.inbox.length = 0;
        send(unit, 'join_channel', { new_channel_slug: 'ct_channel_a3' });
        const res = await waitFor(unit, 'join_error', 5000);
        assert.match(String(res.data?.message ?? ''), /member/i);

        // Put the unit back where the other tests expect it.
        send(unit, 'join_channel', { new_channel_slug: CHANNEL });
        await waitFor(unit, 'join_channel_success');
    });
});
