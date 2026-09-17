
const activeConnections = new Map();

const channelRooms = new Map();

/** userId -> timeout handle, so a reconnect inside the grace period is not a leave */
const pendingDisconnects = new Map();

const DISCONNECT_GRACE_PERIOD = 10000; // 10 detik toleransi reconnect

const activeSpeakers = new Map();

const activeVideoRooms = new Map();

const channelStateQueues = new WeakMap();

const serializeChannelState = (ws, task) => {
    const previous = channelStateQueues.get(ws) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const settled = current.finally(() => {
        if (channelStateQueues.get(ws) === settled) channelStateQueues.delete(ws);
    });
    channelStateQueues.set(ws, settled);
    return settled;
};

const PTP_INVITE_TTL = 60000; // 60 detik

/*
 * WebSocket.OPEN, without requiring `ws` here.
 *
 * This module is deliberately dependency-free -- it is the shared state every
 * other module imports, and the unit suite loads it with nothing installed.
 * Writing `WebSocket.OPEN` passed locally on Node 22, which exposes a global
 * WebSocket, and threw on the Node 20 the CI runs. The constant is fixed by
 * the protocol, so name it rather than reach for a global that may not exist.
 */
const SOCKET_OPEN = 1;

const peerFor = (ws, targetId) => {
    const target = activeConnections.get(String(targetId));
    if (!target || !ws.sessionUser || !target.sessionUser) return null;

    const mine = ws.sessionUser.admin_id;
    const theirs = target.sessionUser.admin_id;
    if (mine === null || mine === undefined || theirs === null || theirs === undefined) return null;
    if (String(mine) !== String(theirs)) return null;

    return target;
};

const resolvePeer = (ws, targetId) => {
    const target = activeConnections.get(String(targetId));
    if (!target || target.readyState !== SOCKET_OPEN) {
        return { peer: null, reason: 'offline' };
    }
    const allowed = peerFor(ws, targetId);
    if (!allowed) return { peer: null, reason: 'unavailable' };
    return { peer: allowed, reason: 'ok' };
};


const rosterFor = (rows, recipient) => {
    const mine = recipient?.sessionUser?.admin_id;
    const myId = String(recipient?.sessionUser?.id ?? '');
    const callerEnabled = Boolean(recipient?.enable_p2p);

    return rows.map((row) => {
        const { admin_id: theirs, ...visible } = row;
        const sameTenant = mine !== null && mine !== undefined
            && theirs !== null && theirs !== undefined
            && String(mine) === String(theirs);

        return {
            ...visible,
            can_ptp: Boolean(
                sameTenant && callerEnabled && row.enable_p2p && String(row.id) !== myId,
            ),
        };
    });
};

/** Resolve only a reciprocal, same-kind private session. */
const ptpPeerFor = (ws, kind) => {
    const target = peerFor(ws, ws.ptpTargetId);
    if (!target || ws.ptpSessionKind !== kind || target.ptpSessionKind !== kind) return null;
    if (String(target.ptpTargetId ?? '') !== String(ws.sessionUser?.id ?? '')) return null;
    if (!ws.enable_p2p || !target.enable_p2p) return null;
    if (kind === 'video' && (!ws.enable_ptt_video || !target.enable_ptt_video)) return null;
    return target;
};

/** Record both halves of an invitation after resolving the target by tenant. */
const createPtpInvite = (caller, target, kind, now = Date.now()) => {
    if (!target?.sessionUser || peerFor(caller, target.sessionUser.id) !== target) {
        return { ok: false, reason: 'peer_unavailable' };
    }
    if (!caller.enable_p2p || !target.enable_p2p
        || (kind === 'video' && (!caller.enable_ptt_video || !target.enable_ptt_video))) {
        return { ok: false, reason: 'feature_disabled' };
    }
    for (const socket of [caller, target]) {
        const incomingExpired = socket.ptpInviteIncoming?.expiresAt < now;
        const outgoingExpired = socket.ptpInviteOutgoing?.expiresAt < now;
        if (incomingExpired || outgoingExpired) clearPtpState(socket, false);
    }
    if (caller.ptpTargetId || caller.ptpInviteIncoming || caller.ptpInviteOutgoing
        || target.ptpTargetId || target.ptpInviteIncoming || target.ptpInviteOutgoing) {
        return { ok: false, reason: 'busy' };
    }

    const expiresAt = now + PTP_INVITE_TTL;
    caller.ptpInviteOutgoing = { kind, toId: String(target.sessionUser.id), expiresAt };
    target.ptpInviteIncoming = { kind, fromId: String(caller.sessionUser.id), expiresAt };
    return { ok: true };
};

