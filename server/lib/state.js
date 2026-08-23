/**
 * Everything the relay knows only because it is this process.
 *
 * Five maps and one operation on them. They are the reason a second relay
 * process cannot simply be started beside this one: two processes would each
 * hold half the room and neither would know it. Moving them behind a module
 * does not fix that — it makes the boundary visible, so the day they move to
 * Redis there is one file to change rather than a grep.
 */

/** userId (string) -> ws */
const activeConnections = new Map();

/** channelSlug -> Set of ws */
const channelRooms = new Map();

/** userId -> timeout handle, so a reconnect inside the grace period is not a leave */
const pendingDisconnects = new Map();

const DISCONNECT_GRACE_PERIOD = 10000; // 10 detik toleransi reconnect

/** channelSlug -> Set of "userId:userName" */
const activeSpeakers = new Map();

/** channelSlug -> Set of "userId:userName" */
const activeVideoRooms = new Map();

/**
 * How long an unanswered private-call invitation stays acceptable.
 *
 * Long enough for a handset to be picked up, short enough that an invitation
 * cannot be banked and redeemed much later against a socket that has moved on.
 */
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

/**
 * The socket for `targetId`, but only if it belongs to the same tenant as `ws`.
 *
 * Every private-call handler used to reach straight into activeConnections,
 * which is a flat global uid -> ws map. Login enforces admin_id, and then the
 * whole P2P family threw that away: any authenticated unit could ring, answer,
 * or push audio at any other online unit in any branch.
 *
 * Returns null when either side is unauthenticated, when the target is absent,
 * or when the two belong to different admins. A missing admin_id on either side
 * is refused rather than treated as a match -- two NULLs are not the same
 * tenant, they are two unknowns.
 */
const peerFor = (ws, targetId) => {
    const target = activeConnections.get(String(targetId));
    if (!target || !ws.sessionUser || !target.sessionUser) return null;

    const mine = ws.sessionUser.admin_id;
    const theirs = target.sessionUser.admin_id;
    if (mine === null || mine === undefined || theirs === null || theirs === undefined) return null;
    if (String(mine) !== String(theirs)) return null;

    return target;
};

/**
 * Why a target cannot be called, separated from whether it can.
 *
 * peerFor answers null for two unrelated conditions -- no socket at all, and a
 * socket belonging to another tenant -- and both used to surface as "Personel
 * sedang offline". That sent operators after a network fault when the unit was
 * plainly connected: on production one unit sat under `superadmin` while the
 * three it shared a channel with sat under `ODIE COMM`, so every private call
 * between them was refused and blamed on the network.
 *
 * `offline` is a true statement about an absent or closed socket and is kept.
 * `unavailable` covers a peer that exists but is not callable, and says nothing
 * about why -- the caller has no business learning another tenant's shape.
 *
 * @returns {{peer: object|null, reason: 'ok'|'offline'|'unavailable'}}
 */
const resolvePeer = (ws, targetId) => {
    const target = activeConnections.get(String(targetId));
    if (!target || target.readyState !== SOCKET_OPEN) {
        return { peer: null, reason: 'offline' };
    }
    const allowed = peerFor(ws, targetId);
    if (!allowed) return { peer: null, reason: 'unavailable' };
    return { peer: allowed, reason: 'ok' };
};

/**
 * Whether `ws` could open a private call to `targetId` right now.
 *
 * Asked per roster entry so the handset can stop offering a call that the
 * relay will refuse. A button that always fails is worse than no button: the
 * operator reads the failure as a fault in the radio.
 *
 * Deliberately not a promise about the next moment -- the peer may be invited
 * by someone else before the tap lands, and request_ptp checks again.
 */
const canPrivateCall = (ws, targetId) => {
    if (String(targetId) === String(ws?.sessionUser?.id ?? '')) return false;
    const { peer, reason } = resolvePeer(ws, targetId);
    if (reason !== 'ok' || !peer) return false;
    return Boolean(ws.enable_p2p && peer.enable_p2p);
};

/**
 * One channel roster, as one recipient should see it.
 *
 * Channel access is granted per unit, so two tenants can legitimately share a
 * channel and hear each other. Private calling is scoped to a tenant. Both
 * rules are deliberate; the interface was the only place they disagreed, and it
 * disagreed silently -- the roster offered a call button for a peer the relay
 * would refuse, and the refusal claimed the peer was offline.
 *
 * Filtering the roster by tenant was the tempting repair and the wrong one.
 * Those units really are in the channel and really are audible; dropping them
 * would make the member list disagree with what the operator can hear, and
 * would take the name off inbound audio. So the list keeps everyone and marks
 * what is actually possible.
 *
 * `admin_id` is read here and never forwarded: which tenant a unit belongs to
 * is not something another unit needs to learn.
 *
 * Lives beside the other tenant rules rather than in broadcast.js, which pulls
 * in `ws` and the database pool -- neither of which the unit suite installs.
 */
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

/** Pair two sockets only when both halves of the same unexpired invite exist. */
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
    canPrivateCall,
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
    clearPtpState,
    clearPtpSession,
};
