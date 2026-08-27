/**
 * The protocol the field app speaks.
 *
 * One connection that stays open and carries many messages, which is the
 * opposite shape from the HTTP endpoints in routes.js — a request there
 * arrives, does one thing and answers. That difference is why they are no
 * longer the same file.
 *
 * Every message type in the switch below is a contract with a handset that
 * cannot be updated on the same day the server is. tests/contract pins the
 * names in both directions and tests/protocol drives a real two-client
 * exchange through them; neither is optional before touching this.
 *
 * Takes the http server because the WebSocket server upgrades from it, and
 * that is wiring. Everything else it requires for itself.
 */
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');

const { pool, redisClient, createLog, channelPermission } = require('./db');
const MSG = require('./messages');
const { authorizeChannelTransmit, transmitErrorMessage } = require('./transmit-authz');
const {
    activeConnections,
    peerFor,
    resolvePeer,
    ptpPeerFor,
    createPtpInvite,
    consumePtpInvite,
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
    clearPtpSession,
} = require('./state');
const {
    broadcastToChannel,
    broadcastUsersInChannel,
    stopChannelVideo,
    updateUserLocation,
} = require('./broadcast');

const pttTraceEnabled = process.env.AM2_PTT_TRACE === '1';
const PTT_TRACE_SAMPLE_EVERY_FRAMES = 25;

function shouldSamplePttFrame(frameSequence) {
    return frameSequence <= 3 || frameSequence % PTT_TRACE_SAMPLE_EVERY_FRAMES === 0;
}

/*
 * How much may already be waiting for one client before video is withheld.
 *
 * ws.send() is asynchronous and buffers whatever the socket cannot yet write,
 * so a listener on a weak downlink accumulates frames inside this process with
 * no limit. Audio and video reach that listener through the same socket in
 * arrival order, so a ~20 KB video frame buffered ahead of a ~45-byte Opus
 * frame delays the speech by however long the video takes to push.
 *
 * About one frame, so at most one video frame is ever ahead of audio for a
 * given client. Anything larger is a queue by another name.
 */
const DOWNLINK_VIDEO_BUDGET_BYTES = 24_000;

/*
 * Link measurement, from the relay's own vantage point.
 *
 * Two numbers were already there to be had and were being thrown away. The
 * keepalive pings every client and gets a pong back, but the send time was
 * discarded, so a round trip the relay observes on every interval never became
 * a number. And audio arrives at a known rate — one frame per 20 ms — so the
 * spread of arrival spacing at this end IS the jitter the uplink added.
 *
 * Neither needs anything from the device. Until now every claim about the
 * network came from a handset that had to be held, instrumented and read back;
 * these come from a server that is already running.
 *
 * Off by default because this sits on a 50 Hz path.
 */
const linkStatsEnabled = process.env.AM2_LINK_STATS === '1';
const FRAME_INTERVAL_MS = 20;
const LINK_REPORT_INTERVAL_MS = 15000;
/*
 * A gap wide enough to be a stall rather than scheduling noise.
 *
 * This transport is TCP, which never delivers a hole: it delays, then delivers
 * a burst. So loss is the wrong question to ask of it and would always answer
 * zero. What is worth counting is how often arrivals bunch -- and, beside it,
 * whether video was sharing the socket in the same window, because a JPEG
 * queued ahead of speech and a descheduled encoder thread look identical from
 * one gap alone.
 */
const UPLINK_STALL_MS = 60;

/**
 * Forget the arrival clock at a transmission boundary.
 *
 * Audio arrives every 20 ms *while a key is held*. Between one press and the
 * next there is silence, and measuring that silence against a 20 ms expectation
 * turned ordinary radio use into enormous fabricated jitter -- a reported
 * `uplink_worst_ms` of 174 seconds inside a 15 second window, which was read as
 * a network problem and was nothing of the kind.
 */
function resetAudioArrival(ws) {
    ws.lastAudioArrivalNs = null;
}

/**
 * Smoothed inter-arrival jitter, the RFC 3550 estimator.
 *
 * A single late frame is not jitter, so the deviation is smoothed by a
 * sixteenth. That makes the value readable at any moment rather than only
 * meaningful in aggregate.
 */
