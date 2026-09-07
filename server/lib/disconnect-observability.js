'use strict';

const CLOSE_CAUSES = new Set([
    'admin_force_logout',
    'ping_timeout',
    'server_shutdown',
    'session_replaced',
]);

function markCloseCause(ws, cause) {
    if (!CLOSE_CAUSES.has(cause)) {
        throw new TypeError(`unsupported WebSocket close cause: ${cause}`);
    }
    ws.closeCause = cause;
}

function safeLogToken(value) {
    const text = String(value);
    const safe = text.replace(/[^A-Za-z0-9._:+-]/g, '_').slice(0, 128);
    return safe || 'unknown';
}

function disconnectRecord(ws, code, nowNs = process.hrtime.bigint()) {
    if (ws.disconnectUserId === null || ws.disconnectUserId === undefined) return null;
    const heldSeconds = typeof ws.connectedAtNs === 'bigint' && nowNs >= ws.connectedAtNs
        ? Number((nowNs - ws.connectedAtNs) / 1_000_000_000n)
        : 'na';
    const cause = ws.closeCause
        || (code === 1006 ? 'abnormal_close' : 'peer_close');
    return `event=client_disconnect user=${safeLogToken(ws.disconnectUserId)}`
        + ` cause=${cause}`
        + ` code=${typeof code === 'number' ? code : 'na'}`
        + ` held_seconds=${heldSeconds}`;
}

module.exports = { disconnectRecord, markCloseCause };
