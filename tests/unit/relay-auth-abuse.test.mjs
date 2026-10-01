// Hosted/offline only: execute the real attachProtocol; never start server.js.
// External I/O is replaced before CommonJS evaluation, so no pg/redis/bcrypt
// package, credentials, HTTP listener, or live service is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LOGIN_WINDOW_MS = 60_000;
const SOCKET_ATTEMPTS = 5;
const IDENTITY_ATTEMPTS = 10;
const RELAY_CONCURRENCY = 8;
const IDENTITY_BUCKETS = 1024;
const LOGIN_DEADLINE_MS = 30_000;
const token = 'a'.repeat(64); // Synthetic; not a credential for any service.
const rotatedToken = 'b'.repeat(64);
const login = (data = {}) => ({
    type: 'app_login',
    data: { username: 'TEST_UNIT', password: 'synthetic password', current_device_id: 'test-device', ...data },
});
const defer = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function harness({ accept = false, queryGate = null, bcryptGate = null, commitGate = null } = {}) {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    const jobs = [];
    const rejected = [];
    const calls = { query: [], bcrypt: [], token: [], commit: [], log: [] };
    let activeQueries = 0;
    let peakQueries = 0;
    let activeBcrypt = 0;
    let peakBcrypt = 0;
    const track = (work) => {
        const settled = Promise.resolve(work).catch((error) => { rejected.push(error); });
        jobs.push(settled);
        return settled;
    };
    const dispatch = (emitter, event, ...args) => {
        for (const listener of emitter.listeners(event)) {
            try { track(listener(...args)); } catch (error) { rejected.push(error); }
        }
    };
    const schedule = (callback, delay, repeat = false) => {
        const handle = { id: ++sequence, unref() { return this; } };
        timers.set(handle, { callback, at: now + Number(delay), delay: Number(delay), repeat });
        return handle;
    };
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [1_800_000_000_000 + now])); }
        static now() { return 1_800_000_000_000 + now; }
    }
    const globals = {
        Buffer, Date: ClockDate,
        process: { env: {}, hrtime: process.hrtime },
        console: { log() {}, info() {}, warn() {}, error() {} },
        setTimeout: (fn, ms) => schedule(fn, ms),
        clearTimeout: (handle) => timers.delete(handle),
        setInterval: (fn, ms) => schedule(fn, ms, true),
        clearInterval: (handle) => timers.delete(handle),
    };
    const load = (relative, dependencies = {}) => {
        const url = new URL(relative, import.meta.url);
        const module = { exports: {} };
        vm.runInNewContext(readFileSync(url, 'utf8'), {
            ...globals, module, exports: module.exports,
            require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : createRequire(url)(name),
        }, { filename: url.pathname });
        return module.exports;
    };
    const state = load('../../server/lib/state.js');
    class Socket extends EventEmitter {
        readyState = 1;
        bufferedAmount = 0;
        inbox = [];
        send(message) {
            assert.equal(this.readyState, 1, 'a closed socket received a protocol answer');
            this.inbox.push(JSON.parse(String(message)));
        }
        ping() { this.emit('pong'); }
        close(code = 1000) {
            if (this.readyState !== 1) return;
            this.readyState = 3;
            dispatch(this, 'close', code);
        }
        terminate() { this.close(1006); }
    }
    class Server extends EventEmitter {
        clients = new Set();
        close() { this.emit('close'); }
    }
    const channels = [{ slug: 'test-room', display_name: 'Test room', permission: 'TX' }];
    const user = {
        id: 'TEST_UNIT', name: 'Test unit', password: 'synthetic-hash', admin_id: 1,
        admin_status: 'active', last_channel_id: 1, last_channel_name: 'Test room',
        last_channel_slug: 'test-room', current_device_id: null, force_logout: false,
    };
    const pool = {
        async query(sql, params) {
            calls.query.push({ sql, params });
            if (/FROM public\.users u/.test(sql)) {
                activeQueries += 1;
                peakQueries = Math.max(peakQueries, activeQueries);
                try {
                    if (queryGate) await queryGate.promise;
                    return { rows: [{ ...user }] };
                } finally { activeQueries -= 1; }
            }
            if (/SELECT 1 FROM public\.user_channels/.test(sql)) return { rows: [{ '?column?': 1 }] };
            if (/SELECT c\.name as slug/.test(sql)) return { rows: channels };
            throw new Error(`Unexpected test SQL: ${sql}`);
        },
    };
    const db = {
        pool,
        redisClient: {
            async sAdd() {}, async sRem() {}, async sMembers() { return []; },
        },
        async createLog(...args) { calls.log.push(args); },
        async channelPermission() { return { id: 1, permission: 'TX', display_name: 'Test room' }; },
        async userForDeviceToken(value) {
            calls.token.push(value);
            return value === token ? { userId: user.id, deviceId: 'test-device', tokenHash: 'synthetic-token-hash' } : null;
        },
    };
    const bcrypt = {
        async compare(...args) {
            calls.bcrypt.push(args);
            activeBcrypt += 1;
            peakBcrypt = Math.max(peakBcrypt, activeBcrypt);
            try { if (bcryptGate) await bcryptGate.promise; return accept; }
            finally { activeBcrypt -= 1; }
        },
    };
    const { attachProtocol } = load('../../server/lib/protocol.js', {
        ws: { Server, OPEN: 1 }, bcryptjs: bcrypt, './db': db, './state': state,
        './broadcast': {
            broadcastToChannel() {}, broadcastUsersInChannel() {},
            async stopChannelVideo() { return false; }, async updateUserLocation() {},
        },
    });
    const wss = attachProtocol({}, {
        async commitLoginSession(...args) {
            calls.commit.push(args);
            if (commitGate) await commitGate.promise;
            return rotatedToken;
        },
        LoginSessionError: require('../../server/lib/login-session.js').LoginSessionError,
    });
    return {
        calls, rejected, state, user,
        peakQueries: () => peakQueries,
        peakBcrypt: () => peakBcrypt,
        socket() {
            const ws = new Socket();
            wss.clients.add(ws);
            wss.emit('connection', ws); // Native caller: no Origin header.
            return ws;
        },
        async frame(ws, payload) {
            dispatch(ws, 'message', Buffer.from(JSON.stringify(payload)), false);
            await flush();
        },
        async idle() { await Promise.all(jobs); await flush(); },
        async advance(ms) {
            const until = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [handle, timer] = due;
                now = timer.at;
                if (timer.repeat) timer.at += timer.delay;
                else timers.delete(handle);
                try { track(timer.callback()); } catch (error) { rejected.push(error); }
                await flush();
            }
            now = until;
            await flush();
        },
    };
}

