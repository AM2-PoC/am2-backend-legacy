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

/*
 * Whether this process is the relay for this database, or only visiting it.
 *
 * The premise under resetSessions() and the boot-time cleanup is "this process
 * has no connections yet". That is true of the process and false of the
 * database, which is shared. infra/scripts/smoke-release.sh proves a candidate
 * release can cold-start by running server.js against the real environment file
 * on a loopback port -- so every deploy started a second relay against
 * production, and that second relay reset every live session and deleted logs
 * before exiting.
 *
 * Measured on production: the busiest unit on the network, 137 transmissions in
 * fifteen minutes and one seven seconds earlier, sat at status='offline' with
 * its row untouched since login. Live Track selects on status='online', so it
 * had been invisible on the map for hours while transmitting perfectly.
 *
 * A session-scoped advisory lock says it exactly: whoever holds it is the relay
 * for this database. The real relay takes it at boot and keeps it for its
 * lifetime; a probe cannot take it, learns it is a visitor, and skips every
 * boot-time write while still proving it can start, connect and answer.
 *
 * No cooperation is needed from whoever launches the process, which is the
 * point -- a flag the caller has to remember is a flag the next caller forgets.
 * On a genuine cold start nobody holds the lock, it is taken, and the reset runs
 * as it always did.
 *
 * The key is arbitrary and permanent; changing it would let two relays each
 * believe they own the same database.
 */
const RELAY_OWNER_LOCK_KEY = 0x414d3201; // "AM2" + 1

let relayOwnership = null;

const claimRelayOwnership = async () => {
    if (relayOwnership) return relayOwnership;
    relayOwnership = (async () => {
        try {
            // A dedicated client, held for the life of the process: an advisory
            // lock belongs to a session, and a pooled connection handed back
            // would drop it the moment it was reused.
            const client = await pool.connect();
            const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS held', [RELAY_OWNER_LOCK_KEY]);
            if (rows[0]?.held !== true) {
                client.release();
                console.log('\u{1F50E} Another relay owns this database; starting as a probe and touching nothing.');
                return false;
            }

            client.on('error', (err) => {
                console.error('\u274C Relay ownership connection error:', err.message);
            });
            return true;
        } catch (err) {

            console.error('\u274C Relay ownership check failed:', err.message);
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
            console.log(`\u{1F9F9} Cleared ${res.rowCount} session(s) left by the previous process.`);
        }
    } catch (err) {

        console.error('\u274C Session reset error:', err.message);
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
