/**
 * Re-read channel membership at key-down. This is intentionally once per
 * transmission rather than once per frame, so revocation is fresh without
 * putting a database query on the binary media hot path.
 *
 * Audio and video key-down share this helper, but only video grants
 * `channelVideoAuthorized` -- so this function may withdraw that grant when the
 * channel says the user may no longer transmit, and must otherwise leave it
 * alone. Clearing it on every call meant an audio press revoked a video stream
 * that no later code path could restore.
 */
async function authorizeChannelTransmit(ws, lookup) {
    if (typeof lookup !== 'function') {
        throw new TypeError('authorizeChannelTransmit requires a permission lookup');
    }
    if (ws.channelTransitioning) {
        ws.is_rx_only = true;
        ws.channelVideoAuthorized = false;
        return { ok: false, reason: 'stale' };
    }
    const room = ws.currentRoom;
    const generation = (ws.transmitAuthGeneration ?? 0) + 1;
    ws.transmitAuthGeneration = generation;
    ws.is_rx_only = true;

    try {
        const row = await lookup(ws.sessionUser.id, room);
        if (ws.transmitAuthGeneration !== generation || ws.currentRoom !== room) {
            // A newer authorization owns the socket now; do not revoke on its behalf.
            return { ok: false, reason: 'stale' };
        }
        if (!row) {
            ws.channelVideoAuthorized = false;
            return { ok: false, reason: 'not_member' };
        }

        ws.is_rx_only = row.permission === 'RX';
        if (ws.is_rx_only) {
            ws.channelVideoAuthorized = false;
            return { ok: false, reason: 'receive_only' };
        }

        return { ok: true, permission: row };
    } catch (error) {
        if (ws.transmitAuthGeneration !== generation || ws.currentRoom !== room) {
            return { ok: false, reason: 'stale' };
        }
        // Do not leave a stale FULL DUPLEX cache usable by binary frames after
        // the fresh authorization lookup itself failed.
        ws.is_rx_only = true;
        ws.channelVideoAuthorized = false;
        return { ok: false, reason: 'authorization_unavailable', error };
    }
}

function transmitErrorMessage(reason) {
    switch (reason) {
        case 'not_member':
            return 'Cannot transmit: no longer a member of this channel.';
        case 'receive_only':
            return 'Cannot transmit: receive-only on this channel.';
        case 'stale':
            return 'Cannot transmit: request was superseded; please try again.';
        default:
            return 'Cannot transmit: authorization is temporarily unavailable.';
    }
}

module.exports = { authorizeChannelTransmit, transmitErrorMessage };