const invalid = [
    ['JSON null', null],
    ['JSON array', []],
    ['login without data', { type: 'app_login' }],
    ['null login data', { type: 'app_login', data: null }],
    ['array login data', { type: 'app_login', data: [] }],
    ['numeric identity', login({ username: 7 })],
    ['object device id', login({ current_device_id: {} })],
    ['array password', login({ password: [] })],
    ['empty identity', login({ username: '  ' })],
    ['missing credential', { type: 'app_login', data: { username: 'TEST_UNIT' } }],
    ['object token', login({ token: {} })],
    ['malformed token', login({ token: 'not-a-device-token' })],
    ['oversized identity', login({ username: 'u'.repeat(513) })],
    ['oversized password', login({ password: 'p'.repeat(1025) })],
    ['oversized device id', login({ current_device_id: 'd'.repeat(257) })],
    ['multibyte identity over byte bound', login({ username: 'é'.repeat(257) })],
];
for (const [name, payload] of invalid) {
    test(`invalid frame: ${name} settles without database or bcrypt work`, async () => {
        const h = harness();
        await h.frame(h.socket(), payload);
        await h.idle();
        assert.equal(h.rejected.length, 0, 'malformed valid JSON rejected the async message listener');
        assert.equal(h.calls.query.length, 0, 'invalid login reached the database');
        assert.equal(h.calls.bcrypt.length, 0, 'invalid login reached bcrypt');
        assert.equal(h.calls.token.length, 0, 'invalid login reached token verification');
        assert.equal(h.calls.commit.length, 0, 'invalid login published a session');
    });
}

