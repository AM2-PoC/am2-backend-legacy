require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { createClient } = require('redis');

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

// --- REDIS CONFIGURATION ---
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error', err));

(async () => {
    try {
        await redisClient.connect();
        console.log('🚀 Redis Connected');
    } catch (err) {
        console.error('❌ Redis Connection Failed:', err.message);
    }
})();

// --- TRACKING STATE (Memory Storage) ---
const activeConnections = new Map(); // userId (string) -> ws instance
const channelRooms = new Map();      // channelSlug -> Set of ws instances
const pendingDisconnects = new Map(); // Untuk menyimpan timeout pembersihan (Debounce)
const DISCONNECT_GRACE_PERIOD = 10000; // 10 detik toleransi reconnect

// State berikut akan disinkronkan ke Redis agar persistensinya lebih baik
const activeSpeakers = new Map();    // channelSlug -> Set of "userId:userName"
const activeVideoRooms = new Map();  // channelSlug -> Set of "userId:userName"

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

// --- DATABASE CONNECTION ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    max: 50,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    options: "-c timezone=Asia/Jakarta"
});

pool.on('error', (err) => {
    console.error('❌ Database Pool Error:', err.message);
});

pool.on('connect', () => {
    console.log('🐘 New DB Client connected to pool');
});

// --- AUTO CLEANUP: LOGS OLDER THAN 30 DAYS ---
const runCleanup = async () => {
    console.log('🧹 Menjalankan pembersihan log otomatis (30 Hari)...');
    try {
        // Hapus log aktivitas PTT (Push/Release/Login)
        const pttRes = await pool.query("DELETE FROM public.ptt_logs WHERE event_time < NOW() - INTERVAL '30 days'");
        // Hapus log aktivitas Admin
        const adminRes = await pool.query("DELETE FROM public.admin_activity_logs WHERE waktu < NOW() - INTERVAL '30 days'");

        console.log(`✅ Cleanup Selesai: Terhapus ${pttRes.rowCount} PTT Logs & ${adminRes.rowCount} Admin Logs.`);
    } catch (err) {
        console.error('❌ Cleanup Error:', err.message);
    }
};

// Jalankan cleanup saat server start, lalu setiap 24 jam sekali
runCleanup();
setInterval(runCleanup, 86400000);

// --- HELPERS: LOGGING ---
const createLog = async (userId, channelId, eventType) => {
    try {
        if (!userId) return;

        const uid = String(userId).trim();
        const cid = parseInt(channelId);
        const validChannelId = isNaN(cid) ? null : cid;

        await pool.query(`
            INSERT INTO public.ptt_logs (user_id, channel_id, event_type, event_time)
            VALUES ($1::text, $2::integer, $3::text, CURRENT_TIMESTAMP)
        `, [uid, validChannelId, String(eventType)]);
    } catch (err) {
        console.error(`❌ LOG ERROR [${eventType}]:`, err.message);
    }
};

// --- HELPERS: BROADCASTING ---

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

// --- HELPERS: PTP CLEANUP ---
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

// --- ROUTING ---
app.get('/', (req, res) => {
    res.status(200).send('<h1>PTT Server</h1><p>Status: Active (WIB) - Multimedia Pass-Through Engine Ready (Redis Enabled)</p>');
});

// --- AUTO UPDATE ENDPOINTS ---