function observeAudioArrival(ws) {
    if (!linkStatsEnabled) return;
    const nowNs = process.hrtime.bigint();
    const previous = ws.lastAudioArrivalNs;
    ws.lastAudioArrivalNs = nowNs;
    if (!previous) return;

    const spacingMs = Number(nowNs - previous) / 1e6;
    const deviation = Math.abs(spacingMs - FRAME_INTERVAL_MS);
    ws.uplinkJitterMs = (ws.uplinkJitterMs || 0) + (deviation - (ws.uplinkJitterMs || 0)) / 16;
    ws.uplinkWorstMs = Math.max(ws.uplinkWorstMs || 0, deviation);
    ws.uplinkFrames = (ws.uplinkFrames || 0) + 1;
    if (spacingMs >= UPLINK_STALL_MS) ws.uplinkStalls = (ws.uplinkStalls || 0) + 1;
}

/** One line per client that has been heard from, on an interval. */
function reportLinkQuality(clients) {
    if (!linkStatsEnabled) return;
    clients.forEach((ws) => {
        if (!ws.sessionUser) return;
        // The window is cleared for every client, including one that sent
        // nothing. Clearing it only for clients that reported meant an idle
        // handset carried its worst sample forward indefinitely, and the next
        // line it appeared on described a moment minutes in the past.
        const frames = ws.uplinkFrames || 0;
        const worstMs = ws.uplinkWorstMs || 0;
        const stalls = ws.uplinkStalls || 0;
        const videoFrames = ws.uplinkVideoFrames || 0;
        ws.uplinkWorstMs = 0;
        ws.uplinkFrames = 0;
        ws.uplinkStalls = 0;
        ws.uplinkVideoFrames = 0;
        if (!frames) return;

        console.log(
            `event=link_quality user=${ws.sessionUser.id}`
            + ` client_version=${ws.clientVersionName || 'unknown'}`
            + ` client_version_code=${ws.clientVersionCode === null ? 'na' : ws.clientVersionCode}`
            + ` rtt_ms=${ws.rttMs === undefined ? 'na' : ws.rttMs.toFixed(1)}`
            + ` uplink_jitter_ms=${ws.uplinkJitterMs.toFixed(2)}`
            + ` uplink_worst_ms=${worstMs.toFixed(1)}`
            + ` frames=${frames}`
            + ` stalls=${stalls}`
            + ` video_frames=${videoFrames}`
            + ` buffered_bytes=${ws.bufferedAmount || 0}`,
        );
    });
}

let videoDropped = 0;

/**
 * Whether this client should be given this frame right now.
 *
 * Audio is always forwarded: it is the product, it is small, and it is what the
 * delay is measured against. Video yields as soon as the client is behind,
 * because a late frame carries a picture that is already history.
 */
function shouldForwardBinary(client, binaryType) {
    if (binaryType === 1) return true;
    if ((client.bufferedAmount || 0) < DOWNLINK_VIDEO_BUDGET_BYTES) return true;
    videoDropped += 1;
    return false;
}

function tracePtt(event, { traceId, frameSequence, frameBytes } = {}) {
    if (!pttTraceEnabled) return;
    const fields = [`event=${event}`, `mono_ns=${process.hrtime.bigint()}`];
    if (traceId) fields.push(`trace_id=${traceId}`);
    if (frameSequence) fields.push(`frame_seq=${frameSequence}`);
    if (frameBytes) fields.push(`frame_bytes=${frameBytes}`);
    console.info(`[PttTrace] ${fields.join(' ')}`);
}