/** Remove matching pending invitations and any established private session. */
function clearPtpState(ws, notify = true) {
    const ownId = String(ws.sessionUser?.id ?? '');

    const incoming = ws.ptpInviteIncoming;
    if (incoming) {
        const caller = activeConnections.get(String(incoming.fromId));
        if (caller?.ptpInviteOutgoing?.toId === ownId) caller.ptpInviteOutgoing = null;
        ws.ptpInviteIncoming = null;
        if (notify && caller?.readyState === 1) {
            caller.send(JSON.stringify({ type: 'ptp_cancelled', data: { reason: 'invitation_cancelled' } }));
        }
    }

    const outgoing = ws.ptpInviteOutgoing;
    if (outgoing) {
        const target = activeConnections.get(String(outgoing.toId));
        if (target?.ptpInviteIncoming?.fromId === ownId) target.ptpInviteIncoming = null;
        ws.ptpInviteOutgoing = null;
        if (notify && target?.readyState === 1) {
            target.send(JSON.stringify({ type: 'ptp_cancelled', data: { reason: 'invitation_cancelled' } }));
        }
    }

    if (ws.ptpTargetId) {
        const peerId = String(ws.ptpTargetId);
        const peer = activeConnections.get(peerId);
        ws.ptpTargetId = null;
        ws.ptpSessionKind = null;
        if (peer?.ptpTargetId === ownId) {
            peer.ptpTargetId = null;
            peer.ptpSessionKind = null;
            if (notify && peer.readyState === 1) {
                peer.send(JSON.stringify({ type: 'ptp_cancelled', data: { reason: 'session_ended' } }));
            }
        }
    }
}

const consumePtpInvite = (target, callerId, kind, now = Date.now()) => {
    const caller = peerFor(target, callerId);
    const incoming = target.ptpInviteIncoming;
    const outgoing = caller?.ptpInviteOutgoing;
    const targetId = String(target.sessionUser?.id ?? '');
    const valid = caller
        && incoming?.kind === kind
        && incoming.fromId === String(callerId)
        && incoming.expiresAt >= now
        && outgoing?.kind === kind
        && outgoing.toId === targetId
        && outgoing.expiresAt >= now;

    if (!valid) {
        if ((incoming && incoming.expiresAt < now) || (outgoing && outgoing.expiresAt < now)) {
            clearPtpState(target, false);
        }
        return { ok: false, reason: 'invite_missing' };
    }
    if (!caller.enable_p2p || !target.enable_p2p
        || (kind === 'video' && (!caller.enable_ptt_video || !target.enable_ptt_video))) {
        clearPtpState(target, false);
        return { ok: false, reason: 'feature_disabled' };
    }

    target.ptpInviteIncoming = null;
    caller.ptpInviteOutgoing = null;
    target.ptpTargetId = String(caller.sessionUser.id);
    caller.ptpTargetId = targetId;
    target.ptpSessionKind = kind;
    caller.ptpSessionKind = kind;
    return { ok: true, peer: caller };
};

const clearPtpSession = clearPtpState;

module.exports = {
    activeConnections,
    peerFor,
    resolvePeer,
    rosterFor,
    ptpPeerFor,
    createPtpInvite,
    consumePtpInvite,
    PTP_INVITE_TTL,
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
    serializeChannelState,
    clearPtpState,
    clearPtpSession,
};