test('malformed control data cannot reject an authenticated message listener', async () => {
    const h = harness({ accept: true });
    const ws = h.socket();
    await h.frame(ws, login());
    await h.idle();
    for (const type of ['vox_level', 'update_refused', 'update_location', 'join_channel', 'ptt_audio_start_private']) {
        await h.frame(ws, { type, data: null });
    }
    await h.idle();
    assert.equal(h.rejected.length, 0, 'control data escaped the JSON validation boundary');
});

test('a same-socket login burst admits one operation and retains no pending login work', async () => {
    const gate = defer();
    const h = harness({ bcryptGate: gate });
    const ws = h.socket();
    try {
        for (let i = 0; i < 20; i += 1) await h.frame(ws, login());
        assert.equal(h.peakBcrypt(), 1, 'concurrent app_login bcrypt work exceeded one per socket');
        assert.equal(h.calls.query.length, 1, 'busy frames reached the database or an unbounded queue');
        assert.equal(h.calls.bcrypt.length, 1, 'busy frames reached bcrypt');
        assert.equal(ws.inbox.filter((message) => message.type === 'login_error').length, 19);
        assert.ok(ws.inbox.every((message) => message.data.code === 'server_unavailable'),
            'busy refusal must preserve Android stored credentials');
    } finally { gate.resolve(); await h.idle(); }
    assert.equal(h.calls.query.length, 1, 'discarded busy frames ran after the first login settled');
    assert.equal(h.calls.bcrypt.length, 1);
});

test('the same-socket admission remains held through token/session commit', async () => {
    const gate = defer();
    const h = harness({ accept: true, commitGate: gate });
    const ws = h.socket();
    await h.frame(ws, login());
    try {
        assert.equal(h.calls.commit.length, 1, 'first login never reached the commit gate');
        await h.frame(ws, login());
        assert.equal(h.calls.bcrypt.length, 1, 'admission was released before login commit settled');
        assert.equal(h.calls.commit.length, 1, 'a second session commit started concurrently');
        assert.equal(ws.inbox.at(-1)?.data.code, 'server_unavailable');
    } finally { gate.resolve(); await h.idle(); }
    assert.equal(h.calls.commit.length, 1, 'a discarded duplicate minted a token after release');
    assert.equal(ws.inbox.filter((message) => message.type === 'login_success').length, 1);
});

test('relay-wide admission caps concurrent login lookup work without a NAT/IP bucket', async () => {
    const gate = defer();
    const h = harness({ queryGate: gate });
    const sockets = [];
    try {
        for (let i = 0; i < RELAY_CONCURRENCY * 2; i += 1) {
            const ws = h.socket();
            sockets.push(ws);
            await h.frame(ws, login({ username: `TEST_UNIT_${i}` }));
        }
        assert.equal(h.peakQueries(), RELAY_CONCURRENCY, 'relay login concurrency exceeded its bound');
        assert.equal(h.calls.query.length, RELAY_CONCURRENCY, 'globally throttled frames reached the database');
        assert.equal(h.calls.bcrypt.length, 0);
        const refusals = sockets.flatMap((ws) => ws.inbox);
        assert.equal(refusals.length, RELAY_CONCURRENCY);
        assert.ok(refusals.every((message) => message.type === 'login_error' && message.data.code === 'server_unavailable'));
    } finally { gate.resolve(); await h.idle(); }
    assert.equal(h.calls.bcrypt.length, RELAY_CONCURRENCY, 'globally rejected frames ran later');
});