function attachProtocol(server) {
    const wss = new WebSocket.Server({ server });

    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.pingSentAt = process.hrtime.bigint();
            ws.ping();
        });
    }, 30000);

    const linkReportInterval = setInterval(() => reportLinkQuality(wss.clients), LINK_REPORT_INTERVAL_MS);
    if (linkReportInterval.unref) linkReportInterval.unref();

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.sessionUser = null;
        ws.currentRoom = null;
        ws.currentChannelId = null;
        ws.is_rx_only = false;
        ws.ptpTargetId = null;
        ws.ptpSessionKind = null;
        ws.ptpInviteIncoming = null;
        ws.ptpInviteOutgoing = null;
        ws.enable_maps = true;
        ws.enable_p2p = true;
        ws.enable_ptt_video = false;
        ws.duplex_mode = 'HALF DUPLEX';
        // The room's epoch: bumped on every channel change so any authorization
        // still waiting on the database is discarded. Each medium keeps its own
        // sequence beside it, so audio and video no longer invalidate each other.
        ws.transmitAuthGeneration = 0;
        ws.audioAuthGeneration = 0;
        ws.videoAuthGeneration = 0;
        ws.channelVideoAuthorized = false;
        ws.channelTransitioning = false;
        ws.channelJoinGeneration = 0;
        ws.pttTraceId = 0;
        ws.pttFrameSequence = 0;
        ws.clientVersionCode = null;
        ws.clientVersionName = null;

        ws.on('pong', () => {
            ws.isAlive = true;
            // The round trip the keepalive was already paying for.
            if (ws.pingSentAt) {
                ws.rttMs = Number(process.hrtime.bigint() - ws.pingSentAt) / 1e6;
                ws.pingSentAt = null;
            }
        });

        ws.on('message', async (message, isBinary) => {
            if (isBinary) {
                if (!ws.sessionUser) return;
                const binaryType = message[0];
                if (binaryType === 2 && linkStatsEnabled) {
                    ws.uplinkVideoFrames = (ws.uplinkVideoFrames || 0) + 1;
                }
                if (binaryType === 1) {
                    observeAudioArrival(ws);
                    ws.pttFrameSequence += 1;
                    if (shouldSamplePttFrame(ws.pttFrameSequence)) {
                        tracePtt('frame_received', {
                            traceId: ws.pttTraceId,
                            frameSequence: ws.pttFrameSequence,
                            frameBytes: message.length,
                        });
                    }
                }

                if (ws.ptpTargetId) {
                    /*
                     * A private session carries the medium it was accepted for.
                     *
                     * The control plane already insists on this --
                     * `ptt_video_start_private` demands `enable_ptt_video` on
                     * both ends and a video session, `ptt_audio_start_private`
                     * demands an audio one -- but this path forwarded whatever
                     * arrived without reading the frame's type at all, so the
                     * hardening stopped at the messages and never reached the
                     * media.
                     *
                     * Opening an audio call needs only `enable_p2p`; video
                     * permission is checked solely by `request_ptp_video`. So a
                     * unit denied video could open an audio call and push video
                     * through it, with the per-frame `enable_ptt_video` gate
                     * that guards the channel path having no counterpart here.
                     * And the callee answered a voice call: video arriving in it
                     * is a consent problem whatever the permissions say.
                     *
                     * Unknown types are dropped rather than relayed verbatim.
                     */
                    if (binaryType === 1) {
                        if (ws.ptpSessionKind !== 'audio') return;
                    } else if (binaryType === 2) {
                        if (ws.ptpSessionKind !== 'video' || !ws.enable_ptt_video) return;
                    } else {
                        return;
                    }

                    const targetWs = ptpPeerFor(ws, ws.ptpSessionKind);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN
                        && shouldForwardBinary(targetWs, binaryType)) {
                        targetWs.send(message, { binary: true });
                        if (binaryType === 1 && shouldSamplePttFrame(ws.pttFrameSequence)) tracePtt('frame_forwarded', {
                            traceId: ws.pttTraceId,
                            frameSequence: ws.pttFrameSequence,
                            frameBytes: message.length,
                        });
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

                    if (binaryType === 2 && (!ws.enable_ptt_video || !ws.channelVideoAuthorized)) return;

                    const clients = channelRooms.get(ws.currentRoom);
                    if (clients) {
                        let forwarded = false;
                        clients.forEach(client => {
                            if (client !== ws && client.readyState === WebSocket.OPEN && !client.ptpTargetId) {
                                if (!shouldForwardBinary(client, binaryType)) return;
                                client.send(message, { binary: true });
                                forwarded = true;
                            }
                        });
                        if (binaryType === 1 && forwarded && shouldSamplePttFrame(ws.pttFrameSequence)) tracePtt('frame_forwarded', {
                            traceId: ws.pttTraceId,
                            frameSequence: ws.pttFrameSequence,
                            frameBytes: message.length,
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
                    /*
                     * Which build is on the other end.
                     *
                     * The relay recorded a username and nothing about the
                     * software, so "is that unit running the fix" had no answer
                     * here -- and was answered instead from an APK signer
                     * digest, which names a keystore rather than a commit, and
                     * gave the wrong answer for an entire round of work.
                     *
                     * Every handset already in the field predates this field, so
                     * absence is normal and is recorded as unknown.
                     */
                    ws.clientVersionCode = Number.isSafeInteger(data.client_version_code)
                        && data.client_version_code > 0
                        ? data.client_version_code
                        : null;
                    ws.clientVersionName = typeof data.client_version_name === 'string'
                        && data.client_version_name.trim().length > 0
                        && data.client_version_name.length <= 64
                        ? data.client_version_name.trim()
                        : null;
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
                            WHERE LOWER(u.id) = LOWER($1) OR UPPER(u.name) = UPPER($1)
                            LIMIT 1
                        `, [cleanIdentity]);

                        if (res.rows.length > 0) {
                            const user = res.rows[0];
                            const uid = String(user.id);

                            if (!(await bcrypt.compare(data.password?.trim() || "", user.password))) {
                                return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Incorrect password" } }));
                            }

                            const now = new Date();
                            if (user.admin_status && user.admin_status !== 'active') {
                                return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Agency account is inactive" } }));
                            }
                            if (user.admin_expired_at && new Date(user.admin_expired_at) < now) {
                                return ws.send(JSON.stringify({ type: 'login_error', data: { message: "Agency subscription has expired" } }));
                            }

                            if (!user.last_channel_id || !user.last_channel_slug) {
                                return ws.send(JSON.stringify({
                                    type: 'login_error',
                                    data: { message: "Login failed: the admin has not set a default channel for you." }
                                }));
                            }

                            const channelCheck = await pool.query(
                                "SELECT 1 FROM public.user_channels WHERE user_id = $1 AND channel_id = $2",
                                [uid, user.last_channel_id]
                            );

                            if (channelCheck.rows.length === 0) {
                                return ws.send(JSON.stringify({
                                    type: 'login_error',
                                    data: { message: "Login failed: you do not have access to that default channel." }
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
                                        data: { message: "This account is signed in on another device. Please sign out there first." }
                                    }));
                                }

                                // Jika dalam grace period atau device ID sama (reconnect), matikan koneksi lama yang menggantung
                                const existingWs = activeConnections.get(uid);
                                if (existingWs !== ws) {
                                    // Tear down private state while the old socket still has
                                    // its identity, otherwise its peer remains paired forever.
                                    clearPtpSession(existingWs);
                                    // Mencegah cleanup event 'close' menghapus session baru
                                    existingWs.sessionUser = null;
                                    existingWs.terminate();
                                }
                            }

                            // BATALKAN PEMBERSIHAN (RECONNECT HANDLER)
                            if (pendingDisconnects.has(uid)) {
                                clearTimeout(pendingDisconnects.get(uid));
                                pendingDisconnects.delete(uid);
                                console.log(`[Re-entry] User ${uid} reconnected before the grace period ended.`);
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
                            console.log(
                                `event=client_login user=${uid}`
                                + ` client_version=${ws.clientVersionName || 'unknown'}`
                                + ` client_version_code=${ws.clientVersionCode === null ? 'na' : ws.clientVersionCode}`,
                            );

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
                            ws.send(JSON.stringify({ type: 'login_error', data: { message: "Unit not registered" } }));
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
                    const joinGeneration = ws.channelJoinGeneration + 1;
                    ws.channelJoinGeneration = joinGeneration;
                    ws.channelTransitioning = true;
                    ws.transmitAuthGeneration += 1;
                    ws.is_rx_only = true;
                    ws.channelVideoAuthorized = false;
                    clearPtpSession(ws);
                    const oldRoom = ws.currentRoom;
                    ws.currentRoom = null;
                    ws.currentChannelId = null;
                    if (oldRoom && channelRooms.has(oldRoom)) {
                        channelRooms.get(oldRoom).delete(ws);

                        // --- SYNC REDIS ---
                        const speakerKey = `speakers:${oldRoom}`;
                        const speakerVal = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                        await redisClient.sRem(speakerKey, speakerVal);

                        if (activeSpeakers.has(oldRoom)) activeSpeakers.get(oldRoom).delete(speakerVal);
                        broadcastToChannel(oldRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(oldRoom) || []).map(s => s.split(':')[1]), channel: oldRoom } });

                        // The room being left has to be told about the camera as
                        // well as the microphone. A rejoin is how every reconnect
                        // arrives, so a stream interrupted by a network flap used
                        // to end with the room still watching a dead one.
                        await stopChannelVideo(ws, oldRoom);
                    }

                    try {
                        const channelData = await channelPermission(ws.sessionUser.id, data.new_channel_slug);
                        if (ws.channelJoinGeneration !== joinGeneration) break;

                        if (channelData) {
                            if (!channelRooms.has(data.new_channel_slug)) channelRooms.set(data.new_channel_slug, new Set());
                            if (!activeSpeakers.has(data.new_channel_slug)) {
                                activeSpeakers.set(data.new_channel_slug, new Set());
                                // Ambil dari Redis jika ada (mencegah data hilang saat restart)
                                const savedSpeakers = await redisClient.sMembers(`speakers:${data.new_channel_slug}`);
                                if (ws.channelJoinGeneration !== joinGeneration) break;
                                savedSpeakers.forEach(s => activeSpeakers.get(data.new_channel_slug).add(s));
                            }
                            if (!activeVideoRooms.has(data.new_channel_slug)) {
                                activeVideoRooms.set(data.new_channel_slug, new Set());
                                const savedVideos = await redisClient.sMembers(`video:${data.new_channel_slug}`);
                                if (ws.channelJoinGeneration !== joinGeneration) break;
                                savedVideos.forEach(v => activeVideoRooms.get(data.new_channel_slug).add(v));
                            }

                            if (ws.channelJoinGeneration !== joinGeneration) break;

                            channelRooms.get(data.new_channel_slug).add(ws);
                            ws.currentRoom = data.new_channel_slug;
                            ws.currentChannelId = channelData.id;
                            ws.is_rx_only = (channelData.permission === 'RX');
                            // Invalidate any start authorized while this join was
                            // waiting on I/O; its decision belongs to oldRoom.
                            ws.transmitAuthGeneration += 1;
                            ws.channelVideoAuthorized = false;

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

                            // A later join can supersede this one while the DB
                            // transaction is in flight. Roll the stale in-memory
                            // membership back instead of announcing the wrong room.
                            if (ws.channelJoinGeneration !== joinGeneration) {
                                channelRooms.get(data.new_channel_slug)?.delete(ws);
                                break;
                            }

                            // The socket is now authoritative for the new room.
                            ws.channelTransitioning = false;

                            ws.send(JSON.stringify({
                                type: 'join_channel_success',
                                data: { channel_name: channelData.display_name, channel_slug: data.new_channel_slug, is_rx_only: ws.is_rx_only, speakers: Array.from(activeSpeakers.get(data.new_channel_slug)).map(s => s.split(':')[1]) }
                            }));
                            /*
                             * And who is on camera right now.
                             *
                             * join_channel_success carries the speaker list, so
                             * a transmission already under way is visible at
                             * once. Video had no equivalent: the relay restores
                             * activeVideoRooms from Redis a few lines above, so
                             * it knows, and simply never said. A unit joining
                             * while somebody streamed stayed blind until the
                             * next ptt_video_start -- which on a radio may be
                             * minutes away, or may never come, because the
                             * stream it missed is the one already running.
                             *
                             * Sent to this socket alone; the rest of the channel
                             * already has this.
                             */
                            ws.send(JSON.stringify({
                                type: 'video_stream_status',
                                data: {
                                    streamers: Array.from(activeVideoRooms.get(data.new_channel_slug) || [])
                                        .map(s => s.split(':')[1]),
                                    channel: data.new_channel_slug,
                                    is_private: false,
                                },
                            }));
                            broadcastUsersInChannel(data.new_channel_slug);
                            if (oldRoom) broadcastUsersInChannel(oldRoom);
                        } else {
                            ws.channelTransitioning = false;
                            /*
                             * Say so. This branch did not exist: a unit asking
                             * for a channel it has no row for got no reply at
                             * all, and the handset sat waiting on a
                             * join_channel_success that was never coming. A
                             * refusal the client can see is the difference
                             * between "denied" and "the relay is down".
                             */
                            ws.send(JSON.stringify({
                                type: 'join_error',
                                data: { channel_slug: data.new_channel_slug, message: MSG.NOT_A_CHANNEL_MEMBER },
                            }));
                        }
                    } catch (err) {
                        console.error("❌ Join Error:", err.message);
                    } finally {
                        if (ws.channelJoinGeneration === joinGeneration) {
                            ws.channelTransitioning = false;
                        }
                    }
                    break;

                case 'ptt_audio_start':
                    /*
                     * is_rx_only is deliberately NOT in this guard.
                     *
                     * It is a cache, and the re-read below is what refreshes
                     * it. Short-circuiting on the cached value first meant a
                     * socket refused once stayed refused for the rest of the
                     * session even after the permission came back -- the same
                     * staleness this check exists to remove, pointing the other
                     * way. Found by the test that restores the permission.
                     */
                    if (!ws.sessionUser || !ws.currentRoom) return;
                    /*
                     * Re-read the permission at the moment of transmitting.
                     *
                     * is_rx_only above is a cache written when the socket
                     * joined, and until now it was the entire authorization for
                     * every transmission afterwards. A demotion to RX in the
                     * database reached only sockets that happened to rejoin, or
                     * that POST /api/admin/set-permission pushed to -- anything
                     * editing the table directly left the unit transmitting on
                     * a permission it no longer had, indefinitely.
                     *
                     * Once per key-down, not per audio frame: the binary path
                     * still uses the cache, which by then is at most one press
                     * old rather than one session old.
                     */
                    {
                        const authorization = await authorizeChannelTransmit(ws, channelPermission);
                        if (!authorization.ok) {
                            if (authorization.error) {
                                console.error('❌ Transmit Authorization Error:', authorization.error.message);
                            }
                            return ws.send(JSON.stringify({
                                type: 'ptt_error',
                                data: { message: transmitErrorMessage(authorization.reason) },
                            }));
                        }
                    }

                    ws.pttTraceId = Number.isSafeInteger(data.trace_id) && data.trace_id > 0
                        ? data.trace_id
                        : ws.pttTraceId + 1;
                    ws.pttFrameSequence = 0;
                    tracePtt('start_received', { traceId: ws.pttTraceId });
                    resetAudioArrival(ws);

                    // --- PENANGANAN HALF DUPLEX (SERVER VALIDATION) ---
                    const speakers = activeSpeakers.get(ws.currentRoom);
                    if (ws.duplex_mode === 'HALF DUPLEX' && speakers && speakers.size > 0) {
                        return ws.send(JSON.stringify({
                            type: 'ptt_error',
                            data: { message: "Cannot transmit: channel is busy (Half Duplex)." }
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

                    broadcastToChannel(ws.currentRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(ws.currentRoom)).map(s => s.split(':')[1]), channel: ws.currentRoom, trace_id: ws.pttTraceId } });
                    // The client waits for this explicit acknowledgement before
                    // opening its recorder. A queued binary frame can otherwise
                    // reach this async handler while authorization is still in
                    // flight and be discarded.
                    ws.send(JSON.stringify({
                        type: 'ptt_audio_start_authorized',
                        data: { trace_id: ws.pttTraceId },
                    }));
                    tracePtt('start_forwarded', { traceId: ws.pttTraceId });
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

                        broadcastToChannel(ws.currentRoom, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(ws.currentRoom) || []).map(s => s.split(':')[1]) , channel: ws.currentRoom, trace_id: ws.pttTraceId } });
                        tracePtt('end_forwarded', { traceId: ws.pttTraceId });
                        resetAudioArrival(ws);
                    }
                    break;

                case 'ptt_video_start':
                    if (!ws.sessionUser || !ws.enable_ptt_video || !ws.currentRoom) return;
                    // Video and audio share the same fresh permission check so
                    // receive-only units cannot bypass it through another
                    // media start message.
                    {
                        const authorization = await authorizeChannelTransmit(ws, channelPermission, 'video');
                        if (!authorization.ok) {
                            if (authorization.error) {
                                console.error('❌ Transmit Authorization Error:', authorization.error.message);
                            }
                            return ws.send(JSON.stringify({
                                type: 'ptt_error',
                                data: { message: transmitErrorMessage(authorization.reason) },
                            }));
                        }
                        ws.channelVideoAuthorized = true;
                    }
                    if (!activeVideoRooms.has(ws.currentRoom)) activeVideoRooms.set(ws.currentRoom, new Set());
                    const videoEntry = `${ws.sessionUser.id}:${ws.sessionUser.name}`;
                    activeVideoRooms.get(ws.currentRoom).add(videoEntry);
                    await redisClient.sAdd(`video:${ws.currentRoom}`, videoEntry);
                    broadcastToChannel(ws.currentRoom, { type: 'video_stream_status', data: { streamers: Array.from(activeVideoRooms.get(ws.currentRoom)).map(s => s.split(':')[1]), channel: ws.currentRoom, is_private: false } });
                    break;

                case 'ptt_video_end':
                    // The one caller that always did every step. It is worth
                    // routing through the shared one anyway: this is the copy
                    // the others were meant to be, and leaving it separate is
                    // what let them drift.
                    await stopChannelVideo(ws, ws.currentRoom);
                    break;

                case 'ptt_audio_start_private':
                    if (!ws.sessionUser || !ws.enable_p2p) return;
                    /*
                     * Only into a call that already exists.
                     *
                     * This used to assign ptpTargetId straight from the frame,
                     * so naming any online unit was enough to start pushing
                     * audio at them -- no invitation, no answer, no tenant.
                     * The pairing is established by request/accept and read
                     * here, never written.
                     */
                    if (!ws.ptpTargetId || ws.ptpSessionKind !== 'audio'
                        || String(data.target_id ?? ws.ptpTargetId) !== String(ws.ptpTargetId)) return;

                    ws.pttTraceId = Number.isSafeInteger(data.trace_id) && data.trace_id > 0
                        ? data.trace_id
                        : ws.pttTraceId + 1;
                    ws.pttFrameSequence = 0;
                    tracePtt('start_received', { traceId: ws.pttTraceId });
                    resetAudioArrival(ws);

                    try {
                        await pool.query("UPDATE public.users SET is_speaking = true WHERE id = $1", [String(ws.sessionUser.id)]);
                        await createLog(ws.sessionUser.id, ws.currentChannelId, 'PUSH_PRIVATE');
                    } catch (err) {
                        console.error("❌ Private PTT Start DB Error:", err.message);
                    }

                    ptpPeerFor(ws, 'audio')?.send(JSON.stringify({ type: 'ptt_active_status', data: { speakers: [ws.sessionUser.name], channel: 'private', is_private: true, trace_id: ws.pttTraceId } }));
                    ws.send(JSON.stringify({
                        type: 'ptt_audio_start_authorized',
                        data: { trace_id: ws.pttTraceId },
                    }));
                    tracePtt('start_forwarded', { traceId: ws.pttTraceId });
                    break;

                case 'ptt_audio_end_private':
                    /*
                     * The guard used to wrap only the database write, leaving
                     * the send below reachable by a socket that had never
                     * logged in: enumerate a uid and push a "transmission
                     * ended" into a stranger's client.
                     */
                    if (!ws.sessionUser || !ws.ptpTargetId || ws.ptpSessionKind !== 'audio') return;
                    try {
                        await pool.query("UPDATE public.users SET is_speaking = false WHERE id = $1", [String(ws.sessionUser.id)]);
                        await createLog(ws.sessionUser.id, ws.currentChannelId, 'RELEASE_PRIVATE');
                    } catch (err) {
                        console.error("❌ Private PTT End DB Error:", err.message);
                    }
                    ptpPeerFor(ws, 'audio')?.send(JSON.stringify({ type: 'ptt_active_status', data: { speakers: [], channel: 'private', is_private: true, trace_id: ws.pttTraceId } }));
                    tracePtt('end_forwarded', { traceId: ws.pttTraceId });
                    resetAudioArrival(ws);
                    break;

                case 'request_ptp': {
                    if (!ws.sessionUser || !ws.enable_p2p) return;
                    const targetId = String(data?.target_id ?? '');
                    /*
                     * Offline is claimed only when the socket is actually gone.
                     * peerFor also returns null for a peer in another tenant,
                     * and reporting that as offline sent operators after a
                     * network fault for a unit that was plainly connected.
                     */
                    const { peer: target, reason } = resolvePeer(ws, targetId);
                    if (!target) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: targetId, message: reason === 'offline'
                            ? MSG.PEER_OFFLINE
                            : MSG.PRIVATE_CALL_UNAVAILABLE_FOR_PEER } }));
                        break;
                    }

                    const invitation = createPtpInvite(ws, target, 'audio');
                    if (!invitation.ok) {
                        const message = invitation.reason === 'busy'
                            ? MSG.PEER_BUSY
                            : MSG.PRIVATE_CALL_UNAVAILABLE;
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: targetId, message } }));
                        break;
                    }

                    target.send(JSON.stringify({
                        type: 'ptp_invitation',
                        data: { sender_id: ws.sessionUser.id, sender_name: ws.sessionUser.name },
                    }));
                    break;
                }

                case 'accept_ptp': {
                    if (!ws.sessionUser || !ws.enable_p2p) return;
                    const inviter = String(data?.target_id ?? '');
                    const accepted = consumePtpInvite(ws, inviter, 'audio');
                    if (!accepted.ok) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: inviter, message: MSG.NO_PENDING_INVITATION } }));
                        break;
                    }
                    accepted.peer.send(JSON.stringify({
                        type: 'ptp_confirmed',
                        data: { target_id: ws.sessionUser.id, target_name: ws.sessionUser.name },
                    }));
                    break;
                }

                case 'request_ptp_video': {
                    if (!ws.sessionUser || !ws.enable_p2p || !ws.enable_ptt_video) return;
                    const targetId = String(data?.target_id ?? '');
                    /*
                     * Offline is claimed only when the socket is actually gone.
                     * peerFor also returns null for a peer in another tenant,
                     * and reporting that as offline sent operators after a
                     * network fault for a unit that was plainly connected.
                     */
                    const { peer: target, reason } = resolvePeer(ws, targetId);
                    if (!target) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: targetId, message: reason === 'offline'
                            ? MSG.PEER_OFFLINE
                            : MSG.VIDEO_CALL_UNAVAILABLE_FOR_PEER } }));
                        break;
                    }

                    const invitation = createPtpInvite(ws, target, 'video');
                    if (!invitation.ok) {
                        const message = invitation.reason === 'busy'
                            ? MSG.PEER_BUSY
                            : MSG.VIDEO_CALL_UNAVAILABLE;
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: targetId, message } }));
                        break;
                    }

                    target.send(JSON.stringify({
                        type: 'ptp_video_invitation',
                        data: { sender_id: ws.sessionUser.id, sender_name: ws.sessionUser.name },
                    }));
                    break;
                }

                case 'accept_ptp_video': {
                    if (!ws.sessionUser || !ws.enable_p2p || !ws.enable_ptt_video) {
                        if (ws.sessionUser) {
                            ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: data?.target_id, message: MSG.VIDEO_CALL_UNAVAILABLE } }));
                        }
                        break;
                    }
                    const inviter = String(data?.target_id ?? '');
                    const accepted = consumePtpInvite(ws, inviter, 'video');
                    if (!accepted.ok) {
                        ws.send(JSON.stringify({ type: 'ptp_failed', data: { target_id: inviter, message: MSG.NO_PENDING_INVITATION } }));
                        break;
                    }
                    accepted.peer.send(JSON.stringify({
                        type: 'ptp_video_confirmed',
                        data: { target_id: ws.sessionUser.id, target_name: ws.sessionUser.name },
                    }));
                    break;
                }

                case 'ptt_video_start_private':
                    if (!ws.sessionUser || !ws.enable_p2p || !ws.enable_ptt_video) return;
                    if (!ws.ptpTargetId || ws.ptpSessionKind !== 'video') return;
                    {
                        const privateVideoPeer = ptpPeerFor(ws, 'video');
                        if (!privateVideoPeer || !privateVideoPeer.enable_p2p
                            || !privateVideoPeer.enable_ptt_video) return;
                        privateVideoPeer.send(JSON.stringify({
                            type: 'video_stream_status',
                            data: { streamers: [ws.sessionUser.name], channel: 'private', is_private: true }
                        }));
                    }
                    break;

                case 'ptt_video_end_private':
                    // Had no session check whatsoever -- the only handler in
                    // the file that would act for a socket that never logged in.
                    if (!ws.sessionUser || !ws.enable_p2p || !ws.enable_ptt_video
                        || !ws.ptpTargetId || ws.ptpSessionKind !== 'video') return;
                    {
                        const privateVideoPeer = ptpPeerFor(ws, 'video');
                        if (!privateVideoPeer || !privateVideoPeer.enable_p2p
                            || !privateVideoPeer.enable_ptt_video) return;
                        privateVideoPeer.send(JSON.stringify({
                            type: 'video_stream_status',
                            data: { streamers: [], channel: 'private', is_private: true }
                        }));
                    }
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
                const exitEntry = `${user.id}:${user.name}`;
                if (room && activeSpeakers.has(room)) {
                    activeSpeakers.get(room).delete(exitEntry);
                    await redisClient.sRem(`speakers:${room}`, exitEntry);
                    broadcastToChannel(room, { type: 'ptt_active_status', data: { speakers: Array.from(activeSpeakers.get(room) || []).map(s => s.split(':')[1]), channel: room } });
                }

                /*
                 * The same for video, which this handler used to forget.
                 *
                 * A handset sends no ptt_video_end when it is killed, loses
                 * power or drives into a tunnel, and nothing else removed it, so
                 * it stayed listed as streaming forever. Every other client kept
                 * the incoming-video view up with no frames behind it -- a black
                 * screen the client cannot clear, because the relay is still
                 * saying someone is on camera.
                 *
                 * The entry is mirrored into Redis, so it outlived the process
                 * as well: activeVideoRooms is what every announcement is built
                 * from, so one crash made every later announcement in that
                 * channel wrong.
                 */
                await stopChannelVideo(ws, room);

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

    return wss;
}

module.exports = { attachProtocol };
