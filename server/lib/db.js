/**
 * Postgres, Redis, and the two things the relay writes without being asked.
 *
 * Importing this file connects nothing and starts no timer: connectRedis() and
 * startCleanup() are called once by server.js. A module that opens a socket
 * when it is required cannot be loaded by a test that only wants to read a
 * query.
 */
const { Pool } = require('pg');
const { createClient } = require('redis');

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

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error', err));

const connectRedis = async () => {
    try {
        await redisClient.connect();
        console.log('🚀 Redis Connected');
    } catch (err) {
        console.error('❌ Redis Connection Failed:', err.message);
    }
};

/** Logs older than 30 days. The activity log's free-text rows age out here. */
const runCleanup = async () => {
    console.log('🧹 Running automatic log cleanup (30 days)...');
    try {
        // Hapus log aktivitas PTT (Push/Release/Login)
        const pttRes = await pool.query("DELETE FROM public.ptt_logs WHERE event_time < NOW() - INTERVAL '30 days'");
        // Hapus log aktivitas Admin
        const adminRes = await pool.query("DELETE FROM public.admin_activity_logs WHERE waktu < NOW() - INTERVAL '30 days'");

        console.log(`✅ Cleanup complete: removed ${pttRes.rowCount} PTT logs & ${adminRes.rowCount} admin logs.`);
    } catch (err) {
        console.error('❌ Cleanup Error:', err.message);
    }
};

/**
 * Nobody is connected to a process that has just started.
 *
 * Session state lives in two places. In memory, which a restart clears for
 * free; and in public.users -- status, current_device_id, is_speaking -- which
 * it does not. Only the close handler wrote those back, behind a ten second
 * grace timer, so any termination that is not graceful left them set: a crash,
 * an OOM kill, or `systemctl restart` during a deploy, which is every deploy
 * with anyone on the air.
 *
 * The roster then lies -- broadcastUsersInChannel selects on status = 'online'
 * -- and, worse, login can be refused outright: the single-device check reads
 * current_device_id and, outside a grace period, refuses a different one. The
 * operator is told they are signed in on another device when no device is
 * signed in anywhere, and the only recovery is an administrator editing the
 * row. ANDROID_ID is derived from the signing key, so a handset that installs a
 * build signed with a different key presents a new device id to a row that
 * still names the old one.
 *
 * Unconditional, because the premise is: this process has no connections yet.
 * It corrects session state and nothing else.
 */
const resetSessions = async () => {
    try {
        const res = await pool.query(
            "UPDATE public.users SET status = 'offline', current_device_id = NULL, is_speaking = false "
            + "WHERE status <> 'offline' OR current_device_id IS NOT NULL OR is_speaking"
        );
        if (res.rowCount) {
            console.log(`\u{1F9F9} Cleared ${res.rowCount} session(s) left by the previous process.`);
        }
    } catch (err) {
        // A radio that will not start because a cleanup query failed is worse
        // than one that starts with a stale roster.
        console.error('\u274C Session reset error:', err.message);
    }
};

/*
 * Device tokens: issuing, checking, and taking back.
 *
 * The credential itself is made in lib/device-tokens.js, which touches no
 * database and can therefore be tested anywhere. These are the three things
 * that need the pool.
 */
const { newToken, hashToken } = require('./device-tokens');

/** Issue one, replacing whatever that device held before. */
const issueDeviceToken = async (userId, deviceId) => {
    const token = newToken();
    if (deviceId) {
        await pool.query(
            'DELETE FROM public.device_tokens WHERE user_id = $1 AND device_id = $2',
            [userId, deviceId],
        );
    }
    await pool.query(
        `INSERT INTO public.device_tokens (token_hash, user_id, device_id, last_used_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [hashToken(token), userId, deviceId || null],
    );
    return token;
};

/**
 * The user this token belongs to, or null.
 *
 * Looked up by digest, so a token that is not in the table is
 * indistinguishable from one that never existed. last_used_at is written
 * because a token nobody has presented in months is the one worth asking
 * about.
 */
/*
 * A token nobody has used for this long stops being one.
 *
 * Revocation is what makes a permanently stored token acceptable: a lost
 * handset costs an admin one click rather than a password change for the
 * person. But revocation is somebody noticing and acting, and a radio that
 * quietly disappears -- left in a vehicle, in a drawer, sold with the phone --
 * is never reported. Its token would stay valid for as long as the row exists.
 *
 * So there is a backstop that needs nobody to notice. last_used_at is written
 * on every token login, so a handset in daily use never approaches this; only
 * one that has stopped being used does.
 *
 * Ninety days, because a spare radio left in a drawer between deployments has
 * to start when it is picked up. A limit measured in hours or days would make
 * this the thing that takes radios off the air, which is the failure it exists
 * to prevent.
 */
const TOKEN_MAX_IDLE_DAYS = 90;

const userForDeviceToken = async (token) => {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = hashToken(token);
    const res = await pool.query(
        `SELECT user_id, device_id FROM public.device_tokens
          WHERE token_hash = $1
            AND last_used_at > CURRENT_TIMESTAMP - ($2 || ' days')::interval`,
        [hash, String(TOKEN_MAX_IDLE_DAYS)],
    );
    if (res.rows.length === 0) return null;
    await pool.query(
        'UPDATE public.device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
        [hash],
    );
    return {
        userId: String(res.rows[0].user_id),
        deviceId: res.rows[0].device_id ?? null,
        tokenHash: hash,
    };
};

/** Take them all back. What happens when a handset is lost. */
const revokeDeviceTokens = async (userId) => {
    const res = await pool.query(
        'DELETE FROM public.device_tokens WHERE user_id = $1',
        [userId],
    );
    return res.rowCount || 0;
};

/** On boot, then once a day. */
const startCleanup = () => {
    runCleanup();
    return setInterval(runCleanup, 86400000);
};

/**
 * One transmission, recorded.
 *
 * Never throws: a log write must not be the reason a live channel drops a
 * frame. A bad channel id is stored as null rather than refused, because the
 * event still happened.
 */
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


/**
 * What a unit is allowed to do on one channel, right now.
 *
 * The relay reads permission once, when a socket joins, and caches it on the
 * socket as is_rx_only. That cache is the whole authorization for every
 * transmission afterwards, so a demotion to RX in the database does not reach
 * a unit that is already connected -- it keeps transmitting until it happens
 * to rejoin. Only POST /api/admin/set-permission pushed an update live;
 * anything that edits the table directly left the socket stale indefinitely.
 *
 * Returns null when the unit has no row for that channel at all, which is the
 * same answer as "not a member".
 */
async function channelPermission(userId, channelSlug) {
    const { rows } = await pool.query(`
        SELECT uc.permission, c.id, c.display_name
        FROM public.user_channels uc
        JOIN public.channels c ON uc.channel_id = c.id
        WHERE uc.user_id = $1 AND c.name = $2
    `, [String(userId), channelSlug]);
    return rows[0] ?? null;
}

module.exports = {
    issueDeviceToken, userForDeviceToken, revokeDeviceTokens,
    resetSessions, pool, redisClient, connectRedis, runCleanup, startCleanup, createLog, channelPermission };