test('relay-wide admission stays bounded while bcrypt is awaiting completion', async () => {
    const gate = defer();
    const h = harness({ bcryptGate: gate });
    try {
        for (let i = 0; i < RELAY_CONCURRENCY * 2; i += 1) {
            await h.frame(h.socket(), login({ username: `TEST_UNIT_${i}` }));
        }
        assert.equal(h.peakBcrypt(), RELAY_CONCURRENCY, 'relay-wide bcrypt concurrency exceeded its bound');
        assert.equal(h.calls.query.length, RELAY_CONCURRENCY, 'global busy frames reached lookup');
        assert.equal(h.calls.bcrypt.length, RELAY_CONCURRENCY);
    } finally { gate.resolve(); await h.idle(); }
    assert.equal(h.calls.bcrypt.length, RELAY_CONCURRENCY, 'global busy frames were queued for later execution');
});

test('completed wrong-password retries are limited before database and bcrypt', async () => {
    const h = harness();
    const ws = h.socket();
    for (let i = 0; i < SOCKET_ATTEMPTS; i += 1) {
        await h.frame(ws, login());
        await h.idle();
        assert.equal(ws.inbox.at(-1).data.code, 'credential_rejected');
    }
    const before = [h.calls.query.length, h.calls.bcrypt.length];
    await h.frame(ws, login());
    await h.idle();
    assert.deepEqual([h.calls.query.length, h.calls.bcrypt.length], before,
        'rate-limited retry performed database/bcrypt work');
    assert.equal(ws.inbox.at(-1).data.code, 'server_unavailable', 'throttle blocked the Android stored session');
});

test('identity retry budget survives new sockets and resets after its bounded window', async () => {
    const h = harness();
    for (let i = 0; i < IDENTITY_ATTEMPTS; i += 1) {
        await h.frame(h.socket(), login({ username: i % 2 ? ' test_unit ' : 'TEST_UNIT' }));
        await h.idle();
    }
    const ws = h.socket();
    const before = [h.calls.query.length, h.calls.bcrypt.length];
    await h.frame(ws, login());
    await h.idle();
    assert.deepEqual([h.calls.query.length, h.calls.bcrypt.length], before,
        'reconnect bypassed the normalized identity retry budget');
    assert.equal(ws.inbox.at(-1).data.code, 'server_unavailable');
    await h.advance(LOGIN_WINDOW_MS + 1);
    const next = h.socket();
    await h.frame(next, login());
    await h.idle();
    assert.equal(h.calls.bcrypt.length, before[1] + 1, 'expired identity budget never recovered');
    assert.equal(next.inbox.at(-1).data.code, 'credential_rejected');
});

test('identity limiter capacity refuses unseen identities instead of evicting live retry budgets', async () => {
    const h = harness();
    for (let i = 0; i < IDENTITY_BUCKETS; i += 1) {
        await h.frame(h.socket(), login({ username: `UNKNOWN_UNIT_${i}` }));
        await h.idle();
    }
    const ws = h.socket();
    const before = [h.calls.query.length, h.calls.bcrypt.length];
    await h.frame(ws, login({ username: 'ONE_MORE_UNIT' }));
    await h.idle();
    assert.deepEqual([h.calls.query.length, h.calls.bcrypt.length], before,
        'full identity limiter admitted more credential work');
    assert.equal(ws.inbox.at(-1).data.code, 'server_unavailable');
});

test('unauthenticated sockets have an absolute login deadline despite pongs and non-login frames', async () => {
    const h = harness();
    const ws = h.socket();
    await h.advance(LOGIN_DEADLINE_MS - 1);
    ws.emit('pong');
    await h.frame(ws, { type: 'cancel_ptp', data: {} });
    assert.equal(ws.readyState, 1, 'login deadline was shorter than the compatibility bound');
    await h.advance(2);
    assert.notEqual(ws.readyState, 1, 'unauthenticated socket survived its login deadline');
    assert.equal(h.calls.query.length, 0);
    assert.equal(h.calls.bcrypt.length, 0);
});

