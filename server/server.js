require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

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

const {
    resetSessions, pool, redisClient, connectRedis, startCleanup, createLog,
} = require('./lib/db');
const { commitLoginSession, LoginSessionError } = require('./lib/login-session');
const { registerRoutes } = require('./lib/routes');
const { attachProtocol } = require('./lib/protocol');
const { installShutdown } = require('./lib/shutdown');

connectRedis();
startCleanup();
// Before any socket is accepted: nobody can be connected to a process that has
// only just started, so anything the previous one left marked online is wrong.
resetSessions();

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

/**
 * Compare a presented key against the real one in constant time.
 *
 * `===` on strings returns as soon as two bytes differ, so how long the
 * comparison takes says how much of the key was right. PHP has always done this
 * side correctly with hash_equals(); this half of the same credential check did
 * not, which is the kind of asymmetry that survives precisely because both
 * halves "work". It becomes load-bearing the moment AM2_API_AUTH_MODE is set to
 * enforce.
 *
 * timingSafeEqual throws on a length mismatch, so length is checked first --
 * and length is not the secret.
 */
function sameKey(sent, real) {
    const a = Buffer.from(String(sent));
    const b = Buffer.from(String(real));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/*
 * Fail closed when nobody configures it.
 *
 * This defaulted to 'log', which records an unauthenticated admin call and then
 * runs it. That was right while the callers were being migrated onto a key; it
 * is wrong now that they are, because the safe state has to be the one you get
 * by doing nothing. A control whose default is "allow" is a control waiting to
 * be forgotten on the next host somebody builds.
 */
const API_AUTH_MODE = (process.env.AM2_API_AUTH_MODE || 'enforce').toLowerCase();

app.use('/api/admin', (req, res, next) => {
    /*
     * The header, and only the header.
     *
     * A query string is not a private place: it lands in the access log of
     * every proxy in front of this, in browser history, and in the Referer of
     * the next request. A credential that travels there has been written down
     * in several places nobody is guarding. The only caller -- the panel, via
     * node_client.php -- already sends the header.
     */
    const sent = req.get('X-AM2-Api-Key') || '';
    if (API_KEY && sent && sameKey(sent, API_KEY)) return next();

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
// The protocol lives in lib/protocol.js: one connection that stays open,
// against the endpoints in lib/routes.js that arrive and answer.
const wss = attachProtocol(server, { commitLoginSession, LoginSessionError });

/*
 * A restart ends transmissions instead of severing them.
 *
 * The unit sends SIGINT and nothing handled it, so Node exited on the spot and
 * every socket died at the TCP layer with no close frame -- a handset only
 * learned it was disconnected when the socket timed out, and whoever was
 * mid-sentence was cut mid-word. The grace the unit already allowed through
 * TimeoutStopSec was never used by anything.
 *
 * Three seconds is a transmission, not a deploy: long enough for a press
 * already in the air to finish, short enough that nobody holding the button
 * can hold the release.
 */
installShutdown({
    server,
    wss,
    activeSpeakers,
    graceMs: Number(process.env.AM2_SHUTDOWN_GRACE_MS || 3000),
    hardMs: Number(process.env.AM2_SHUTDOWN_HARD_MS || 8000),
    log: (line) => console.log(line),
});

/*
 * Where the relay offers itself.
 *
 * nginx reaches it on 127.0.0.1 and so does the panel, so listening on every
 * interface bought nothing and put the admin surface one firewall rule away
 * from the internet. Firewall rules are edited by people in a hurry.
 *
 * Configurable because the local compose stack reaches the relay by container
 * name, where loopback would be wrong; the deployed hosts set 127.0.0.1.
 */
const BIND_ADDRESS = (process.env.AM2_BIND_ADDRESS || '').trim();

/*
 * Say so loudly rather than failing quietly.
 *
 * Defaulting the mode to enforce is right -- the safe state should be the one
 * you get by doing nothing -- but on a host where nobody set a key it turns
 * every admin call into a 401, including the panel's own, with nothing in the
 * output explaining why. This is the third state: configured wrong, and said
 * out loud. The relay still starts, because handsets do not need the key and a
 * radio that will not boot is worse than one with a broken admin path.
 */

if (API_AUTH_MODE === 'enforce' && API_KEY === '') {
    console.error(
        '[api-auth] AM2_API_AUTH_MODE=enforce with no AM2_API_KEY: every /api/admin '
        + 'call will be refused, including the panel\'s own.'
    );
}

/*
 * Unset means listen the way Node does by default -- `::` with dual-stack, so
 * both families reach it. Passing '0.0.0.0' as a default instead looked
 * equivalent and was not: it binds IPv4 only, and the container healthcheck
 * asks for `localhost`, which resolves to ::1 first. The stack came up and was
 * declared unhealthy, which is a deployment broken by a hardening default.
 */
const listenArgs = BIND_ADDRESS ? [PORT, BIND_ADDRESS] : [PORT];
server.listen(...listenArgs, () => {
    console.log(`\n--------------------------------------------`);
    console.log(`🚀 PTT SERVER VERSION: 1.1 (RESILIENT CONNECT)`);
    console.log(`🕒 Timezone  : Asia/Jakarta`);
    console.log(`🔄 Reconnect : Enabled (${DISCONNECT_GRACE_PERIOD/1000}s Grace Period)`);
    console.log(`--------------------------------------------\n`);
});
