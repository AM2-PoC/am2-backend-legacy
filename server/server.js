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

app.set('trust proxy', true);

const PORT = process.env.PORT || 5000;
const UPDATE_DIR = path.join(__dirname, 'update');

if (!fs.existsSync(UPDATE_DIR)) {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
}

const {
    activeConnections,
    channelRooms,
    pendingDisconnects,
    DISCONNECT_GRACE_PERIOD,
    activeSpeakers,
    activeVideoRooms,
} = require('./lib/state');

const {
    resetSessions, pool, redisClient, connectRedis, startCleanup, createLog,
    claimRelayOwnership,
} = require('./lib/db');
const { commitLoginSession, LoginSessionError } = require('./lib/login-session');
const { registerRoutes } = require('./lib/routes');
const { attachProtocol } = require('./lib/protocol');
const { installShutdown } = require('./lib/shutdown');

connectRedis();

// Restrict startup mutations to the database owner.
claimRelayOwnership().then((owned) => {
    if (!owned) return;
    startCleanup();
    resetSessions();
});

const CORS_ALLOWED = (process.env.AM2_CORS_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: CORS_ALLOWED.length ? CORS_ALLOWED : false,
    credentials: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.AM2_API_KEY || '';

/**
 * Compare a presented key against the real one in constant time.
 *
 * timingSafeEqual throws when lengths differ.
 */
function sameKey(sent, real) {
    const a = Buffer.from(String(sent));
    const b = Buffer.from(String(real));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.use('/api/admin', (req, res, next) => {
    const sent = req.get('X-AM2-Api-Key') || '';
    if (API_KEY && sent && sameKey(sent, API_KEY)) return next();

    console.warn('[api-auth] REJECT %s %s from %s ua=%s key=%s',
        req.method, req.originalUrl,
        req.get('X-Real-IP') || req.socket.remoteAddress,
        (req.get('User-Agent') || '-').slice(0, 120),
        sent ? 'wrong' : 'absent');

    return res.status(401).json({ success: false, message: 'Unauthorized' });
});


app.use('/update', express.static(UPDATE_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
            res.set('Content-Type', 'application/vnd.android.package-archive');
            res.set('Content-Disposition', 'attachment; filename="update.apk"');
        }
    }
}));


const {
    broadcastChannelUpdate,
    broadcastToChannel,
    broadcastUsersInChannel,
    updateUserLocation,
    broadcastChannelNameChange,
} = require('./lib/broadcast');


registerRoutes(app);

const wss = attachProtocol(server, { commitLoginSession, LoginSessionError });

// Allow active transmissions to drain during shutdown.
installShutdown({
    server,
    wss,
    activeSpeakers,
    graceMs: Number(process.env.AM2_SHUTDOWN_GRACE_MS || 3000),
    hardMs: Number(process.env.AM2_SHUTDOWN_HARD_MS || 8000),
    log: (line) => console.log(line),
});

// Production binds loopback; containers may require an explicit interface.
const BIND_ADDRESS = (process.env.AM2_BIND_ADDRESS || '').trim();

if (API_KEY === '') {
    console.error(
        '[api-auth] AM2_API_KEY is not set: every /api/admin call will be '
        + 'refused, including the panel\'s own.'
    );
}

// Omitting the host preserves Node's dual-stack default.
const listenArgs = BIND_ADDRESS ? [PORT, BIND_ADDRESS] : [PORT];
server.listen(...listenArgs, () => {
    console.log(
        'PTT server listening on %s:%s; reconnect grace %ss',
        BIND_ADDRESS || 'default', PORT, DISCONNECT_GRACE_PERIOD / 1000,
    );
});