for (const stage of ['query', 'commit']) {
    test(`deadline during ${stage} cannot publish late authentication`, async () => {
        const gate = defer();
        const h = harness({ accept: true, [stage === 'query' ? 'queryGate' : 'commitGate']: gate });
        const ws = h.socket();
        await h.frame(ws, login());
        await h.advance(LOGIN_DEADLINE_MS + 1);
        gate.resolve();
        await h.idle();
        assert.equal(ws.sessionUser, null, 'expired in-flight login revived local authorization');
        assert.equal(h.state.activeConnections.has('TEST_UNIT'), false, 'expired socket entered active routing');
        assert.equal(ws.inbox.some((message) => message.type === 'login_success'), false);
        assert.equal(h.rejected.length, 0, 'late login completion rejected the message listener');
        if (stage === 'query') {
            assert.equal(h.calls.bcrypt.length, 0, 'expired login continued expensive authentication');
            assert.equal(h.calls.commit.length, 0, 'expired lookup minted a device token');
        }
    });
}

for (const [kind, data] of [
    ['password with absent device/build metadata', { username: ' TEST_UNIT ', password: ' synthetic password ' }],
    ['token resume (token wins over password)', { username: 'TEST_UNIT', token, password: 'ignored', current_device_id: ' test-device ' }],
]) {
    test(`native compatibility: ${kind}`, async () => {
        const h = harness({ accept: true });
        const ws = h.socket();
        await h.frame(ws, { type: 'app_login', data });
        await h.idle();
        const response = ws.inbox.find((message) => message.type === 'login_success');
        assert.ok(response, 'normal native login no longer succeeds');
        assert.deepEqual(response.data, {
            id: 'TEST_UNIT', username: 'Test unit', device_token: rotatedToken,
            enable_maps: true, enable_p2p: true, enable_ptt_video: false,
            duplex_mode: 'HALF DUPLEX', last_channel_id: 1,
            default_channel_name: 'Test room', default_channel_slug: 'test-room',
            channels: [{ slug: 'test-room', display_name: 'Test room', permission: 'TX' }],
        });
        assert.equal(h.calls.query[0].params[0], 'TEST_UNIT');
        assert.equal(ws.currentRoom, null, 'login joined the channel before native join_channel');
        assert.equal(h.calls.commit.length, 1);
        const options = h.calls.commit[0][1];
        if (kind.startsWith('token')) {
            assert.equal(h.calls.bcrypt.length, 0, 'token resume reached bcrypt');
            assert.deepEqual(h.calls.token, [token]);
            assert.equal(options.sourceTokenHash, 'synthetic-token-hash');
            assert.equal(options.sourceDeviceId, 'test-device');
            assert.equal(options.expectedPasswordHash, null);
        } else {
            assert.deepEqual(h.calls.bcrypt, [['synthetic password', 'synthetic-hash']]);
            assert.equal(h.calls.token.length, 0);
            assert.equal(options.deviceId, null);
            assert.equal(options.expectedPasswordHash, 'synthetic-hash');
        }
        await h.advance(LOGIN_DEADLINE_MS + 1);
        assert.equal(ws.readyState, 1, 'successful authentication retained the unauthenticated deadline');
        assert.equal(h.rejected.length, 0);
    });
}

test('duplicate login on an authenticated socket is ignored without login_error or credential work', async () => {
    const h = harness({ accept: true });
    const ws = h.socket();
    await h.frame(ws, login());
    await h.idle();
    const before = [h.calls.query.length, h.calls.bcrypt.length, h.calls.commit.length, ws.inbox.length];
    await h.frame(ws, login({ username: 'OTHER_UNIT' }));
    await h.idle();
    assert.deepEqual([h.calls.query.length, h.calls.bcrypt.length, h.calls.commit.length, ws.inbox.length], before,
        'duplicate login reauthenticated or sent login_error into an authorized Android session');
    assert.equal(ws.sessionUser.id, 'TEST_UNIT');
});
