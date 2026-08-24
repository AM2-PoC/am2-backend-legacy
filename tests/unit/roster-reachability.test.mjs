import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rosterFor } = require('../../server/lib/state');

/*
 * The roster is scoped to a channel, and channel access is granted per unit --
 * so two tenants can legitimately share a channel and hear each other. Private
 * calling is scoped to a tenant instead. The two rules never disagreed on
 * paper, only in the interface: the roster offered a call button for a peer
 * the relay would refuse.
 *
 * Filtering the roster by tenant was the wrong repair. Those units really are
 * in the channel and really are audible; hiding them would make the member
 * list disagree with what an operator can hear, and would strip the name from
 * inbound audio. What the roster owes the handset is not a shorter list but an
 * honest one: everyone present, marked with whether a private call is possible.
 */

const row = (id, name, adminId, p2p = true) => ({
    id, name, admin_id: adminId, status: 'online', enable_p2p: p2p,
});

const me = (id, adminId, p2p = true) => ({
    sessionUser: { id, admin_id: adminId },
    enable_p2p: p2p,
});

test('everyone in the channel stays in the roster', () => {
    const rows = [row('A1', 'Ana', 4), row('B1', 'Budi', 1), row('A2', 'Cici', 4)];
    const seen = rosterFor(rows, me('A1', 4)).map((r) => r.id);
    assert.deepEqual(seen, ['A1', 'B1', 'A2'],
        'a unit sharing the channel is audible and must remain listed');
});

test('a peer in another tenant is listed but not callable', () => {
    const rows = [row('A1', 'Ana', 4), row('B1', 'Budi', 1)];
    const roster = rosterFor(rows, me('A1', 4));
    assert.equal(roster.find((r) => r.id === 'B1').can_ptp, false);
});

test('a peer in the same tenant is callable', () => {
    const rows = [row('A1', 'Ana', 4), row('A2', 'Cici', 4)];
    const roster = rosterFor(rows, me('A1', 4));
    assert.equal(roster.find((r) => r.id === 'A2').can_ptp, true);
});

test('a unit is never callable by itself', () => {
    const roster = rosterFor([row('A1', 'Ana', 4)], me('A1', 4));
    assert.equal(roster[0].can_ptp, false);
});

test('private calling off on either side makes it uncallable', () => {
    const rows = [row('A1', 'Ana', 4), row('A2', 'Cici', 4, false)];
    assert.equal(rosterFor(rows, me('A1', 4)).find((r) => r.id === 'A2').can_ptp, false);
    assert.equal(rosterFor(rows, me('A1', 4, false)).find((r) => r.id === 'A2').can_ptp, false);
});

test('the tenant a unit belongs to never reaches the handset', () => {
    const roster = rosterFor([row('A1', 'Ana', 4), row('B1', 'Budi', 1)], me('A1', 4));
    for (const entry of roster) {
        assert.ok(!('admin_id' in entry),
            'admin_id is internal; the roster must not disclose another unit\'s tenant');
    }
});
