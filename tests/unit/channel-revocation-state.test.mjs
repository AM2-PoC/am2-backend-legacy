import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const broadcast = readFileSync(new URL('../../server/lib/broadcast.js', import.meta.url), 'utf8');
const start = broadcast.indexOf('const broadcastChannelUpdate');
const end = broadcast.indexOf('\n};', start);
const body = broadcast.slice(start, end);

test('revoked current-room access is torn down by the relay before notification', () => {
    assert.match(body, /activeSpeakers\.get\(room\)\?\.delete\(speaker\)/);
    assert.match(body, /sRem\(`speakers:/);
    assert.match(body, /stopChannelVideo\(ws, room\)/);
    assert.match(body, /channelRooms\.get\(room\)\?\.delete\(ws\)/);
    assert.match(body, /currentRoom = null/);
    assert.match(body, /current_channel = NULL, is_speaking = false/);
    assert.ok(body.indexOf('current_channel = NULL') < body.indexOf("type: 'channels_updated'"),
        'relay announces revoked access before clearing its operational state');
});

test('sync invalidates joins/transmits inside the socket queue and fails closed on dependency error', () => {
    assert.ok(body.indexOf('return serializeChannelState(ws') < body.indexOf('ws.channelJoinGeneration += 1'));
    assert.ok(body.indexOf('ws.channelJoinGeneration += 1') < body.indexOf('await pool.query(`'));
    assert.ok(body.indexOf('ws.transmitAuthGeneration += 1') < body.indexOf('await pool.query(`'));
    assert.match(body, /catch\(async \(error\)[\s\S]*ws\.terminate\(\)[\s\S]*sRem\(`speakers:[\s\S]*stopChannelVideo\(ws, room\)/);
});

test('sync compares refreshed permission with the value before fail-closed invalidation', () => {
    assert.match(body, /const previousRxOnly = ws\.is_rx_only/);
    assert.match(body, /ws\.is_rx_only = newRxOnly;[\s\S]*previousRxOnly !== newRxOnly/);
});
