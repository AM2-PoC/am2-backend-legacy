// The machine-to-machine credential.
//
// It ships in log-only mode: callers without a key are still served, but every
// one of them is recorded. That is deliberate — enforcing immediately would cut
// off the Admin Native app, which cannot present a key until it is updated.
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

const WEB_ENV = '/etc/am2/webadmin.env.staging';
const NODE_ENV_FILE = '/etc/am2/api.staging.env';
const KEY = envValue(WEB_ENV, 'AM2_API_KEY');
const MODE = (envValue(WEB_ENV, 'AM2_API_AUTH_MODE') || 'log').toLowerCase();
const NODE_MODE = (envValue(NODE_ENV_FILE, 'AM2_API_AUTH_MODE') || 'log').toLowerCase();

const keyed = (path, key) => fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: { Host: HOST, ...(key ? { 'X-AM2-Api-Key': key } : {}) },
});

let sup;
before(async () => { sup = await asSuper(); });

describe('api credential', () => {
    test('a key is configured', () => {
        assert.ok(KEY.length >= 32, 'AM2_API_KEY is missing or too short');
    });

    test('a valid key is accepted regardless of mode', async () => {
        const res = await keyed('/api_dashboard_stats.php?admin_id=1&role=superadmin', KEY);
        assert.equal(res.status, 200);
    });

    test('a panel session is accepted without a key', async () => {
        // dashboard.php refreshes its chart this way. Most api_*.php files never
        // call session_start(), so the check has to open the session itself.
        const res = await get('/api_dashboard_chart.php?admin_id=1&role=superadmin', sup);
        assert.equal(res.status, 200);
    });

    test('an anonymous caller matches the configured mode', async () => {
        const res = await keyed('/api_dashboard_stats.php?admin_id=1&role=superadmin', null);
        if (MODE === 'enforce') {
            assert.equal(res.status, 401);
        } else {
            assert.equal(res.status, 200, 'log mode must not break the mobile app');
        }
    });

    test('a wrong key matches the configured mode', async () => {
        const res = await keyed('/api_dashboard_stats.php?admin_id=1&role=superadmin', 'x'.repeat(64));
        assert.equal(res.status, MODE === 'enforce' ? 401 : 200);
    });

    test('the node admin surface behaves the same way', async () => {
        const anon = await fetch(`${NODE_URL}/api/admin/sync-channels`);
        if (NODE_MODE === 'enforce') {
            assert.equal(anon.status, 401);
        } else {
            assert.equal(anon.status, 400, 'log mode: reaches the handler, which wants userId');
        }
        const withKey = await fetch(`${NODE_URL}/api/admin/sync-channels`, {
            headers: { 'X-AM2-Api-Key': envValue(NODE_ENV_FILE, 'AM2_API_KEY') },
        });
        assert.equal(withKey.status, 400, 'a keyed call reaches the handler');
    });

    test('anonymous calls are recorded, not silently allowed', async () => {
        const before = fs.statSync('/var/log/apache2/am2_staging_error.log').size;
        await keyed('/api_dashboard_stats.php?admin_id=1&role=superadmin', null);
        await new Promise((r) => setTimeout(r, 300));
        const after = fs.readFileSync('/var/log/apache2/am2_staging_error.log', 'utf8').slice(before);
        assert.match(after, /api-auth REJECT-CANDIDATE/,
            'log mode is only useful if it actually logs');
    });

    test('cors is no longer a wildcard', () => {
        const src = fs.readFileSync('/var/www/am2/staging/current/server/server.js', 'utf8');
        assert.ok(!/app\.use\(cors\(\)\)/.test(src), 'app.use(cors()) allows any origin');
        assert.match(src, /AM2_CORS_ORIGINS/);
    });
});

describe('sql injection via a column name', () => {
    test('api_users.php validates the feature name before interpolating it', async () => {
        const { postForm, json } = await import('./helpers.mjs');
        const body = await json(await postForm(
            '/api_users.php?admin_id=1&role=superadmin', null,
            { action: 'update_feature', u_id: 'CT_A1',
              feature: 'enable_maps, updated_at) VALUES (1,1,NOW()) --', val: 'true' }));
        assert.equal(body.success, false, 'the column name reaches the SQL text directly');
    });

    test('both copies of the feature toggle validate identically', async () => {
        const { readSrc } = await import('./helpers.mjs');
        for (const f of ['users.php', 'api_users.php']) {
            const src = readSrc(f);
            assert.ok(/enable_ptt_video/.test(src) &&
                      /(array_key_exists|in_array)/.test(src),
                `${f} interpolates the feature name without checking it`);
        }
    });
});
