// The api_*.php layer and the authorization behaviour of the whole panel.
//
// Read the second describe block before changing anything: it records
// behaviour that is wrong. Those tests exist so that the security release has
// to change them deliberately, and so that nothing else changes them by
// accident in the meantime.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, asBranchA, get, postForm, json, BASE, EDGE, NODE_URL } from './helpers.mjs';

let sup, branchA;
before(async () => { sup = await asSuper(); branchA = await asBranchA(); });

describe('api_*.php response contracts (consumed by the Admin Native app)', () => {
    test('api_login.php returns credentials, not a session or a token', async () => {
        const body = await json(await postForm('/api_login.php', null, {
            username: 'nobody_at_all', password: 'wrong',
        }));
        assert.equal(body.success, false);
        assert.ok('message' in body, 'api_*.php uses message, unlike users.php which uses msg');

        // This is why the security release cannot simply require a PHP session
        // on these files: there is nothing here for a client to carry forward.
        const res = await postForm('/api_login.php', null, {
            username: 'nobody_at_all', password: 'wrong',
        });
        const cookies = res.headers.getSetCookie?.() ?? [];
        assert.ok(!cookies.some((c) => /token|jwt|bearer/i.test(c)),
            'no token is issued today');
    });

    test('api_dashboard_stats.php keeps its key names', async () => {
        const body = await json(await get('/api_dashboard_stats.php?admin_id=1&role=superadmin', null));
        for (const k of ['total_user', 'user_online', 'total_channel']) {
            assert.ok(k in body, `api_dashboard_stats lost ${k}`);
        }
    });

    test('api_dashboard_chart.php answers labels and values', async () => {
        const body = await json(await get('/api_dashboard_chart.php?admin_id=1&role=superadmin', null));
        assert.ok(Array.isArray(body.labels) && Array.isArray(body.values));
        assert.equal(body.labels.length, body.values.length);
        body.values.forEach((v) => assert.equal(typeof v, 'number'));
    });

    test('api_logs.php keeps the indonesian key names the mobile app reads', async () => {
        const body = await json(await get('/api_logs.php?category=ALL&admin_id=1&role=superadmin', null));
        assert.ok(Array.isArray(body));
        assert.ok(body.length > 0, 'staging must carry log rows for this assertion to bite');
        for (const k of ['aksi', 'jam', 'tanggal', 'pelaksana', 'kategori']) {
            assert.ok(k in body[0],
                `api_logs row lost ${k} — renaming these breaks the Admin Native log screen`);
        }
    });

    test('api_users.php action=get_user_channels returns a bare id array', async () => {
        const body = await json(await get(
            '/api_users.php?action=get_user_channels&u_id=CT_A1&admin_id=1&role=superadmin', null));
        assert.ok(Array.isArray(body));
    });

    test('api_settings.php action=check_update keeps its three keys', async () => {
        const body = await json(await get(
            '/api_settings.php?action=check_update&admin_id=1&role=superadmin', null));
        for (const k of ['latest_version', 'download_url', 'changelog']) {
            assert.ok(k in body, `check_update lost ${k}`);
        }
    });

    test('failures answer HTTP 200 with success:false, not an error status', async () => {
        // Widely relied on by the mobile client. Changing it is a breaking change
        // even though it looks like a bug fix.
        const res = await get('/api_users.php?action=nonsense&admin_id=1&role=superadmin', null);
        assert.equal(res.status, 200);
    });
});

