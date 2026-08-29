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

/*
 * The one number three rounds of VOX work were argued without.
 *
 * A microphone returning near-silence and a threshold set too high produce the
 * same thing on the wire: transmissions that last exactly the silence timeout,
 * because the timer is set at the trigger and never refreshed. Telling them
 * apart needs the amplitude VOX measured, and the amplitude lived only in the
 * handset's logcat -- which since Android 4.1 no other app may read, so without
 * a PC and adb it was locked on the device.
 *
 * The relay already receives telemetry from every client and logs it. This is
 * the same road, for the number that actually decides.
 */
test('the relay records the level VOX measured, not only the frames it sent', () => {
    const relay = readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');
    assert.match(relay, /case 'vox_level'/,
        'the relay drops the level report, so it can only be read on the handset');
    assert.match(relay, /event=vox_level/,
        'the level is received and never logged, which is the same as not having it');
});

/*
 * The client half of this is asserted in the client repository, not here.
 *
 * The first version of this file read AudioRecorder.kt through a relative path
 * into a sibling checkout. That exists on a machine where both repositories sit
 * side by side and on no CI runner, so it passed locally and failed in CI --
 * which is the worst direction for a test to be wrong in.
 */
