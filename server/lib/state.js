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

/**
 * End a private call, and tell the other side.
 *
 * Called from both the hang-up message and the disconnect path, which is why
 * it tolerates a session that is already gone rather than checking first.
 */
const clearPtpSession = (ws) => {
    if (ws.ptpTargetId) {
        const targetWs = activeConnections.get(String(ws.ptpTargetId));
        if (targetWs) {
            targetWs.ptpTargetId = null;
            targetWs.send(JSON.stringify({ type: 'ptp_cancelled', data: { reason: 'session_ended' } }));
        }
        ws.ptpTargetId = null;
    }
};

module.exports = {
    activeConnections,
    peerFor,
    PTP_INVITE_TTL,
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
    clearPtpSession,
};
