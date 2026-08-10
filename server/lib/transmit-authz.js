/**
 * Re-read channel membership at key-down. This is intentionally once per
 * transmission rather than once per frame, so revocation is fresh without
 * putting a database query on the binary media hot path.
 */
async function authorizeChannelTransmit(ws, lookup) {
    if (typeof lookup !== 'function') {
        throw new TypeError('authorizeChannelTransmit requires a permission lookup');
    }
    try {
        const row = await lookup(ws.sessionUser.id, ws.currentRoom);
        if (!row) {
            ws.is_rx_only = true;
            return { ok: false, reason: 'not_member' };
        }

        ws.is_rx_only = row.permission === 'RX';
        if (ws.is_rx_only) return { ok: false, reason: 'receive_only' };

        return { ok: true, permission: row };
    } catch (error) {
        // Do not leave a stale FULL DUPLEX cache usable by binary frames after
        // the fresh authorization lookup itself failed.
        ws.is_rx_only = true;
        return { ok: false, reason: 'authorization_unavailable', error };
    }
}

function transmitErrorMessage(reason) {
    switch (reason) {
        case 'not_member':
            return 'Cannot transmit: no longer a member of this channel.';
        case 'receive_only':
            return 'Cannot transmit: receive-only on this channel.';
        default:
            return 'Cannot transmit: authorization is temporarily unavailable.';
    }
}

module.exports = { authorizeChannelTransmit, transmitErrorMessage };
