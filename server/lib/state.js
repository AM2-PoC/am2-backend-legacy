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
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
    clearPtpSession,
};
