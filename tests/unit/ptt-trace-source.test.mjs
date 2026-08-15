import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

function block(from, to) {
    const start = source.indexOf(from);
    assert.notEqual(start, -1, `${from} missing`);
    const end = source.indexOf(to, start + from.length);
    assert.notEqual(end, -1, `${to} missing after ${from}`);
    return source.slice(start, end);
}

const publicStart = block("case 'ptt_audio_start':", "case 'ptt_audio_end':");
const publicEnd = block("case 'ptt_audio_end':", "case 'ptt_video_start':");
const privateStart = block("case 'ptt_audio_start_private':", "case 'ptt_audio_end_private':");
const privateEnd = block("case 'ptt_audio_end_private':", "case 'request_ptp':");

test('PTT tracing is opt-in and records monotonic metadata only', () => {
    assert.match(source, /process\.env\.AM2_PTT_TRACE === '1'/);
    assert.match(source, /process\.hrtime\.bigint\(\)/);
    assert.match(source, /PTT_TRACE_SAMPLE_EVERY_FRAMES = 25/);
    assert.match(source, /shouldSamplePttFrame\(ws\.pttFrameSequence\)/);
    assert.doesNotMatch(source, /tracePtt\([^)]*(username|password|latitude|longitude|payload)/);
});

test('channel PTT relays sender trace IDs across start and end status', () => {
    assert.match(publicStart, /Number\.isSafeInteger\(data\.trace_id\)/);
    assert.match(publicStart, /trace_id: ws\.pttTraceId/);
    assert.match(publicStart, /tracePtt\('start_received'/);
    assert.match(publicStart, /tracePtt\('start_forwarded'/);
    assert.match(publicEnd, /trace_id: ws\.pttTraceId/);
    assert.match(publicEnd, /tracePtt\('end_forwarded'/);
});

test('channel PTT explicitly acknowledges authorization before the client captures', () => {
    const broadcast = publicStart.indexOf("broadcastToChannel(ws.currentRoom");
    const acknowledgement = publicStart.indexOf("type: 'ptt_audio_start_authorized'");
    assert.ok(broadcast >= 0, 'start must broadcast its active status');
    assert.ok(acknowledgement > broadcast,
        'acknowledge only after authorization and active-speaker state are established');
    assert.match(publicStart.slice(acknowledgement), /trace_id: ws\.pttTraceId/);
});

test('private PTT uses the same trace boundary', () => {
    assert.match(privateStart, /Number\.isSafeInteger\(data\.trace_id\)/);
    assert.match(privateStart, /trace_id: ws\.pttTraceId/);
    assert.match(privateStart, /tracePtt\('start_received'/);
    assert.match(privateEnd, /trace_id: ws\.pttTraceId/);
    assert.match(privateEnd, /tracePtt\('end_forwarded'/);
});

test('private PTT acknowledges authorization with the sender trace', () => {
    assert.match(privateStart, /type: 'ptt_audio_start_authorized'/);
    assert.match(privateStart, /trace_id: ws\.pttTraceId/);
});

test('binary audio records received and forwarded frame metadata', () => {
    assert.match(source, /tracePtt\('frame_received'/);
    assert.match(source, /tracePtt\('frame_forwarded'/);
    assert.match(source, /frameBytes: message\.length/);
});
