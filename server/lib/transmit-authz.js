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
 *
 * The two media also need separate generations. One press in the video screen
 * emits ptt_video_start and ptt_audio_start milliseconds apart, so both run
 * through here at once; a single shared counter meant the second to arrive
 * invalidated the first, which returned 'stale' and never reached the line that
 * grants its flag. Whichever medium the client happened to send first was
 * silently unauthorized for the whole transmission -- the listener heard the
 * sender and saw nothing, with no video_stream_status broadcast either, so no
 * incoming view appeared at all.
 *
 * A newer authorization of the *same* medium still supersedes an older one, and
 * a channel change still invalidates everything in flight, which is what
 * `transmitAuthGeneration` now means on its own: the epoch of the room.
 */
async function authorizeChannelTransmit(ws, lookup, kind = 'audio') {
    if (typeof lookup !== 'function') {
        throw new TypeError('authorizeChannelTransmit requires a permission lookup');
    }
    if (ws.channelTransitioning) {
        ws.is_rx_only = true;
        ws.channelVideoAuthorized = false;
        return { ok: false, reason: 'stale' };
    }
    const room = ws.currentRoom;
    const field = kind === 'video' ? 'videoAuthGeneration' : 'audioAuthGeneration';
    const generation = (ws[field] ?? 0) + 1;
    ws[field] = generation;
    const epoch = ws.transmitAuthGeneration ?? 0;
    ws.is_rx_only = true;

    try {
        const row = await lookup(ws.sessionUser.id, room);
        if (ws[field] !== generation
            || (ws.transmitAuthGeneration ?? 0) !== epoch
            || ws.currentRoom !== room) {
            // A newer authorization of this medium owns the socket, or the room
            // changed underneath it; do not revoke on their behalf.
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
        if (ws[field] !== generation
            || (ws.transmitAuthGeneration ?? 0) !== epoch
            || ws.currentRoom !== room) {
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
