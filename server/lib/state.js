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
