// The credential, against the running staging host.
//
// This file used to read the auth-mode variable out of the env file and assert
// whatever that value implied -- 401 when it said one thing, 200 when it said
// another. A test that agrees with the configuration cannot disagree with it,
// so it stayed green through the whole period production was serving
// unauthenticated writes. The expectations are now fixed: an anonymous caller
// is refused, and there is no value anybody can set that changes it.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { asSuper, get, BASE, HOST, NODE_URL } from './helpers.mjs';

function envValue(file, key) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith(key + '=')) return line.slice(key.length + 1).trim();
    }
    return '';
}

const NODE_ENV_FILE = '/etc/am2/api.staging.env';

const anonymous = (path) => fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: { Host: HOST, Accept: 'application/json' },
});

let sup;
before(async () => { sup = await asSuper(); });

describe('api credential', () => {
    test('the relay has a key for the panel to present', () => {
        const key = envValue(NODE_ENV_FILE, 'AM2_API_KEY');
        assert.ok(key.length >= 32, 'AM2_API_KEY is missing or too short');
    });

    test('a panel session is accepted', async () => {
        // dashboard.php refreshes its chart this way. Most api_*.php files never
        // call session_start(), so the guard has to open the session itself.
        const res = await get('/api_dashboard_chart.php', sup);
        assert.equal(res.status, 200);
    });

    test('an anonymous caller is refused', async () => {
        const res = await anonymous('/api_dashboard_stats.php');
        assert.equal(res.status, 401);
    });

    test('naming yourself in the query string buys nothing', async () => {
        // The hole itself: with no session, am2_api_identity() used to return
        // whatever the request claimed, so this exact URL wrote as a superadmin.
        const res = await anonymous('/api_dashboard_stats.php?admin_id=1&role=superadmin');
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.success, false);
    });

    test('a refusal carries a status, not just a message', async () => {
        // fetch_logs.php answered 200 with {error:"Unauthorized"}, which no
        // status-reading client could act on. Admin Native's interceptor keys
        // on 401 and nothing else.
        for (const path of ['/fetch_logs.php', '/get-users-ajax.php']) {
            const res = await anonymous(path);
            assert.equal(res.status, 401, `${path} refuses without a status`);
        }
    });

    test('a browser navigation is sent to the login page instead', async () => {
        const res = await fetch(`${BASE}/dashboard.php`, {
            redirect: 'manual',
            headers: { Host: HOST, Accept: 'text/html,application/xhtml+xml' },
        });
        assert.equal(res.status, 302);
        assert.match(res.headers.get('location') || '', /login\.php/);
    });

    test('signing in needs no session and no token', async () => {
        // The two public entry points have to stay reachable or nobody can ever
        // obtain the session everything else requires.
        const res = await fetch(`${BASE}/login.php`, {
            redirect: 'manual', headers: { Host: HOST, Accept: 'text/html' },
        });
        assert.equal(res.status, 200);
    });

    test('the relay refuses a keyless admin call', async () => {
        const anon = await fetch(`${NODE_URL}/api/admin/sync-channels`);
        assert.equal(anon.status, 401);

        const withKey = await fetch(`${NODE_URL}/api/admin/sync-channels`, {
            headers: { 'X-AM2-Api-Key': envValue(NODE_ENV_FILE, 'AM2_API_KEY') },
        });
        assert.equal(withKey.status, 400, 'a keyed call reaches the handler');
    });

    test('a refusal is recorded as well as refused', async () => {
        const before = fs.statSync('/var/log/apache2/am2_staging_error.log').size;
        await anonymous('/api_dashboard_stats.php');
        await new Promise((r) => setTimeout(r, 300));
        const after = fs.readFileSync('/var/log/apache2/am2_staging_error.log', 'utf8').slice(before);
        assert.match(after, /auth REJECT/,
            'nothing is written when a caller is turned away');
    });

    test('cors is no longer a wildcard', () => {
        const src = fs.readFileSync('/var/www/am2/staging/current/server/server.js', 'utf8');
        assert.ok(!/app\.use\(cors\(\)\)/.test(src), 'app.use(cors()) allows any origin');
        assert.match(src, /AM2_CORS_ORIGINS/);
    });
});
