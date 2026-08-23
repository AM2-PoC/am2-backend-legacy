import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('../../server/lib/state');

/*
 * Two separate things were both reported as "Personel ini sedang offline".
 *
 * peerFor returns null when the target has no socket at all, and also when it
 * has one but belongs to another tenant. Both reached the same message, so an
 * operator looking at a unit that was plainly online went hunting for a network
 * fault that did not exist. On production, one unit sat under `superadmin`
 * while the three it shared a channel with sat under `ODIE COMM`; every private
 * call between them was refused and reported as the peer being offline.
 *
 * Offline is a true statement about an absent socket and stays. A refusal that
 * is really about tenancy has to say something else -- without saying which
 * tenant, which is not the caller's business.
 */

const socket = (id, adminId, features = {}) => ({
    sessionUser: { id, admin_id: adminId },
    enable_p2p: features.p2p ?? true,
    enable_ptt_video: features.video ?? true,
    readyState: features.readyState ?? 1,
    ptpTargetId: null,
    ptpSessionKind: null,
    ptpInviteIncoming: null,
    ptpInviteOutgoing: null,
    sent: [],
    send(message) { this.sent.push(JSON.parse(message)); },
});

beforeEach(() => { state.activeConnections.clear(); });

test('an absent socket is reported as offline', () => {
    const caller = socket('A1', 'tenant-a');
    state.activeConnections.set('A1', caller);

    assert.deepEqual(state.resolvePeer(caller, 'ghost'), { peer: null, reason: 'offline' });
});

test('a closed socket is reported as offline', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a', { readyState: 3 });
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);

    assert.deepEqual(state.resolvePeer(caller, 'A2'), { peer: null, reason: 'offline' });
});

test('an online peer in another tenant is not reported as offline', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('B1', 'tenant-b');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('B1', target);

    const result = state.resolvePeer(caller, 'B1');
    assert.equal(result.peer, null);
    assert.notEqual(result.reason, 'offline',
        'a unit that is connected must never be described as offline');
    assert.equal(result.reason, 'unavailable');
});

test('the refusal never names the other tenant', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('B1', 'tenant-b');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('B1', target);

    const { reason } = state.resolvePeer(caller, 'B1');
    assert.ok(!/tenant|admin|agen/i.test(reason),
        'the reason travels to the caller and must not disclose tenancy');
});

test('a reachable peer resolves', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);

    assert.deepEqual(state.resolvePeer(caller, 'A2'), { peer: target, reason: 'ok' });
});

test('reachability can be asked about a roster entry without inviting', () => {
    const caller = socket('A1', 'tenant-a');
    const same = socket('A2', 'tenant-a');
    const other = socket('B1', 'tenant-b');
    const noP2p = socket('A3', 'tenant-a', { p2p: false });
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', same);
    state.activeConnections.set('B1', other);
    state.activeConnections.set('A3', noP2p);

    assert.equal(state.canPrivateCall(caller, 'A2'), true);
    assert.equal(state.canPrivateCall(caller, 'B1'), false, 'another tenant is not callable');
    assert.equal(state.canPrivateCall(caller, 'A3'), false, 'a unit with p2p off is not callable');
    assert.equal(state.canPrivateCall(caller, 'A1'), false, 'a unit cannot call itself');
});
