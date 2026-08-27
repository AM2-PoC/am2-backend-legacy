// A restart should end transmissions, not sever them.
//
// The unit sends SIGINT and the relay has no handler for it, so Node exits on
// the spot. Every WebSocket dies at the TCP layer with no close frame: the
// handset does not learn it is disconnected until the socket times out, and
// whoever was mid-sentence is cut mid-word.
//
// A WebSocket lives inside one process and cannot survive that process ending
// -- that part is inherent. What is not inherent is severing it without
// warning. `TimeoutStopSec=30` was already granted by the unit file and never
// used by anything: nothing stopped accepting, nothing waited, nothing closed.
//
// So: stop listening, let the transmissions that are already in the air finish,
// then close every socket with 1001 "going away". The client reconnects on any
// close code once authorized and its first retry is immediate, so a clean close
// is a sub-second gap between transmissions instead of a cut inside one.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { drain, installShutdown } = createRequire(import.meta.url)('../../server/lib/shutdown.js');

/** A socket that records how it was closed. */
function fakeClient() {
    return {
        readyState: 1,
        closed: null,
        terminated: false,
        close(code, reason) { this.closed = { code, reason }; },
        terminate() { this.terminated = true; },
    };
}

/*
 * activeSpeakers is a Map keyed by channel whose values are Sets of speakers.
 * A channel gets its key the moment somebody joins it, and that key is never
 * removed -- only the members of its Set are. So `.size` counts channels that
 * have ever seen a join, which on a live relay is permanently non-zero.
 *
 * The first version of the drain read `.size` and waited its full grace on
 * every shutdown, then logged "2 transmission(s) still open" against a database
 * that said nobody was even connected.
 */
function harness({ speakers = [], idleChannels = [], graceMs = 3000, hardMs = 8000 } = {}) {
    const clients = [fakeClient(), fakeClient()];
    const events = [];
    let clock = 0;
    return {
        clients,
        events,
        activeSpeakers: new Map([
            ...idleChannels.map((channel) => [channel, new Set()]),
            ...(speakers.length ? [['ch_live', new Set(speakers)]] : []),
        ]),
        opts: {
            server: { close: () => events.push('server.close') },
            wss: { clients: new Set(clients) },
            graceMs,
            hardMs,
            pollMs: 10,
            now: () => clock,
            wait: async (ms) => { clock += ms; events.push(`wait:${ms}`); },
            log: (line) => events.push(`log:${line}`),
        },
    };
}

describe('draining the relay', () => {
    test('stops accepting before it closes anything', async () => {
        const h = harness();
        await drain({ ...h.opts, activeSpeakers: h.activeSpeakers });

        assert.equal(h.events[0], 'server.close',
            'sockets were closed before the listener stopped accepting new ones');
    });

    test('closes every client with going-away, not a severed connection', async () => {
        const h = harness();
        await drain({ ...h.opts, activeSpeakers: h.activeSpeakers });

        for (const client of h.clients) {
            assert.deepEqual(
                client.closed, { code: 1001, reason: 'server restarting' },
                'a client was not closed cleanly',
            );
            assert.equal(client.terminated, false, 'a client was terminated rather than closed');
        }
    });

    test('waits for a transmission already in the air', async () => {
        const h = harness({ speakers: ['OD1'] });
        const finished = drain({ ...h.opts, activeSpeakers: h.activeSpeakers });

        // The transmission ends after a couple of polls. The channel keeps its
        // key, exactly as the relay leaves it.
        setTimeout(() => h.activeSpeakers.get('ch_live').clear(), 0);
        await finished;

        assert.ok(h.events.some((e) => e.startsWith('wait:')), 'it did not wait at all');
        assert.deepEqual(h.clients[0].closed, { code: 1001, reason: 'server restarting' });
    });

    test('never waits past its own deadline', async () => {
        // Somebody holding the button must not hold the deploy. The grace is a
        // ceiling, not a promise.
        const h = harness({ speakers: ['OD1'], graceMs: 100 });
        await drain({ ...h.opts, activeSpeakers: h.activeSpeakers });

        const waited = h.events.filter((e) => e.startsWith('wait:')).length;
        assert.ok(waited <= 11, `waited ${waited} polls past a 100ms grace`);
        assert.equal(h.clients[0].closed.code, 1001, 'a stuck transmission blocked the close');
    });

    test('a second signal does not start a second shutdown', async () => {
        const h = harness();
        const exits = [];
        const handlers = new Map();
        installShutdown({
            ...h.opts,
            activeSpeakers: h.activeSpeakers,
            exit: (code) => exits.push(code),
            on: (signal, fn) => handlers.set(signal, fn),
        });

        assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM'],
            'the relay does not handle the signals its unit actually sends');

        await handlers.get('SIGTERM')();
        await handlers.get('SIGINT')();

        assert.equal(exits.length, 1, 'a second signal ran the shutdown again');
        assert.equal(h.events.filter((e) => e === 'server.close').length, 1);
    });
});

test('an idle channel is not a transmission', () => {
    // Every channel anybody has joined since boot holds a key here forever.
    // Reading the Map's size makes each of them look like somebody talking, so
    // the drain waits its whole grace on every shutdown and says so in the log.
    const h = harness({ idleChannels: ['ch_a', 'ch_b'] });
    return drain({ ...h.opts, activeSpeakers: h.activeSpeakers }).then(() => {
        assert.ok(!h.events.some((e) => e.startsWith('wait:')),
            'the drain waited although nobody was transmitting');
    });
});

test('it counts the people talking, not the rooms they are in', async () => {
    // Two people talking, in one of three channels: the two numbers differ,
    // which is the only way to tell which one is being reported.
    const h = harness({ speakers: ['OD1:JOKO', 'OD2:ALI'], idleChannels: ['ch_a', 'ch_b'] });
    setTimeout(() => h.activeSpeakers.get('ch_live').clear(), 0);
    await drain({ ...h.opts, activeSpeakers: h.activeSpeakers });

    const counted = h.events.find((e) => /transmission/.test(e));
    assert.ok(counted, 'the drain never reported what it was waiting for');
    assert.doesNotMatch(counted, /\b3\b/,
        'the count included a channel with nobody talking in it');
});
