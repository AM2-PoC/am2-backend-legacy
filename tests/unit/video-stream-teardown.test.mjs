import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ending a video stream happens in one place.
 *
 * It did not, and that is why the same defect was found five times: on the
 * transmit authorization shared with audio key-down, on disconnect, on rejoin,
 * on the private binary path, and on an administrator withdrawing video
 * permission mid-stream. Each was investigated as its own bug. All of them were
 * one missing function.
 *
 * Ending a stream is four steps -- drop the in-memory entry, drop the mirrored
 * Redis entry, withdraw the per-transmission grant, announce the new list. Every
 * caller open-coded whichever subset it thought of, and the announcement was the
 * one that kept getting missed. Missing it is invisible on the relay and fatal
 * on the handset: viewers keep the incoming-video view up with nothing arriving
 * behind it, which is a black screen no client-side change can clear.
 *
 * These assert by absence, so a sixth caller that open-codes the teardown again
 * fails here rather than in the field.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = readFileSync(join(ROOT, 'server', 'lib', 'protocol.js'), 'utf8');
const routes = readFileSync(join(ROOT, 'server', 'lib', 'routes.js'), 'utf8');
const broadcast = readFileSync(join(ROOT, 'server', 'lib', 'broadcast.js'), 'utf8');

test('the teardown exists as a named operation', () => {
    assert.match(broadcast, /const stopChannelVideo = async/,
        'there is no single place that ends a channel video stream');
    assert.match(broadcast, /module\.exports[\s\S]*stopChannelVideo/,
        'the teardown is not shared with its callers');
});

test('it does all four steps', () => {
    const body = broadcast.slice(broadcast.indexOf('const stopChannelVideo'));
    const fn = body.slice(0, body.indexOf('\n};') + 3);
    assert.match(fn, /\.delete\(entry\)/, 'the in-memory entry is not dropped');
    assert.match(fn, /sRem\(`video:/, 'the Redis mirror is not dropped');
    assert.match(fn, /channelVideoAuthorized = false/, 'the transmission grant is not withdrawn');
    assert.match(fn, /video_stream_status/, 'the room is never told');
});

test('the Redis mirror is cleared even when memory had no entry', () => {
    // A restart repopulates activeVideoRooms from Redis, so a stale key there
    // resurrects a streamer that no longer exists. Clearing it only when the
    // in-memory delete succeeded would leave exactly that.
    const body = broadcast.slice(broadcast.indexOf('const stopChannelVideo'));
    const fn = body.slice(0, body.indexOf('\n};') + 3);
    const sRem = fn.indexOf('sRem(`video:');
    const guard = fn.indexOf('if (!wasStreaming) return false');
    assert.ok(sRem !== -1 && guard !== -1, 'the function no longer has both parts');
    assert.ok(sRem < guard,
        'the Redis mirror is only cleared for a socket memory already knew about');
});

test('nothing else removes a streamer from the room', () => {
    // The add still lives in the ptt_video_start handler, which is fine: only
    // the teardown was ever duplicated. Any *removal* outside the shared
    // function is a sixth copy waiting to drift.
    for (const [name, source] of [['protocol.js', protocol], ['routes.js', routes]]) {
        assert.doesNotMatch(
            source,
            /activeVideoRooms\.get\([^)]*\)\.delete\(|activeVideoRooms\.get\([^)]*\)\s*;\s*[\s\S]{0,80}\.delete\(/,
            `${name} removes a streamer without going through stopChannelVideo`,
        );
        assert.doesNotMatch(
            source,
            /sRem\(`video:/,
            `${name} clears the Redis mirror without going through stopChannelVideo`,
        );
    }
});

test('every place a socket stops streaming calls it', () => {
    // Disconnect, rejoin, and the explicit end, plus permission withdrawal.
    const calls = (protocol.match(/stopChannelVideo\(/g) || []).length;
    assert.ok(calls >= 3,
        `protocol.js ends a video stream in ${calls} place(s); disconnect, rejoin `
        + 'and ptt_video_end must all go through it');
    assert.match(routes, /stopChannelVideo\(/,
        'withdrawing video permission leaves the unit listed as streaming');
});
