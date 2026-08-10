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

module.exports = { pool, redisClient, connectRedis, runCleanup, startCleanup, createLog, channelPermission };
