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

const { pool } = require('./db');
const { activeConnections, channelRooms } = require('./state');

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
                                message: "Izin bicara diperbarui secara realtime."
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

const broadcastUsersInChannel = async (channelSlug) => {
    if (!channelSlug) return;
    try {
        const result = await pool.query(`
            SELECT u.id, u.name, u.status, u.latitude, u.longitude, u.accuracy, u.updated_at,
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
            const msg = JSON.stringify({ type: 'users_online', data: result.rows });
            clients.forEach(c => {
                if(c.readyState === WebSocket.OPEN) c.send(msg);
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
            SET latitude = $1, longitude = $2, accuracy = $3, address = $4, updated_at = CURRENT_TIMESTAMP, status = 'online'
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
    broadcastChannelUpdate,
    broadcastToChannel,
    broadcastUsersInChannel,
    updateUserLocation,
    broadcastChannelNameChange,
};
