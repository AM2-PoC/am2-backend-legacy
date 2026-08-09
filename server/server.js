require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

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

const { pool, redisClient, connectRedis, startCleanup, createLog } = require('./lib/db');
const { registerRoutes } = require('./lib/routes');
const { attachProtocol } = require('./lib/protocol');

connectRedis();
startCleanup();

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
attachProtocol(server);

server.listen(PORT, () => {
    console.log(`\n--------------------------------------------`);
    console.log(`🚀 PTT SERVER VERSION: 1.1 (RESILIENT CONNECT)`);
    console.log(`🕒 Timezone  : Asia/Jakarta`);
    console.log(`🔄 Reconnect : Enabled (${DISCONNECT_GRACE_PERIOD/1000}s Grace Period)`);
    console.log(`--------------------------------------------\n`);
});