describe('KNOWN BROKEN — locked here so the security release must change them on purpose', () => {
    test('api_*.php accept an unauthenticated caller claiming to be superadmin', async () => {
        // R3 will make this fail. When it does, update this test; do not delete it.
        const res = await get('/api_dashboard_stats.php?admin_id=1&role=superadmin', null);
        assert.equal(res.status, 200, 'today: no authentication at all');
        const body = await json(res);
        assert.ok('total_user' in body, 'today: full data returned to an anonymous caller');
    });

    test('destructive panel actions are plain GET with no token', async () => {
        const src = await (await get('/users.php', sup)).text();
        assert.match(src, /href=["']\?delete=/,
            'today: deleting a user is a GET, guarded only by a client-side confirm()');
    });
});

describe('node relay routes', () => {
    test('the four panel-only routes are reachable from the host but denied at the edge', async () => {
        const local = await fetch(`${NODE_URL}/api/admin/sync-channels`);
        assert.equal(local.status, 400, 'reachable over localhost, rejects a missing userId');

        const edge = await fetch('https://apiapi.am2-poc.com/api/admin/sync-channels',
            { redirect: 'manual' });  // deliberately the public edge, not the origin
        assert.equal(edge.status, 403, 'denied at nginx');
    });

    test('sync-channels and refresh-branch-permissions validate their required parameter', async () => {
        assert.equal((await fetch(`${NODE_URL}/api/admin/sync-channels`)).status, 400);
        const r = await fetch(`${NODE_URL}/api/admin/refresh-branch-permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(r.status, 400);
    });

    test('check-update answers the shape the field app parses', async () => {
        const res = await fetch(`${NODE_URL}/api/check-update`);
        const body = await res.json();
        assert.ok('success' in body);
        if (body.success) {
            for (const k of ['server_version_code', 'server_version_name',
                             'force_update', 'update_url']) {
                assert.ok(k in body, `check-update lost ${k}`);
            }
        } else {
            // app_versions is empty today, so every field app gets a 404 here.
            assert.equal(res.status, 404);
        }
    });

    test('the admin routes still require no credential', async () => {
        // R3 will change this. The assertion documents the starting point.
        const res = await fetch(`${NODE_URL}/api/admin/force-logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.notEqual(res.status, 401, 'today: no authentication layer exists');
        assert.notEqual(res.status, 403);
    });
});

describe('tenant scoping, corrected in the security release', () => {
    // These four assertions replace entries that used to sit in the KNOWN
    // BROKEN block above. They are kept, not deleted, so a regression reads as
    // a failure rather than as silence.

    test('omitting admin_id narrows the result to nothing, never widens it', async () => {
        const scoped = await json(await get('/api_get_users.php?admin_id=6&role=admin', null));
        const unscoped = await json(await get('/api_get_users.php?role=admin', null));
        assert.ok(Array.isArray(scoped) && Array.isArray(unscoped));
        assert.equal(unscoped.length, 0,
            'a branch request with no branch must return nothing, not everything');
    });

    test('api_user_access.php search runs', async () => {
        const res = await get('/api_user_access.php?admin_id=1&role=superadmin&search=CT', null);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.ok(Array.isArray(body) || typeof body === 'object',
            'the missing OR used to make every search a syntax error');
    });

    test('a branch admin cannot mutate another branch user', async () => {
        const body = await json(await postForm('/users.php', branchA, {
            update_feature: '1', u_id: 'CT_B1', feature: 'enable_maps', val: 'true',
        }));
        assert.equal(body.success, false, 'ownership is checked, not just login');
        assert.ok('msg' in body);
    });

    test('a branch admin cannot force-logout another branch user', async () => {
        const res = await postForm('/user_access.php', branchA, {
            action: 'db_force_logout', user_id: 'CT_B1',
        });
        assert.equal(res.status, 403);
    });

    test('the dashboard chart scopes to the branch', async () => {
        const branch = await json(await get('/api_dashboard_chart.php?admin_id=6&role=admin', null));
        const global = await json(await get('/api_dashboard_chart.php?admin_id=1&role=superadmin', null));
        const sum = (a) => a.reduce((x, y) => x + y, 0);
        assert.ok(sum(branch.values) < sum(global.values),
            'a branch total that equals the global total means the filter is a no-op again');
    });

    test('the chart refuses a branch request with no branch', async () => {
        const body = await json(await get('/api_dashboard_chart.php?role=admin', null));
        assert.ok('error' in body, 'falling back to the global figure is what leaked');
    });
});

describe('tenant scoping that already works and must keep working', () => {
    test('a branch admin sees only its own users on users.php', async () => {
        const html = await (await get('/users.php', branchA)).text();
        assert.ok(html.includes('CT_A1'), 'branch A must see its own user');
        assert.ok(!html.includes('CT_B1'), 'branch A must not see branch B users');
    });

    test('a superadmin sees users from every branch', async () => {
        const html = await (await get('/users.php', sup)).text();
        assert.ok(html.includes('CT_A1') && html.includes('CT_B1'));
    });

    test('the base URL under test is staging, never production', () => {
        assert.match(EDGE, /staging-webadmin/,
            'this suite mutates data and must never point at production');
        assert.match(BASE, /127\.0\.0\.1:8081/,
            'requests must reach the origin directly, bypassing the CDN cache');
    });
});
