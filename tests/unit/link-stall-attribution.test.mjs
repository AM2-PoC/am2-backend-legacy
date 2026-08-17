import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const protocol = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'lib', 'protocol.js'), 'utf8');

/**
 * A stall is not a loss, and the report has to be able to tell them apart.
 *
 * This transport is TCP. It never delivers a hole -- it delays and then
 * delivers a burst. So "packet loss" is the wrong question to ask of it, and
 * the number that matters is how often arrivals bunch, and whether that
 * coincides with video sharing the same socket.
 *
 * Without the video count beside the gaps, a window with a 194 ms stall cannot
 * be attributed: it looks the same whether a JPEG went out ahead of the speech
 * or the sender's own thread was descheduled.
 */
test('the window counts uplink video as well as audio', () => {
    assert.match(protocol, /uplinkVideoFrames/,
        'nothing counts video arriving on the same socket');
    const report = protocol.slice(protocol.indexOf('function reportLinkQuality'));
    assert.match(report.slice(0, 1800), /video_frames=/,
        'the report cannot say whether video shared the window');
});

test('gaps are bucketed, not only maximised', () => {
    // One worst sample per window says nothing about how often. A count of
    // arrivals that came late is what separates "one hiccup" from "constant".
    assert.match(protocol, /uplinkStalls/, 'late arrivals are not counted');
    const report = protocol.slice(protocol.indexOf('function reportLinkQuality'));
    assert.match(report.slice(0, 1800), /stalls=/, 'the stall count is not reported');
});

test('the window resets both new counters', () => {
    const report = protocol.slice(protocol.indexOf('function reportLinkQuality'));
    const body = report.slice(0, 1800);
    assert.match(body, /uplinkVideoFrames = 0/, 'video count carries across windows');
    assert.match(body, /uplinkStalls = 0/, 'stall count carries across windows');
});