app.get('/api/check-update', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT version_code, version_name, force_update, release_notes
            FROM public.app_versions
            ORDER BY version_code DESC LIMIT 1
        `);

        if (result.rows.length > 0) {
            res.json({
                success: true,
                server_version_code: result.rows[0].version_code,
                server_version_name: result.rows[0].version_name,
                force_update: result.rows[0].force_update,
                release_notes: result.rows[0].release_notes,
                update_url: `http://${req.headers.host}/update/update.apk`
            });
        } else {
            res.status(404).json({ success: false, message: "No version info found" });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/set-app-version', async (req, res) => {
    const { version_code, version_name, force_update, release_notes } = req.body;
    try {
        await pool.query(`
            INSERT INTO public.app_versions (version_code, version_name, force_update, release_notes)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (version_code) DO UPDATE SET
                version_name = EXCLUDED.version_name,
                force_update = EXCLUDED.force_update,
                release_notes = EXCLUDED.release_notes
        `, [version_code, version_name, force_update || false, release_notes || '']);

        res.json({ success: true, message: `Versi ${version_name} berhasil didaftarkan.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- ADMIN ENDPOINTS ---

app.get('/api/admin/sync-channels', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    try {
        await broadcastChannelUpdate(userId);
        res.json({ success: true, message: "Sync command sent to user." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/refresh-branch-permissions', async (req, res) => {
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: "adminId is required" });

    try {
        let updateCount = 0;
        const now = new Date();
        for (let [userId, ws] of activeConnections) {
            const uid = String(userId);
            if (ws.sessionUser && ws.sessionUser.admin_id == adminId) {
                const permRes = await pool.query(`
                    SELECT u.id, p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode,
                           a.status as admin_status, a.expired_at as admin_expired_at,
                           a.can_manage_maps, a.can_manage_p2p, a.can_manage_video,
                           uc.permission as channel_perm
                    FROM public.users u
                    LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
                    LEFT JOIN public.admin a ON u.admin_id = a.id
                    LEFT JOIN public.user_channels uc ON u.id = uc.user_id AND u.last_channel_id = uc.channel_id
                    WHERE u.id = $1 LIMIT 1
                `, [uid]);

                if (permRes.rows.length > 0) {
                    const row = permRes.rows[0];
                    const isExpired = row.admin_expired_at && new Date(row.admin_expired_at) < now;
                    const isInactive = row.admin_status !== 'active';

                    if (isExpired || isInactive) {
                        ws.send(JSON.stringify({
                            type: 'force_logout',
                            data: { message: "Masa aktif instansi/admin telah berakhir atau dinonaktifkan." }
                        }));
                        await pool.query("UPDATE public.users SET status = 'offline', current_device_id = NULL WHERE id = $1", [uid]);
                        setTimeout(() => ws.terminate(), 500);
                        continue;
                    }

                    ws.enable_maps = (row.enable_maps !== false) && (row.can_manage_maps !== false);
                    ws.enable_p2p = (row.enable_p2p !== false) && (row.can_manage_p2p !== false);
                    ws.enable_ptt_video = (row.enable_ptt_video === true) && (row.can_manage_video === true);
                    ws.duplex_mode = row.duplex_mode || 'HALF DUPLEX';
                    ws.is_rx_only = (row.channel_perm === 'RX');

                    ws.send(JSON.stringify({
                        type: 'permission_update',
                        data: {
                            enable_maps: ws.enable_maps,
                            enable_p2p: ws.enable_p2p,
                            enable_ptt_video: ws.enable_ptt_video,
                            duplex_mode: ws.duplex_mode,
                            is_rx_only: ws.is_rx_only
                        }
                    }));
                    updateCount++;
                }
            }
        }
        res.json({ success: true, message: `Updated ${updateCount} users in branch.` });
    } catch (err) {
        console.error("❌ Refresh Branch Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/update-user-profile', async (req, res) => {
    const { userId, name } = req.body;
    if (!userId || !name) return res.status(400).json({ error: "userId and name are required" });

    const uid = String(userId);
    try {
        await pool.query("UPDATE public.users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [name, uid]);

        const ws = activeConnections.get(uid);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.sessionUser.name = name;
            ws.send(JSON.stringify({
                type: 'user_profile_update',
                data: { name: name }
            }));

            if (ws.currentRoom) broadcastUsersInChannel(ws.currentRoom);
        }

        res.json({ success: true, message: "User profile updated and synced." });
    } catch (err) {
        console.error("❌ Update User Profile Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/update-channel', async (req, res) => {
    const { channelId, display_name } = req.body;
    try {
        await pool.query("UPDATE public.channels SET display_name = $1 WHERE id = $2", [display_name, channelId]);
        await broadcastChannelNameChange(channelId);
        res.json({ success: true, message: "Nama channel diperbarui dan disinkronkan." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/assign-channel', async (req, res) => {
    const { userId, channelId, permission } = req.body;
    const uid = String(userId);
    try {
        await pool.query(`
            INSERT INTO public.user_channels (user_id, channel_id, permission)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = EXCLUDED.permission
        `, [uid, channelId, permission || 'TX']);

        await broadcastChannelUpdate(uid);
        res.json({ success: true, message: "Channel assigned & synced." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/remove-channel', async (req, res) => {
    const { userId, channelId } = req.body;
    const uid = String(userId);
    try {
        await pool.query(`
            DELETE FROM public.user_channels
            WHERE user_id = $1 AND channel_id = $2
        `, [uid, channelId]);

        await broadcastChannelUpdate(uid);
        res.json({ success: true, message: "Channel access removed & synced realtime." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/update-permissions', async (req, res) => {
    const { userId, enable_maps, enable_p2p, enable_ptt_video, duplex_mode } = req.body;
    const uid = String(userId);
    try {
        await pool.query(`
            INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode, updated_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET
                enable_maps = EXCLUDED.enable_maps,
                enable_p2p = EXCLUDED.enable_p2p,
                enable_ptt_video = EXCLUDED.enable_ptt_video,
                duplex_mode = EXCLUDED.duplex_mode,
                updated_at = CURRENT_TIMESTAMP
        `, [uid, enable_maps, enable_p2p, enable_ptt_video, duplex_mode]);

        const targetWs = activeConnections.get(uid);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            const adminAuth = await pool.query("SELECT can_manage_maps, can_manage_p2p, can_manage_video FROM public.admin WHERE id = $1", [targetWs.sessionUser.admin_id]);
            const auth = adminAuth.rows[0] || { can_manage_maps:true, can_manage_p2p:true, can_manage_video:false };

            targetWs.enable_maps = (enable_maps !== false) && (auth.can_manage_maps !== false);
            targetWs.enable_p2p = (enable_p2p !== false) && (auth.can_manage_p2p !== false);
            targetWs.enable_ptt_video = (enable_ptt_video === true) && (auth.can_manage_video === true);
            targetWs.duplex_mode = duplex_mode || 'HALF DUPLEX';

            targetWs.send(JSON.stringify({
                type: 'permission_update',
                data: {
                    enable_maps: targetWs.enable_maps,
                    enable_p2p: targetWs.enable_p2p,
                    enable_ptt_video: targetWs.enable_ptt_video,
                    duplex_mode: targetWs.duplex_mode,
                    is_rx_only: targetWs.is_rx_only
                }
            }));

            if (targetWs.currentRoom) broadcastUsersInChannel(targetWs.currentRoom);
        }
        res.json({ success: true, message: "Permissions updated successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/set-permission', async (req, res) => {
    const { userId, channelId, permission } = req.body;
    const uid = String(userId);
    try {
        await pool.query(`
            UPDATE public.user_channels SET permission = $1
            WHERE user_id = $2 AND channel_id = $3
        `, [permission, uid, channelId]);

        await broadcastChannelUpdate(uid);

        res.json({ success: true, message: "Izin berhasil diperbarui." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/admin/force-logout', async (req, res) => {
    const { userId } = req.body;
    const uid = String(userId);
    try {
        await pool.query("UPDATE public.users SET status = 'offline', current_device_id = NULL WHERE id = $1", [uid]);
        await createLog(uid, null, 'FORCE_LOGOUT');
        const targetWs = activeConnections.get(uid);
        if (targetWs) {
            targetWs.send(JSON.stringify({
                type: 'force_logout',
                data: { message: "Sesi Anda telah diakhiri oleh administrator." }
            }));
            setTimeout(() => {
                targetWs.terminate();
                activeConnections.delete(uid);
            }, 500);
            return res.json({ success: true, message: `User ${uid} berhasil dikeluarkan.` });
        }
        res.json({ success: true, message: "User sudah offline, status database telah direset." });
    } catch (err) {
        console.error("❌ Force Logout API Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
