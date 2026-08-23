/**
 * Sending things to clients that did not ask for them.
 *
 * Five functions, and the difference between them is who is on the other end:
 * one unit whose channel list changed, everyone in a room, everyone whose
 * membership includes a channel that was renamed. They are grouped because
 * they are the only code that decides who hears about a change — the protocol
 * handler decides what happened, this decides who is told.
 *
 * updateUserLocation is here because it is the write behind a broadcast rather
 * than a broadcast itself: the map reads what it stores.
 */
const WebSocket = require('ws');

const { pool, redisClient } = require('./db');
const { activeConnections, channelRooms, activeVideoRooms } = require('./state');

const broadcastChannelUpdate = async (userId) => {
    const uid = String(userId);
    const ws = activeConnections.get(uid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            const channels = await pool.query(`
                SELECT c.name as slug, c.display_name, uc.permission
                FROM public.channels c
                JOIN public.user_channels uc ON c.id = uc.channel_id
                WHERE uc.user_id = $1`, [uid]);

            ws.send(JSON.stringify({
                type: 'channels_updated',
                data: { channels: channels.rows }
            }));

            if (ws.currentRoom) {
                const currentChannel = channels.rows.find(c => c.slug === ws.currentRoom);
                if (currentChannel) {
                    const newRxOnly = (currentChannel.permission === 'RX');
                    if (ws.is_rx_only !== newRxOnly) {
                        ws.is_rx_only = newRxOnly;
                        ws.send(JSON.stringify({
                            type: 'permission_update',
                            data: {
                                enable_maps: ws.enable_maps,
                                enable_p2p: ws.enable_p2p,
                                enable_ptt_video: ws.enable_ptt_video,
                                duplex_mode: ws.duplex_mode,
                                is_rx_only: ws.is_rx_only,
                                message: "Your permissions were updated in realtime."
                            }
                        }));
                    }
                }
            }
        } catch (err) {
            console.error("❌ Broadcast Channel Update Error:", err.message);
        }
    }
};

const broadcastToChannel = (channelSlug, payload, excludeWs = null) => {
    const clients = channelRooms.get(channelSlug);
    if (clients) {
        const message = JSON.stringify(payload);
        clients.forEach(client => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN && !client.ptpTargetId) {
                client.send(message);
            }
        });
    }
};

/**
 * This socket is no longer streaming video here; tell the room.
 *
 * It exists because the operation did not. Ending a stream is four steps --
 * drop the in-memory entry, drop the mirrored Redis entry, withdraw the
 * per-transmission grant, announce the new list -- and every caller open-coded
 * whichever subset it happened to think of. The announcement was the step that
 * kept getting missed, and missing it is invisible on this end and fatal on the
 * other: viewers keep the incoming-video view up with nothing arriving behind
 * it, which is a black screen no client-side change can clear.
 *
 * It was missed on disconnect, on rejoin, and on an administrator withdrawing
 * video permission mid-stream. Each was found separately, as its own bug, when
 * all three were one absent function.
 *
 * Returns whether the socket was in fact streaming, so a caller can stay quiet
 * about a unit that was not.
 */
const stopChannelVideo = async (ws, channelSlug) => {
    if (!ws?.sessionUser || !channelSlug) return false;

    const entry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
    const streamers = activeVideoRooms.get(channelSlug);
    const wasStreaming = streamers ? streamers.delete(entry) : false;

    // Unconditionally, because the mirror can outlive the memory: a relay
    // restart repopulates activeVideoRooms from Redis, so a stale key there
    // resurrects a streamer that no longer exists.
    await redisClient.sRem(`video:${channelSlug}`, entry);
    ws.channelVideoAuthorized = false;

    if (!wasStreaming) return false;
    broadcastToChannel(channelSlug, {
        type: 'video_stream_status',
        data: {
            streamers: Array.from(streamers).map(s => s.split(':')[1]),
            channel: channelSlug,
            is_private: false,
        },
    });
    return true;
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

const broadcastUsersInChannel = async (channelSlug) => {
    if (!channelSlug) return;
    try {
        const result = await pool.query(`
            SELECT u.id, u.name, u.status, u.latitude, u.longitude, u.accuracy, u.updated_at,
                   u.admin_id,
                   COALESCE(p.enable_p2p, true) as enable_p2p,
                   COALESCE(p.enable_ptt_video, false) as enable_ptt_video,
                   COALESCE(p.duplex_mode, 'HALF DUPLEX') as duplex_mode
            FROM public.users u
            LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
            WHERE u.current_channel = $1 AND u.status = 'online'
            ORDER BY u.name ASC
        `, [channelSlug]);

        const clients = channelRooms.get(channelSlug);
        if (clients) {
            /*
             * One payload per distinct viewpoint rather than per socket: what
             * a recipient sees depends only on its tenant and whether it has
             * private calling at all, and a channel has a handful of those and
             * potentially hundreds of sockets.
             */
            const byViewpoint = new Map();
            clients.forEach((c) => {
                if (c.readyState !== WebSocket.OPEN) return;
                const key = `${c.sessionUser?.admin_id ?? ''}|${c.enable_p2p ? 1 : 0}`;
                let msg = byViewpoint.get(key);
                if (msg === undefined) {
                    msg = JSON.stringify({ type: 'users_online', data: rosterFor(result.rows, c) });
                    byViewpoint.set(key, msg);
                }
                c.send(msg);
            });
        }
    } catch (err) {
        console.error("❌ Broadcast User Error:", err.message);
    }
};

const updateUserLocation = async (userId, lat, lng, acc, address = "") => {
    if (!lat || !lng) return;
    const uid = String(userId);
    try {
        await pool.query(`
            UPDATE public.users
            SET latitude = $1, longitude = $2, accuracy = $3, address = $4,
                location_updated_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP, status = 'online'
            WHERE id = $5
        `, [lat, lng, acc || 0, address, uid]);
    } catch (err) {
        console.error("❌ Update Location Error:", err.message);
    }
};

const broadcastChannelNameChange = async (channelId) => {
    try {
        const members = await pool.query("SELECT user_id FROM public.user_channels WHERE channel_id = $1", [channelId]);
        for (const row of members.rows) {
            broadcastChannelUpdate(row.user_id);
        }
    } catch (err) {
        console.error("❌ Global Channel Sync Error:", err.message);
    }
};

module.exports = {
    rosterFor,
    broadcastChannelUpdate,
    broadcastToChannel,
    stopChannelVideo,
    broadcastUsersInChannel,
    updateUserLocation,
    broadcastChannelNameChange,
};
