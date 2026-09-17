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
    console.error('Database Pool Error:', err.message);
});

pool.on('connect', () => {
    console.log('New DB Client connected to pool');
});

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

const connectRedis = async () => {
    try {
        await redisClient.connect();
        console.log('Redis Connected');
    } catch (err) {
        console.error('Redis Connection Failed:', err.message);
    }
};

const runCleanup = async () => {
    console.log('Running automatic log cleanup (30 days)...');
    try {

        const pttRes = await pool.query("DELETE FROM public.ptt_logs WHERE event_time < NOW() - INTERVAL '30 days'");

        const adminRes = await pool.query("DELETE FROM public.admin_activity_logs WHERE waktu < NOW() - INTERVAL '30 days'");

        console.log(`Cleanup complete: removed ${pttRes.rowCount} PTT logs & ${adminRes.rowCount} admin logs.`);
    } catch (err) {
        console.error('Cleanup Error:', err.message);
    }
};

/* A process may perform boot-time writes only while it owns this permanent advisory lock. */
const RELAY_OWNER_LOCK_KEY = 0x414d3201; // "AM2" + 1

let relayOwnership = null;

const claimRelayOwnership = async () => {
    if (relayOwnership) return relayOwnership;
    relayOwnership = (async () => {
        try {
            // Advisory locks are session-scoped, so this client remains checked out.
            const client = await pool.connect();
            const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS held', [RELAY_OWNER_LOCK_KEY]);
            if (rows[0]?.held !== true) {
                client.release();
                console.log('Another relay owns this database; starting as a probe and touching nothing.');
                return false;
            }

            client.on('error', (err) => {
                console.error('Relay ownership connection error:', err.message);
            });
            return true;
        } catch (err) {

            console.error('Relay ownership check failed:', err.message);
            return false;
        }
    })();
    return relayOwnership;
};

const resetSessions = async () => {
    try {
        const res = await pool.query(
            "UPDATE public.users SET status = 'offline', current_device_id = NULL, is_speaking = false "
            + "WHERE status <> 'offline' OR current_device_id IS NOT NULL OR is_speaking"
        );
        if (res.rowCount) {
            console.log(`Cleared ${res.rowCount} session(s) left by the previous process.`);
        }
    } catch (err) {

        console.error('Session reset error:', err.message);
    }
};

const { hashToken } = require('./device-tokens');

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

const startCleanup = () => {
    runCleanup();
    return setInterval(runCleanup, 86400000);
};

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
        console.error(`LOG ERROR [${eventType}]:`, err.message);
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
    userForDeviceToken,
    resetSessions, pool, redisClient, connectRedis, runCleanup, startCleanup, createLog, channelPermission,
    claimRelayOwnership };
