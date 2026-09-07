// Why a socket ended, and how long it lasted.
//
// The relay recorded every login and nothing about the endings. In production
// one handset produced ninety-five logins a day, through the night, and the
// journal could not say whether the relay had killed it for a missing pong, the
// handset had gone away, or something in between had cut it. Those three have
// different causes and are fixed in different places, and the record could not
// tell them apart -- so every explanation offered for the churn was a guess
// wearing evidence's clothes.
//
// A ping timeout and a handset hanging up both reach 'close' with code 1006.
// The only moment they are distinguishable is before terminate() runs, which is
// why the cause is stamped there rather than inferred later.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');
const OBSERVABILITY = fs.readFileSync(new URL('../../server/lib/disconnect-observability.js', import.meta.url), 'utf8');

function disconnectLog() {
    const at = OBSERVABILITY.indexOf('event=client_disconnect');
    assert.ok(at > 0, 'the relay records logins but still says nothing about endings');
    const start = OBSERVABILITY.lastIndexOf('return `', at);
    const end = OBSERVABILITY.indexOf(';', at);
    assert.ok(end > start, 'the disconnect log is not a single statement any more');
    return OBSERVABILITY.slice(start, end);
}

describe('client_disconnect', () => {
    test('it separates a relay-side kill from a handset going away', () => {
        assert.match(disconnectLog(), /cause=/,
            'the record cannot distinguish a missing pong from a peer that hung '
            + 'up, and those are fixed in different places');
        assert.match(PROTOCOL, /markCloseCause\(ws, 'ping_timeout'\)/,
            'nothing marks the socket the relay itself decided to destroy');
    });

    test('the cause is stamped before the socket is destroyed', () => {
        // After terminate() the two are identical: both arrive as 1006. If the
        // assignment ever moves below the call, this record silently becomes
        // "peer" for every relay-side kill -- which reads as evidence rather
        // than as a gap.
        const mark = PROTOCOL.indexOf("markCloseCause(ws, 'ping_timeout')");
        const kill = PROTOCOL.indexOf('ws.terminate()', mark);
        assert.ok(mark > 0 && kill > mark,
            'the cause is set after terminate(), so it can never be observed');
    });

    test('it records how long the socket held', () => {
        assert.match(disconnectLog(), /held_seconds=/,
            'without a duration, a socket that lasted five hours and one that '
            + 'lasted forty seconds leave the same trace');
        assert.match(PROTOCOL, /ws\.connectedAtNs = process\.hrtime\.bigint\(\)/,
            'nothing records when the socket opened, so no duration can be real');
    });

    test('duration uses a monotonic clock rather than wall time', () => {
        assert.match(PROTOCOL, /connectedAtNs\s*=\s*process\.hrtime\.bigint\(\)/,
            'wall-clock changes can make a connection duration negative or too large');
        assert.match(OBSERVABILITY, /nowNs\s*-\s*ws\.connectedAtNs/,
            'disconnect duration is not derived from the monotonic connection clock');
    });

    test('known server-side terminations identify their own cause', () => {
        const routes = fs.readFileSync(new URL('../../server/lib/routes.js', import.meta.url), 'utf8');
        const shutdown = fs.readFileSync(new URL('../../server/lib/shutdown.js', import.meta.url), 'utf8');
        assert.match(routes, /markCloseCause\([^,]+, 'admin_force_logout'\)[\s\S]{0,200}?terminate\(\)/,
            'an admin-forced disconnect would be reported as a peer/network ending');
        assert.match(PROTOCOL, /markCloseCause\([^,]+, 'session_replaced'\)[\s\S]{0,200}?terminate\(\)/,
            'a replaced session would be reported as a peer/network ending');
        assert.match(shutdown, /markCloseCause\([^,]+, 'server_shutdown'\)[\s\S]{0,200}?\.close\(/,
            'an orderly relay shutdown would be reported as a peer/network ending');
    });

    test('free text from the handset cannot forge a journal line', () => {
        const body = disconnectLog();
        assert.doesNotMatch(body, /\$\{reason/,
            'the close reason is interpolated raw, so a crafted value writes its own line');
        assert.match(body, /typeof code === 'number'/,
            'a non-numeric close code would be printed as though it were measured');
    });

    test('an unauthenticated socket does not fill the journal', () => {
        // The relay is on the public internet and is scanned. A disconnect line
        // per probe would bury the handsets this record exists to explain.
        assert.match(OBSERVABILITY, /disconnectUserId === null[\s\S]{0,200}?return null/,
            'every closed socket logs, including scanners that never signed in');
    });
});
