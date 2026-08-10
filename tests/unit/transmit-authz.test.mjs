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
