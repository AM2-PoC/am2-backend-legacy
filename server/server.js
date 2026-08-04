require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// --- APACHE2 PROXY CONFIGURATION ---
app.set('trust proxy', true);

// --- CONFIGURATION ---
const PORT = process.env.PORT || 5000;
const UPDATE_DIR = path.join(__dirname, 'update');

if (!fs.existsSync(UPDATE_DIR)) {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
}

// --- STATE AND PERSISTENCE ---
// The in-process maps live in lib/state.js; the pool, Redis and the two
// background writers live in lib/db.js. Both are inert on import.
const {
    activeConnections,
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
    clearPtpSession,
} = require('./lib/state');

const { pool, redisClient, connectRedis, startCleanup, createLog } = require('./lib/db');
const { registerRoutes } = require('./lib/routes');

connectRedis();
startCleanup();

// --- MIDDLEWARE ---
// Was wildcard. The relay is called by the panel over localhost and by the
// Admin Native app; neither is a browser making cross-origin requests.
const CORS_ALLOWED = (process.env.AM2_CORS_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: CORS_ALLOWED.length ? CORS_ALLOWED : false,
    credentials: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Credential for the admin surface.
//
// Ten /api/admin/* routes had no authentication at all, and nginx forwards
// every path, so they were reachable from the internet. Four are now denied at
// the edge; the rest are used by the Admin Native app, which cannot present a
// key until it is updated. So this records rather than rejects until
// AM2_API_AUTH_MODE is set to "enforce".
const API_KEY = process.env.AM2_API_KEY || '';
const API_AUTH_MODE = (process.env.AM2_API_AUTH_MODE || 'log').toLowerCase();

app.use('/api/admin', (req, res, next) => {
    const sent = req.get('X-AM2-Api-Key') || req.query.api_key || '';
    if (API_KEY && sent && sent === API_KEY) return next();

    console.warn('[api-auth] REJECT-CANDIDATE %s %s from %s ua=%s key=%s',
        req.method, req.originalUrl,
        req.get('X-Real-IP') || req.socket.remoteAddress,
        (req.get('User-Agent') || '-').slice(0, 120),
        sent ? 'wrong' : 'absent');

    if (API_AUTH_MODE === 'enforce') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return next();
});


// --- AUTO UPDATE ROUTE ---
app.use('/update', express.static(UPDATE_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
            res.set('Content-Type', 'application/vnd.android.package-archive');
            res.set('Content-Disposition', 'attachment; filename="update.apk"');
        }
    }
}));


// --- BROADCASTING ---
// Who gets told about a change lives in lib/broadcast.js. What happened is
// decided here.
const {
    broadcastChannelUpdate,
    broadcastToChannel,
    broadcastUsersInChannel,
    updateUserLocation,
    broadcastChannelNameChange,
} = require('./lib/broadcast');


// --- ROUTING ---
// The endpoints live in lib/routes.js. Each one arrives, does a thing and
// answers; the engine below is one connection that stays open instead.
registerRoutes(app);

