/**
 * The HTTP surface: what the panel and the admin app call over plain requests.
 *
 * Everything here is a request that arrives, does one thing and answers. The
 * WebSocket engine is the opposite shape — one connection that stays open and
 * carries many messages — which is the whole reason these two are no longer
 * in the same file.
 *
 * Every path is part of a contract: the field app polls /api/check-update, and
 * tests/contract pins each /api/admin/* route by name. Renaming one of them is
 * a release, not a refactor.
 *
 * Takes `app` because the express instance is wiring and belongs to server.js;
 * everything else it needs it requires for itself.
 */
const WebSocket = require('ws');

const { pool, createLog } = require('./db');
const { activeConnections } = require('./state');
const {
    broadcastChannelUpdate,
    broadcastUsersInChannel,
    broadcastChannelNameChange,
} = require('./broadcast');

function registerRoutes(app) {
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
}

module.exports = { registerRoutes };
