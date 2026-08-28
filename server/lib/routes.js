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
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const { pool, createLog } = require('./db');
const { activeConnections } = require('./state');
const { resolveReleaseNotes } = require('./release-notes');
const {
    broadcastChannelUpdate,
    broadcastUsersInChannel,
    broadcastChannelNameChange,
    stopChannelVideo,
} = require('./broadcast');

/*
 * Where this environment serves its client APK from.
 *
 * The URL was assembled per request as `http://${req.headers.host}/...`. The
 * client accepts an update from exactly one URL and refuses everything else, so
 * that value could never match: the scheme was wrong before the host even
 * mattered, and the host was whatever the caller put in the header. Self-update
 * could not work in any environment, and from the device it looked like the app
 * rejecting its own server.
 *
 * Left unset, the endpoint still reports the version and simply offers no URL.
 * Advertising one the client is certain to refuse reads as a client bug; saying
 * nothing is honest and shows up in the log.
 */
const UPDATE_BASE = (() => {
    const configured = (process.env.AM2_UPDATE_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!configured) {
        console.warn('AM2_UPDATE_BASE_URL is not set; /api/check-update will not advertise a download URL');
        return '';
    }
    if (!configured.startsWith('https://')) {
        console.error('AM2_UPDATE_BASE_URL must be https; refusing to advertise a download URL');
        return '';
    }
    return configured;
})();

function registerRoutes(app) {
    app.get('/', (req, res) => {
        res.status(200).send('<h1>PTT Server</h1><p>Status: Active (WIB) - Multimedia Pass-Through Engine Ready (Redis Enabled)</p>');
    });

    // --- AUTO UPDATE ENDPOINTS ---

    /*
     * What a handset is offered, read from the file a handset actually fetches.
     *
     * This answered from public.app_versions, on the belief that the table was
     * the channel and the manifest beside the APK was a deployment note. It was
     * backwards. AboutActivity fetches UPDATE_MANIFEST_URL -- that manifest --
     * and nothing in the client calls this endpoint at all: across every
     * retained access log it has been asked for zero times, while the manifest
     * has been fetched by real handsets.
     *
     * So the table was a second, hand-written copy of the channel, and it drifted
     * exactly as a second copy does: it said build 3 while build 124 was
     * published and being downloaded. Reading what the handset reads is the only
     * arrangement in which this endpoint and the field cannot disagree.
     *
     * The shape of the reply is unchanged, because an older build somewhere may
     * still call it and would break on a new one. `force_update` lived only in
     * the table and has never had a caller, so it answers false rather than
     * inventing a source for it.
     */
    app.get('/api/check-update', (req, res) => {
        const manifestPath = path.join(__dirname, '..', 'update', 'version.json');
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (err) {
            return res.status(404).json({ success: false, message: 'No version info found' });
        }
        if (!manifest || typeof manifest !== 'object' || !manifest.version_code) {
            return res.status(404).json({ success: false, message: 'No version info found' });
        }

        res.json({
            success: true,
            server_version_code: manifest.version_code,
            server_version_name: manifest.version_name,
            force_update: false,
            // ?lang= if the caller states one; the field app does not, so it
            // gets the default and sees what it always saw.
            release_notes: resolveReleaseNotes(manifest.changelog, String(req.query.lang || '')),
            update_url: manifest.update_url
                || (UPDATE_BASE ? `${UPDATE_BASE}/update/update.apk` : null),
        });
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
                                data: { message: "The agency/admin account has expired or been deactivated." }
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

                /*
                 * Withdrawing video has to stop the stream that is running.
                 *
                 * The per-frame gate refuses new frames the moment this flag
                 * flips, so the picture stops -- but the unit stayed listed as
                 * streaming, and a list nobody corrects is a list every viewer
                 * still believes. They held an incoming-video view with nothing
                 * arriving behind it: revoking the permission produced the black
                 * screen rather than ending the stream.
                 */
                if (!targetWs.enable_ptt_video && targetWs.currentRoom) {
                    await stopChannelVideo(targetWs, targetWs.currentRoom);
                }

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
                    data: { message: "Your session was ended by an administrator." }
                }));
                setTimeout(() => {
                    targetWs.terminate();
                    activeConnections.delete(uid);
                }, 500);
                return res.json({ success: true, message: `User ${uid} was signed out.` });
            }
            res.json({ success: true, message: "User was already offline; database status was reset." });
        } catch (err) {
            console.error("❌ Force Logout API Error:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

module.exports = { registerRoutes };
