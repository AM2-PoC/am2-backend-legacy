import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The relay can measure the network without help from a device.
 *
 * Two measurements were sitting unused. The keepalive already pings every
 * client and receives a pong, but the send time was discarded, so a round trip
 * that the relay observes on every interval was never turned into a number.
 * And audio arrives at a known rate — one frame every 20 ms — so the spread of
 * inter-arrival times at the relay *is* the uplink jitter, measurable from
 * arrival timestamps alone.
 *
 * This matters because until now every statement about the network has come
 * from a device that had to be held, instrumented and read back. These numbers
 * come from a server that is already running.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = readFileSync(join(ROOT, 'server', 'lib', 'protocol.js'), 'utf8');

test('the keepalive round trip is measured, not discarded', () => {
    assert.match(protocol, /pingSentAt/,
        'the ping send time is still thrown away');
    const pong = protocol.slice(protocol.indexOf("ws.on('pong'"), protocol.indexOf("ws.on('pong'") + 400);
    assert.match(pong, /rtt/i, 'the pong does not produce a round trip time');
});

test('uplink jitter is estimated from arrival spacing', () => {
    // Audio is produced every 20 ms, so the deviation from that spacing at the
    // relay is the jitter the network added. No device cooperation needed.
    assert.match(protocol, /FRAME_INTERVAL_MS/);
    assert.match(protocol, /jitter/i);
    assert.match(protocol, /lastAudioArrivalNs|lastAudioArrival/);
});

test('the estimate is smoothed rather than reporting the last sample', () => {
    // A single late frame is not jitter. RFC 3550 smooths the deviation so a
    // number can be read at any moment and mean something.
    const jitter = protocol.slice(protocol.indexOf('function observeAudioArrival'));
    assert.match(jitter.slice(0, 900), /\/\s*16|0\.0625/,
        'the deviation is not smoothed');
});

test('per-client link state is reported with the client backlog', () => {
    // bufferedAmount already decides whether video is forwarded; reporting it
    // alongside RTT and jitter is what makes a slow listener identifiable.
    assert.match(protocol, /link_quality|linkQuality/);
    assert.match(protocol, /bufferedAmount/);
});

test('measuring costs nothing when it is switched off', () => {
    // This runs on a 50 Hz path. It must not allocate or format when disabled.
    const observe = protocol.slice(protocol.indexOf('function observeAudioArrival'));
    assert.match(observe.slice(0, 300), /if \(!linkStatsEnabled\) return|linkStatsEnabled/,
        'the hot path does work even when reporting is off');
});

/**
 * The numbers this log line reports must be true.
 *
 * They were not. `uplink_worst_ms=174780` was reported inside a 15 second
 * window -- 174 seconds of "jitter" that could not have happened. Two defects
 * produced it, and both made the metric read high in a way that looked like a
 * network problem and was not.
 */
test('the worst-case sample is cleared even for a client that reported nothing', () => {
    // The reset lives after an early return taken by every idle client, so the
    // worst sample was never cleared for anyone who stopped transmitting. It
    // accumulated across the whole session and was reported as if it were
    // recent.
    const body = protocol.slice(protocol.indexOf('function reportLinkQuality')).slice(0, 1600);
    assert.ok(body.includes('uplinkWorstMs = 0'), 'the worst sample is never cleared');
    assert.doesNotMatch(
        body,
        /!ws\.uplinkFrames\)\s*return/,
        'an idle client returns before the reset and keeps a stale worst sample forever',
    );
});

test('the gap between transmissions is not counted as jitter', () => {
    // Audio arrives every 20 ms *while a key is down*. The gap between one
    // transmission and the next is seconds of silence, and measuring it against
    // a 20 ms expectation turns ordinary radio use into enormous fake jitter.
    assert.match(protocol, /lastAudioArrivalNs\s*=\s*(null|0n|undefined)/,
        'the arrival clock is never reset when a transmission ends');
});
