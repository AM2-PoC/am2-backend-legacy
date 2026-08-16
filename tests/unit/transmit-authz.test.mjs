import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { authorizeChannelTransmit, transmitErrorMessage } = require('../../server/lib/transmit-authz');

const socket = () => ({
    sessionUser: { id: 'CT_A1' },
    currentRoom: 'ct_channel_a',
    is_rx_only: false,
});

test('RX is denied for every media handler using the shared authorization result', async () => {
    const ws = socket();
    const result = await authorizeChannelTransmit(ws, async () => ({ permission: 'RX' }));

    assert.deepEqual(result, { ok: false, reason: 'receive_only' });
    assert.equal(ws.is_rx_only, true);
    assert.match(transmitErrorMessage(result.reason), /receive-only/i);
});

test('restored FULL DUPLEX permission clears the stale RX cache', async () => {
    const ws = socket();
    ws.is_rx_only = true;

    const result = await authorizeChannelTransmit(ws, async () => ({ permission: 'FULL DUPLEX', id: 1 }));

    assert.equal(result.ok, true);
    assert.equal(ws.is_rx_only, false);
});

test('an older permission lookup cannot overwrite a newer decision', async () => {
    const ws = socket();
    let releaseFirst;
    const firstLookup = () => new Promise((resolve) => { releaseFirst = resolve; });

    const first = authorizeChannelTransmit(ws, firstLookup);
    const second = await authorizeChannelTransmit(ws, async () => ({ permission: 'RX' }));
    assert.equal(second.ok, false);
    assert.equal(ws.is_rx_only, true);

    releaseFirst({ permission: 'FULL DUPLEX' });
    const stale = await first;
    assert.deepEqual(stale, { ok: false, reason: 'stale' });
    assert.equal(ws.is_rx_only, true,
        'stale FULL DUPLEX lookup restored transmit authorization');
});

test('a permission result for the old room is discarded after a channel change', async () => {
    const ws = socket();
    let release;
    const pending = authorizeChannelTransmit(ws,
        () => new Promise((resolve) => { release = resolve; }));

    ws.currentRoom = 'ct_channel_b';
    release({ permission: 'FULL DUPLEX' });

    assert.deepEqual(await pending, { ok: false, reason: 'stale' });
    assert.equal(ws.is_rx_only, true);
});

test('transmit authorization is refused while a channel change is in progress', async () => {
    const ws = socket();
    ws.channelTransitioning = true;
    let queried = false;

    const result = await authorizeChannelTransmit(ws, async () => {
        queried = true;
        return { permission: 'FULL DUPLEX' };
    });

    assert.deepEqual(result, { ok: false, reason: 'stale' });
    assert.equal(queried, false);
    assert.equal(ws.is_rx_only, true);
});

test('a stale lookup failure cannot revoke a newer successful decision', async () => {
    const ws = socket();
    let rejectFirst;
    const first = authorizeChannelTransmit(ws,
        () => new Promise((_resolve, reject) => { rejectFirst = reject; }));

    const current = await authorizeChannelTransmit(ws,
        async () => ({ permission: 'FULL DUPLEX' }));
    assert.equal(current.ok, true);
    assert.equal(ws.is_rx_only, false);

    rejectFirst(new Error('late database failure'));
    assert.deepEqual(await first, { ok: false, reason: 'stale' });
    assert.equal(ws.is_rx_only, false,
        'stale failure clobbered a newer FULL DUPLEX decision');
});

test('missing membership fails closed and invalidates binary-frame authorization', async () => {
    const ws = socket();
    const result = await authorizeChannelTransmit(ws, async () => null);

    assert.deepEqual(result, { ok: false, reason: 'not_member' });
    assert.equal(ws.is_rx_only, true);
    assert.match(transmitErrorMessage(result.reason), /member/i);
});

test('database failure fails closed without rejecting the websocket handler', async () => {
    const ws = socket();
    const failure = new Error('database offline');

    const result = await authorizeChannelTransmit(ws, async () => { throw failure; });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'authorization_unavailable');
    assert.equal(result.error, failure);
    assert.equal(ws.is_rx_only, true);
    assert.match(transmitErrorMessage(result.reason), /temporarily unavailable/i);
});

/**
 * A running video stream must survive a push-to-talk press.
 *
 * `channelVideoAuthorized` gates every binary type 2 frame at the relay. It is
 * granted once, by `ptt_video_start`, and nothing else ever sets it back to
 * true. Key-down for *audio* runs through the same authorization helper, so if
 * that helper clears the flag, the first press after a stream begins silently
 * discards every subsequent video frame -- for the rest of the stream, with no
 * error on either end. The receiver keeps its ImageView visible and draws
 * nothing: a black screen.
 *
 * On a push-to-talk radio the press is the primary interaction, so this is not
 * an edge case. Video is authorized, then revoked seconds later by the app's
 * most common action.
 */
test('a push-to-talk press does not revoke an authorized video stream', async () => {
    const ws = socket();
    ws.channelVideoAuthorized = true;   // ptt_video_start already granted it

    const result = await authorizeChannelTransmit(ws, async () => ({ permission: 'FULL DUPLEX', id: 1 }));

    assert.equal(result.ok, true);
    assert.equal(ws.channelVideoAuthorized, true,
        'the audio key-down revoked the in-progress video stream');
});

test('losing channel permission still stops video, not just audio', async () => {
    // The reason the flag was cleared up front was freshness: a revoked user
    // must stop sending. That must survive the fix above.
    const ws = socket();
    ws.channelVideoAuthorized = true;

    const result = await authorizeChannelTransmit(ws, async () => null);

    assert.equal(result.ok, false);
    assert.equal(ws.channelVideoAuthorized, false,
        'a user removed from the channel kept video authorization');
});

test('a receive-only downgrade stops video too', async () => {
    const ws = socket();
    ws.channelVideoAuthorized = true;

    await authorizeChannelTransmit(ws, async () => ({ permission: 'RX' }));

    assert.equal(ws.channelVideoAuthorized, false);
});
