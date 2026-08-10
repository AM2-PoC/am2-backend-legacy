import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('../../server/lib/state');

const socket = (id, adminId, features = {}) => ({
    sessionUser: { id, admin_id: adminId },
    enable_p2p: features.p2p ?? true,
    enable_ptt_video: features.video ?? true,
    ptpTargetId: null,
    ptpSessionKind: null,
    ptpInviteIncoming: null,
    ptpInviteOutgoing: null,
    readyState: 1,
    sent: [],
    send(message) { this.sent.push(JSON.parse(message)); },
});

beforeEach(() => {
    state.activeConnections.clear();
});

test('a private-call invitation cannot cross tenant boundaries', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('B1', 'tenant-b');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('B1', target);

    const result = state.createPtpInvite(caller, target, 'audio', 1000);

    assert.deepEqual(result, { ok: false, reason: 'peer_unavailable' });
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('a target with private calling disabled cannot be invited', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a', { p2p: false });
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);

    const result = state.createPtpInvite(caller, target, 'audio', 1000);

    assert.deepEqual(result, { ok: false, reason: 'feature_disabled' });
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('a target with video disabled cannot receive a video invitation', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a', { video: false });
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);

    const result = state.createPtpInvite(caller, target, 'video', 1000);

    assert.deepEqual(result, { ok: false, reason: 'feature_disabled' });
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('an audio invitation cannot be consumed as a video invitation', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);
    assert.deepEqual(state.createPtpInvite(caller, target, 'audio', 1000), { ok: true });

    const result = state.consumePtpInvite(target, 'A1', 'video', 2000);

    assert.deepEqual(result, { ok: false, reason: 'invite_missing' });
    assert.equal(caller.ptpTargetId, null);
    assert.equal(target.ptpTargetId, null);
});

test('cancelling an unanswered invitation invalidates both halves', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);
    state.createPtpInvite(caller, target, 'audio', 1000);

    state.clearPtpState(caller);
    const result = state.consumePtpInvite(target, 'A1', 'audio', 2000);

    assert.deepEqual(result, { ok: false, reason: 'invite_missing' });
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('a pending invitation cannot be overwritten by another caller', () => {
    const first = socket('A1', 'tenant-a');
    const second = socket('A2', 'tenant-a');
    const target = socket('A3', 'tenant-a');
    for (const ws of [first, second, target]) state.activeConnections.set(ws.sessionUser.id, ws);
    assert.deepEqual(state.createPtpInvite(first, target, 'audio', 1000), { ok: true });

    const result = state.createPtpInvite(second, target, 'audio', 1100);

    assert.deepEqual(result, { ok: false, reason: 'busy' });
    assert.equal(target.ptpInviteIncoming.fromId, 'A1');
    assert.equal(first.ptpInviteOutgoing.toId, 'A3');
    assert.equal(second.ptpInviteOutgoing, null);
});

test('an active caller cannot invite another peer', () => {
    const caller = socket('A1', 'tenant-a');
    const peer = socket('A2', 'tenant-a');
    const target = socket('A3', 'tenant-a');
    for (const ws of [caller, peer, target]) state.activeConnections.set(ws.sessionUser.id, ws);
    state.createPtpInvite(caller, peer, 'audio', 1000);
    assert.equal(state.consumePtpInvite(peer, 'A1', 'audio', 1100).ok, true);

    const result = state.createPtpInvite(caller, target, 'audio', 1200);

    assert.deepEqual(result, { ok: false, reason: 'busy' });
    assert.equal(caller.ptpTargetId, 'A2');
    assert.equal(target.ptpInviteIncoming, null);
});

test('clearing an established session removes both peers symmetrically', () => {
    const caller = socket('A1', 'tenant-a');
    const peer = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', peer);
    state.createPtpInvite(caller, peer, 'video', 1000);
    assert.equal(state.consumePtpInvite(peer, 'A1', 'video', 1100).ok, true);

    state.clearPtpState(caller);

    assert.equal(caller.ptpTargetId, null);
    assert.equal(peer.ptpTargetId, null);
    assert.equal(caller.ptpSessionKind, null);
    assert.equal(peer.ptpSessionKind, null);
    assert.equal(peer.sent.at(-1)?.type, 'ptp_cancelled');
});

test('an expired invitation is removed from both peers', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);
    state.createPtpInvite(caller, target, 'audio', 1000);

    const result = state.consumePtpInvite(target, 'A1', 'audio', 1000 + state.PTP_INVITE_TTL + 1);

    assert.deepEqual(result, { ok: false, reason: 'invite_missing' });
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('an invitation cannot be accepted after either side loses capability', () => {
    const caller = socket('A1', 'tenant-a');
    const target = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', target);
    state.createPtpInvite(caller, target, 'video', 1000);
    target.enable_ptt_video = false;

    const result = state.consumePtpInvite(target, 'A1', 'video', 2000);

    assert.deepEqual(result, { ok: false, reason: 'feature_disabled' });
    assert.equal(caller.ptpTargetId, null);
    assert.equal(target.ptpTargetId, null);
    assert.equal(caller.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming, null);
});

test('an expired pending invitation does not leave either peer busy', () => {
    const first = socket('A1', 'tenant-a');
    const second = socket('A2', 'tenant-a');
    const target = socket('A3', 'tenant-a');
    for (const ws of [first, second, target]) state.activeConnections.set(ws.sessionUser.id, ws);
    state.createPtpInvite(first, target, 'audio', 1000);

    const result = state.createPtpInvite(
        second, target, 'audio', 1000 + state.PTP_INVITE_TTL + 1,
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(first.ptpInviteOutgoing, null);
    assert.equal(target.ptpInviteIncoming.fromId, 'A2');
});

test('private routing requires reciprocal pairing and the same media kind', () => {
    const caller = socket('A1', 'tenant-a');
    const peer = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', peer);

    caller.ptpTargetId = 'A2';
    caller.ptpSessionKind = 'audio';
    assert.equal(state.ptpPeerFor(caller, 'audio'), null, 'one-sided pairing must fail closed');

    peer.ptpTargetId = 'A1';
    peer.ptpSessionKind = 'video';
    assert.equal(state.ptpPeerFor(caller, 'audio'), null, 'mixed media pairing must fail closed');

    peer.ptpSessionKind = 'audio';
    assert.equal(state.ptpPeerFor(caller, 'audio'), peer);
    assert.equal(state.ptpPeerFor(caller, 'video'), null);
});

test('private routing fails closed after either peer loses feature capability', () => {
    const caller = socket('A1', 'tenant-a');
    const peer = socket('A2', 'tenant-a');
    state.activeConnections.set('A1', caller);
    state.activeConnections.set('A2', peer);
    assert.equal(state.createPtpInvite(caller, peer, 'video').ok, true);
    assert.equal(state.consumePtpInvite(peer, 'A1', 'video').ok, true);

    peer.enable_ptt_video = false;
    assert.equal(state.ptpPeerFor(caller, 'video'), null);

    peer.enable_ptt_video = true;
    caller.enable_p2p = false;
    assert.equal(state.ptpPeerFor(caller, 'video'), null);
});
