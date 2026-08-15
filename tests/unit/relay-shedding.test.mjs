import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A slow listener must not be given an unbounded backlog.
 *
 * Binary frames are forwarded to every client in the room in a synchronous
 * loop, and `ws.send()` is asynchronous: it buffers whatever the socket cannot
 * yet write. Nothing checked how much was already buffered, so a client on a
 * weak downlink accumulated frames inside the relay process without limit.
 *
 * Audio and video reach that client through the same socket, in arrival order,
 * so a ~20 KB video frame buffered ahead of a ~45-byte Opus frame delays the
 * speech by however long the video takes to push. It is the same defect the
 * uplink has, seen from the other end.
 *
 * The rule is the same on both sides: audio is always forwarded, video yields.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = readFileSync(join(ROOT, 'server', 'lib', 'protocol.js'), 'utf8');

test('no binary frame is forwarded without looking at what is already buffered', () => {
    const sends = protocol.match(/\w+\.send\(message, \{ binary: true \}\)/g) || [];
    assert.ok(sends.length > 0, 'the forwarding path was renamed; this test needs updating');
    // Checked by absence of an unguarded send rather than by naming the guard,
    // so a new forwarding path cannot be added without one.
    assert.match(protocol, /bufferedAmount/,
        'nothing consults the per-client buffer before forwarding');
});

test('audio is forwarded to a backed-up client, video is not', () => {
    assert.match(protocol, /shouldForwardBinary|forwardBinaryTo/,
        'there is no single place deciding what a backed-up client receives');
    const decision = protocol.slice(protocol.indexOf('function shouldForwardBinary'));
    assert.match(decision.slice(0, 900), /binaryType === 1|isAudio/,
        'the decision does not distinguish audio from video');
});

test('the downlink budget is a frame, not a buffer', () => {
    const match = protocol.match(/DOWNLINK_VIDEO_BUDGET_BYTES\s*=\s*([0-9_]+)/);
    assert.ok(match, 'the budget is not named');
    const budget = Number(match[1].replace(/_/g, ''));
    assert.ok(budget >= 8000 && budget <= 64000,
        `a budget of ${budget} bytes is a queue by another name`);
});

test('a dropped frame is counted rather than absorbed silently', () => {
    assert.match(protocol, /video_dropped|videoDropped/,
        'video refused for a slow client leaves no trace');
});
