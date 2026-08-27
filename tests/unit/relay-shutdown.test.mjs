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

function harness({ speakers = [], graceMs = 3000, hardMs = 8000 } = {}) {
    const clients = [fakeClient(), fakeClient()];
    const events = [];
    let clock = 0;
    return {
        clients,
        events,
        activeSpeakers: new Map(speakers.map((id) => [id, { id }])),
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

        // The transmission ends after a couple of polls.
        setTimeout(() => h.activeSpeakers.clear(), 0);
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