// --- WEBSOCKET ENGINE ---
const wss = new WebSocket.Server({ server });

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.sessionUser = null;
    ws.currentRoom = null;
    ws.currentChannelId = null;
    ws.is_rx_only = false;
    ws.ptpTargetId = null;
    ws.enable_maps = true;
    ws.enable_p2p = true;
    ws.enable_ptt_video = false;
    ws.duplex_mode = 'HALF DUPLEX';

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message, isBinary) => {
        if (isBinary) {
            if (!ws.sessionUser) return;
            const binaryType = message[0];

            if (ws.ptpTargetId) {
                const targetWs = activeConnections.get(String(ws.ptpTargetId));
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(message, { binary: true });
                }
            } else if (ws.currentRoom) {
                if (binaryType === 1 && ws.is_rx_only) return;

                // --- DOUBLE VALIDASI AUDIO (BINARY LEVEL) ---
                if (binaryType === 1) {
                    const speakerEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                    const currentSpeakers = activeSpeakers.get(ws.currentRoom);

                    // Jika user tidak ada di daftar speaker aktif, abaikan data audionya
                    if (!currentSpeakers || !currentSpeakers.has(speakerEntry)) {
                        return;
                    }
                }

                if (binaryType === 2 && !ws.enable_ptt_video) return;

                const clients = channelRooms.get(ws.currentRoom);
                if (clients) {
                    clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN && !client.ptpTargetId) {
                            client.send(message, { binary: true });
                        }
                    });
                }
            }
            return;
        }

        let payload;
        try { payload = JSON.parse(message); } catch (e) { return; }
        const { type, data } = payload;

        switch (type) {
            case 'app_login':
                const cleanIdentity = data.username ? data.username.trim() : "";
                const providedDeviceId = data.current_device_id ? data.current_device_id.trim() : null;
                try {
                    const res = await pool.query(`
                        SELECT u.*, a.status as admin_status, a.expired_at as admin_expired_at,
                               a.can_manage_maps, a.can_manage_p2p, a.can_manage_video,
                               p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode,
                               c.display_name as last_channel_name, c.name as last_channel_slug
                        FROM public.users u
                        LEFT JOIN public.admin a ON u.admin_id = a.id
                        LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
                        LEFT JOIN public.channels c ON u.last_channel_id = c.id
                        WHERE u.id = $1 OR UPPER(u.name) = UPPER($1)
                        LIMIT 1
                    `, [cleanIdentity]);

                    if (res.rows.length > 0) {
                        const user = res.rows[0];
                        const uid = String(user.id);

                        if (!(await bcrypt.compare(data.password?.trim() || "", user.password))) {
                            return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Password Salah" } }));
                        }

                        const now = new Date();
                        if (user.admin_status && user.admin_status !== 'active') {
                            return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Akun Instansi Nonaktif" } }));
                        }
                        if (user.admin_expired_at && new Date(user.admin_expired_at) < now) {
                            return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Masa Aktif Instansi Habis" } }));
                        }

                        if (!user.last_channel_id || !user.last_channel_slug) {
                            return ws.send(JSON.stringify({
                                type: 'login_error',
                                data: { message: "Login Gagal: Admin belum menentukan Channel Default untuk Anda." }
                            }));
                        }

                        const channelCheck = await pool.query(
                            "SELECT 1 FROM public.user_channels WHERE user_id = $1 AND channel_id = $2",
                            [uid, user.last_channel_id]
                        );

                        if (channelCheck.rows.length === 0) {
                            return ws.send(JSON.stringify({
                                type: 'login_error',
                                data: { message: "Login Gagal: Anda tidak memiliki akses ke Channel Default tersebut." }
                            }));
                        }

                        // --- DOUBLE LOGIN PREVENTION ---
                        if (activeConnections.has(uid)) {
                            // Cek jika sedang dalam Grace Period (reconnect)
                            const isGracePeriod = pendingDisconnects.has(uid);

                            // Jika TIDAK dalam grace period (berarti benar-benar sedang online)
                            // DAN device ID berbeda, maka TOLAK login baru.
                            if (!isGracePeriod && user.current_device_id && user.current_device_id !== providedDeviceId) {
                                return ws.send(JSON.stringify({
                                    type: 'login_error',
                                    data: { message: "Akun sedang digunakan di perangkat lain. Harap logout terlebih dahulu." }
                                }));
                            }

                            // Jika dalam grace period atau device ID sama (reconnect), matikan koneksi lama yang menggantung
                            const existingWs = activeConnections.get(uid);
                            if (existingWs !== ws) {
                                // Mencegah cleanup event 'close' menghapus session baru
                                existingWs.sessionUser = null;
                                existingWs.terminate();
                            }
                        }

                        // BATALKAN PEMBERSIHAN (RECONNECT HANDLER)
                        if (pendingDisconnects.has(uid)) {
                            clearTimeout(pendingDisconnects.get(uid));
                            pendingDisconnects.delete(uid);
                            console.log(`[Re-entry] User ${uid} kembali sebelum timeout.`);
                        }

                        ws.sessionUser = user;
                        ws.currentChannelId = user.last_channel_id;
                        ws.enable_maps = (user.enable_maps !== false) && (user.can_manage_maps !== false);
                        ws.enable_p2p = (user.enable_p2p !== false) && (user.can_manage_p2p !== false);
                        ws.enable_ptt_video = (user.enable_ptt_video === true) && (user.can_manage_video === true);
                        ws.duplex_mode = user.duplex_mode || 'HALF DUPLEX';

                        activeConnections.set(uid, ws);

                        await pool.query("UPDATE public.users SET status = 'online', updated_at = CURRENT_TIMESTAMP, current_device_id = $1, is_speaking = false WHERE id = $2", [providedDeviceId, uid]);
                        await createLog(uid, user.last_channel_id, 'LOGIN');

                        if (data.latitude && data.longitude) await updateUserLocation(uid, data.latitude, data.longitude, data.accuracy, data.address);

                        const channels = await pool.query(`
                            SELECT c.name as slug, c.display_name, uc.permission
                            FROM public.channels c
                            JOIN public.user_channels uc ON c.id = uc.channel_id
                            WHERE uc.user_id = $1`, [uid]);

                        ws.send(JSON.stringify({
                            type: 'login_success',
                            data: {
                                id: uid, username: user.name,
                                enable_maps: ws.enable_maps, enable_p2p: ws.enable_p2p, enable_ptt_video: ws.enable_ptt_video,
                                duplex_mode: ws.duplex_mode,
                                last_channel_id: user.last_channel_id,
                                default_channel_name: user.last_channel_name,
                                default_channel_slug: user.last_channel_slug,
                                channels: channels.rows
                            }
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'login_error', data: { message: "User Tidak Terdaftar" } }));
                    }
                } catch (err) {
                    console.error("❌ Login Error:", err.message);
                    ws.send(JSON.stringify({ type: 'login_error', data: { message: "Database Timeout / Connection Error" } }));
                }
                break;

            case 'update_location':
                if (ws.sessionUser) {
                    await updateUserLocation(ws.sessionUser.id, data.latitude, data.longitude, data.accuracy, data.address);
                    if (ws.currentRoom) broadcastUsersInChannel(ws.currentRoom);
                }
                break;

            case 'join_channel':
                if (!ws.sessionUser) return;
                clearPtpSession(ws);
                const oldRoom = ws.currentRoom;
                if (oldRoom && channelRooms.has(oldRoom)) {
                    channelRooms.get(oldRoom).delete(ws);

                    // --- SYNC REDIS ---
                    const speakerKey = `speakers:${oldRoom}`;
                    const speakerVal = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                    await redisClient.sRem(speakerKey, speakerVal);

                    const videoKey = `video:${oldRoom}`;
                    await redisClient.sRem(videoKey, speakerVal);

                    if (activeSpeakers.has(oldRoom)) activeSpeakers.get(oldRoom).delete(speakerVal);
                    if (activeVideoRooms.has(oldRoom)) activeVideoRooms.get(oldRoom).delete(speakerVal);

                    broadcastToChannel(oldRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(oldRoom) || []).map(s => s.split(':')[1]), channel: oldRoom } });
                }

                try {
                    const check = await pool.query(`
                        SELECT uc.permission, c.id, c.display_name
                        FROM public.user_channels uc
                        JOIN public.channels c ON uc.channel_id = c.id
                        WHERE uc.user_id = $1 AND c.name = $2
                    `, [String(ws.sessionUser.id), data.new_channel_slug]);

                    if (check.rows.length > 0) {
                        const channelData = check.rows[0];
                        if (!channelRooms.has(data.new_channel_slug)) channelRooms.set(data.new_channel_slug, new Set());
                        if (!activeSpeakers.has(data.new_channel_slug)) {
                            activeSpeakers.set(data.new_channel_slug, new Set());
                            // Ambil dari Redis jika ada (mencegah data hilang saat restart)
                            const savedSpeakers = await redisClient.sMembers(`speakers:${data.new_channel_slug}`);
                            savedSpeakers.forEach(s => activeSpeakers.get(data.new_channel_slug).add(s));
                        }
                        if (!activeVideoRooms.has(data.new_channel_slug)) {
                            activeVideoRooms.set(data.new_channel_slug, new Set());
                            const savedVideos = await redisClient.sMembers(`video:${data.new_channel_slug}`);
                            savedVideos.forEach(v => activeVideoRooms.get(data.new_channel_slug).add(v));
                        }

                        channelRooms.get(data.new_channel_slug).add(ws);
                        ws.currentRoom = data.new_channel_slug;
                        ws.currentChannelId = channelData.id;
                        ws.is_rx_only = (channelData.permission === 'RX');

                        // Memulai transaksi DB untuk sinkronisasi is_default dan last_channel_id
                        const client = await pool.connect();
                        try {
                            await client.query('BEGIN');
                            await client.query("UPDATE public.users SET current_channel = $1, last_channel_id = $2, is_speaking = false WHERE id = $3",
                                [data.new_channel_slug, channelData.id, String(ws.sessionUser.id)]);
                            await client.query("UPDATE public.user_channels SET is_default = false WHERE user_id = $1", [String(ws.sessionUser.id)]);
                            await client.query("UPDATE public.user_channels SET is_default = true WHERE user_id = $1 AND channel_id = $2",
                                [String(ws.sessionUser.id), channelData.id]);
                            await client.query('COMMIT');
                        } catch (e) {
                            await client.query('ROLLBACK');
                            throw e;
                        } finally {
                            client.release();
                        }

                        ws.send(JSON.stringify({
                            type: 'join_channel_success',
                            data: { channel_name: channelData.display_name, channel_slug: data.new_channel_slug, is_rx_only: ws.is_rx_only, speakers: Array.from(activeSpeakers.get(data.new_channel_slug)).map(s => s.split(':')[1]) }
                        }));
                        broadcastUsersInChannel(data.new_channel_slug);
                        if (oldRoom) broadcastUsersInChannel(oldRoom);
                    }
                } catch (err) { console.error("❌ Join Error:", err.message); }
                break;

            case 'ptt_audio_start':
                if (!ws.sessionUser || ws.is_rx_only || !ws.currentRoom) return;

                // --- PENANGANAN HALF DUPLEX (SERVER VALIDATION) ---
                const speakers = activeSpeakers.get(ws.currentRoom);
                if (ws.duplex_mode === 'HALF DUPLEX' && speakers && speakers.size > 0) {
                    return ws.send(JSON.stringify({
                        type: 'ptt_error',
                        data: { message: "Gagal Bicara: Jalur sedang digunakan (Half Duplex)." }
                    }));
                }

                clearPtpSession(ws);

                if (!activeSpeakers.has(ws.currentRoom)) activeSpeakers.set(ws.currentRoom, new Set());
                const speakerEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                activeSpeakers.get(ws.currentRoom).add(speakerEntry);
                await redisClient.sAdd(`speakers:${ws.currentRoom}`, speakerEntry);

                try {
                    await pool.query("UPDATE public.users SET is_speaking = true WHERE id = $1", [String(ws.sessionUser.id)]);
                    await createLog(ws.sessionUser.id, ws.currentChannelId, 'PUSH');
                } catch (err) {
                    console.error("❌ PTT Start DB Error:", err.message);
                }

                broadcastToChannel(ws.currentRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(ws.currentRoom)).map(s => s.split(':')[1]), channel: ws.currentRoom } });
                break;

            case 'ptt_audio_end':
                if (ws.sessionUser && ws.currentRoom) {
                    const endEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                    if (activeSpeakers.has(ws.currentRoom)) {
                        activeSpeakers.get(ws.currentRoom).delete(endEntry);
                    }
                    await redisClient.sRem(`speakers:${ws.currentRoom}`, endEntry);

                    try {
                        await pool.query("UPDATE public.users SET is_speaking = false WHERE id = $1", [String(ws.sessionUser.id)]);
                        await createLog(ws.sessionUser.id, ws.currentChannelId, 'RELEASE');
                    } catch (err) {
                        console.error("❌ PTT End DB Error:", err.message);
                    }

                    broadcastToChannel(ws.currentRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(ws.currentRoom) || []).map(s => s.split(':')[1]) , channel: ws.currentRoom } });
                }
                break;

            case 'ptt_video_start':
                if (!ws.sessionUser || !ws.enable_ptt_video || !ws.currentRoom) return;
                if (!activeVideoRooms.has(ws.currentRoom)) activeVideoRooms.set(ws.currentRoom, new Set());
                const videoEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                activeVideoRooms.get(ws.currentRoom).add(videoEntry);
                await redisClient.sAdd(`video:${ws.currentRoom}`, videoEntry);
                broadcastToChannel(ws.currentRoom, { type: 'video_stream_status', data: { streamers: Array.from(activeVideoRooms.get(ws.currentRoom)).map(s => s.split(':')[1]), channel: ws.currentRoom, is_private: false } });
                break;

            case 'ptt_video_end':
                if (ws.sessionUser && ws.currentRoom) {
                    const vEndEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                    if (activeVideoRooms.has(ws.currentRoom)) {
                        activeVideoRooms.get(ws.currentRoom).delete(vEndEntry);
                    }
                    await redisClient.sRem(`video:${ws.currentRoom}`, vEndEntry);
                    broadcastToChannel(ws.currentRoom, { type: 'video_stream_status', data: { streamers: Array.from(activeVideoRooms.get(ws.currentRoom) || []).map(s => s.split(':')[1]), channel: ws.currentRoom, is_private: false } });
                }
                break;

            case 'ptt_audio_start_private':
                if (!ws.sessionUser || !ws.enable_p2p) return;
                ws.ptpTargetId = String(data.target_id);

                try {
                    await pool.query("UPDATE public.users SET is_speaking = true WHERE id = $1", [String(ws.sessionUser.id)]);
                    await createLog(ws.sessionUser.id, ws.currentChannelId, 'PUSH_PRIVATE');
                } catch (err) {
                    console.error("❌ Private PTT Start DB Error:", err.message);
                }

                activeConnections.get(ws.ptpTargetId)?.send(JSON.stringify({ type: 'ptt_active_status', data: { speakers: [ws.sessionUser.name], channel: 'private', is_private: true } }));
                break;

            case 'ptt_audio_end_private':
                if (ws.sessionUser) {
                    try {
                        await pool.query("UPDATE public.users SET is_speaking = false WHERE id = $1", [String(ws.sessionUser.id)]);
                        await createLog(ws.sessionUser.id, ws.currentChannelId, 'RELEASE_PRIVATE');
                    } catch (err) {
                        console.error("❌ Private PTT End DB Error:", err.message);
                    }
                }
                const targetId = String(data.target_id || ws.ptpTargetId);
                activeConnections.get(targetId)?.send(JSON.stringify({ type: 'ptt_active_status', data: { speakers: [], channel: 'private', is_private: true } }));
                break;

            case 'request_ptp':
                if (!ws.sessionUser || !ws.enable_p2p) return;
                const targetPtpWs = activeConnections.get(String(data.target_id));
                if (targetPtpWs && targetPtpWs.readyState === WebSocket.OPEN) {
                    if (targetPtpWs.ptpTargetId) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: data.target_id, message: 'Personel sedang dalam panggilan lain' } }));
                        return;
                    }
                    targetPtpWs.send(JSON.stringify({ type: 'ptp_invitation', data: { sender_id: ws.sessionUser.id, sender_name: ws.sessionUser.name } }));
                } else {
                    ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: data.target_id, message: 'Personel sedang offline' } }));
                }
                break;

            case 'accept_ptp':
                if (!ws.sessionUser) return;
                ws.ptpTargetId = String(data.target_id);
                const initiatorWs = activeConnections.get(ws.ptpTargetId);
                if (initiatorWs) {
                    initiatorWs.ptpTargetId = String(ws.sessionUser.id);
                    initiatorWs.send(JSON.stringify({ type: 'ptp_confirmed', data: { target_id: ws.sessionUser.id, target_name: ws.sessionUser.name } }));
                }
                break;

            case 'request_ptp_video':
                if (!ws.sessionUser || !ws.enable_p2p || !ws.enable_ptt_video) return;
                const targetVidWs = activeConnections.get(String(data.target_id));
                if (targetVidWs && targetVidWs.readyState === WebSocket.OPEN) {
                    if (targetVidWs.ptpTargetId) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: data.target_id, message: 'Personel sedang dalam panggilan lain' } }));
                        return;
                    }
                    targetVidWs.send(JSON.stringify({ type: 'ptp_video_invitation', data: { sender_id: ws.sessionUser.id, sender_name: ws.sessionUser.name } }));
                } else {
                    ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: data.target_id, message: 'Personel sedang offline' } }));
                }
                break;

            case 'accept_ptp_video':
                if (!ws.sessionUser) return;
                ws.ptpTargetId = String(data.target_id);
                const initVidWs = activeConnections.get(ws.ptpTargetId);
                if (initVidWs) {
                    initVidWs.ptpTargetId = String(ws.sessionUser.id);
                    initVidWs.send(JSON.stringify({ type: 'ptp_video_confirmed', data: { target_id: ws.sessionUser.id, target_name: ws.sessionUser.name } }));
                }
                break;

            case 'ptt_video_start_private':
                if (!ws.sessionUser || !ws.enable_ptt_video) return;
                activeConnections.get(String(data.target_id))?.send(JSON.stringify({
                    type: 'video_stream_status',
                    data: { streamers: [ws.sessionUser.name], channel: 'private', is_private: true }
                }));
                break;

            case 'ptt_video_end_private':
                activeConnections.get(String(data.target_id || ws.ptpTargetId))?.send(JSON.stringify({
                    type: 'video_stream_status',
                    data: { streamers: [], channel: 'private', is_private: true }
                }));
                break;

            case 'cancel_ptp':
                clearPtpSession(ws);
                break;
        }
    });

    ws.on('close', async () => {
        const user = ws.sessionUser;
        const room = ws.currentRoom;
        if (user) {
            const uid = String(user.id);

            // 1. Hentikan status bicara seketika (mencegah audio nyangkut)
            if (room && activeSpeakers.has(room)) {
                const exitEntry = `${user.id}:${user.name}`;
                activeSpeakers.get(room).delete(exitEntry);
                await redisClient.sRem(`speakers:${room}`, exitEntry);
                broadcastToChannel(room, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(room) || []).map(s => s.split(':')[1]), channel: room } });
            }

            // 2. Tunda pembersihan koneksi & status online (Debounce)
            const timeoutIdx = setTimeout(async () => {
                if (activeConnections.get(uid) === ws) {
                    activeConnections.delete(uid);
                    pendingDisconnects.delete(uid);
                    clearPtpSession(ws);
                    try {
                        await pool.query("UPDATE public.users SET status = 'offline', current_channel = NULL, current_device_id = NULL, is_speaking = false WHERE id = $1", [uid]);
                        await createLog(uid, ws.currentChannelId, 'LOGOUT');
                        if (room) {
                            channelRooms.get(room)?.delete(ws);
                            broadcastUsersInChannel(room);
                        }
                    } catch (err) { console.error("❌ Cleanup Error:", err.message); }
                }
            }, DISCONNECT_GRACE_PERIOD);

            pendingDisconnects.set(uid, timeoutIdx);
        }
    });

    ws.on('error', (err) => {
        console.error(`🔴 WebSocket Error:`, err.message);
    });
});

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
    console.log(`\n--------------------------------------------`);
    console.log(`🚀 PTT SERVER VERSI: 1.1 (RESILIENT CONNECT)`);
    console.log(`🕒 Timezone  : Asia/Jakarta`);
    console.log(`🔄 Reconnect : Enabled (${DISCONNECT_GRACE_PERIOD/1000}s Grace Period)`);
    console.log(`--------------------------------------------\n`);
});
