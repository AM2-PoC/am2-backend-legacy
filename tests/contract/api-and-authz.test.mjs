// The api_*.php layer and the authorization behaviour of the whole panel.
//
// The second describe block used to be headed KNOWN BROKEN and recorded
// behaviour that was wrong: an anonymous caller naming its own admin_id and
// role was served. It carried the instruction that the security release had to
// change it deliberately. This is that change -- made after the hole was
// exploited on production on 2026-09-04, which is a more expensive way to
// learn that a test recording a hole is not the same as a test closing one.
//
// Every call here now carries a session, because there is no other way in.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
    asSuper, asBranchA, get, postForm, json, sqlOne, ctAdminId, BASE, EDGE, HOST, NODE_URL,
} from './helpers.mjs';

let sup, branchA;
before(async () => { sup = await asSuper(); branchA = await asBranchA(); });

describe('api_*.php response contracts (consumed by the Admin Native app)', () => {
    test('api_login.php returns credentials, not a session or a token', async () => {
        const body = await json(await postForm('/api_login.php', null, {
            username: 'nobody_at_all', password: 'wrong',
        }));
        assert.equal(body.success, false);
        assert.ok('message' in body, 'api_*.php uses message, unlike users.php which uses msg');

        // A failed sign-in must hand out nothing at all -- no session, no
        // token. This is the request that was answered 401 at 11:30:54 on
        // 2026-09-04, five minutes before the operator whose login had just
        // failed deleted an admin account through an endpoint that served him
        // anyway.
        const res = await postForm('/api_login.php', null, {
            username: 'nobody_at_all', password: 'wrong',
        });
        assert.equal(res.status, 401, 'a refused sign-in must say so in the status');
        const cookies = res.headers.getSetCookie?.() ?? [];
        assert.ok(!cookies.some((c) => /token|jwt|bearer/i.test(c)),
            'a token is issued to a caller who failed to sign in');
    });

    test('api_dashboard_stats.php keeps its key names', async () => {
        const body = await json(await get('/api_dashboard_stats.php?admin_id=1&role=superadmin', sup));
        for (const k of ['total_user', 'user_online', 'total_channel']) {
            assert.ok(k in body, `api_dashboard_stats lost ${k}`);
        }
    });

    test('api_dashboard_chart.php answers labels and values', async () => {
        const body = await json(await get('/api_dashboard_chart.php?admin_id=1&role=superadmin', sup));
        assert.ok(Array.isArray(body.labels) && Array.isArray(body.values));
        assert.equal(body.labels.length, body.values.length);
        body.values.forEach((v) => assert.equal(typeof v, 'number'));
    });

    test('api_logs.php keeps the indonesian key names the mobile app reads', async () => {
        const body = await json(await get('/api_logs.php?category=ALL&admin_id=1&role=superadmin', sup));
        assert.ok(Array.isArray(body));
        assert.ok(body.length > 0, 'staging must carry log rows for this assertion to bite');
        for (const k of ['aksi', 'jam', 'tanggal', 'pelaksana', 'kategori']) {
            assert.ok(k in body[0],
                `api_logs row lost ${k} — renaming these breaks the Admin Native log screen`);
        }
    });

    test('api_users.php action=get_user_channels returns a bare id array', async () => {
        const body = await json(await get(
            '/api_users.php?action=get_user_channels&u_id=CT_A1&admin_id=1&role=superadmin', sup));
        assert.ok(Array.isArray(body));
    });

    test('api_settings.php action=check_update keeps its three keys', async () => {
        const body = await json(await get(
            '/api_settings.php?action=check_update&admin_id=1&role=superadmin', sup));
        for (const k of ['latest_version', 'download_url', 'changelog']) {
            assert.ok(k in body, `check_update lost ${k}`);
        }
    });

    test('failures answer HTTP 200 with success:false, not an error status', async () => {
        // Widely relied on by the mobile client. Changing it is a breaking change
        // even though it looks like a bug fix.
        const res = await get('/api_users.php?action=nonsense&admin_id=1&role=superadmin', sup);
        assert.equal(res.status, 200);
    });
});

describe('CLOSED — the hole that was exploited on 2026-09-04', () => {
    test('an anonymous caller claiming superadmin is refused', async () => {
        /*
         * This test used to assert status 200 and a full body, under the
         * heading KNOWN BROKEN, with the note "tightening the API credential
         * will make this fail; when it does, update this test".
         *
         * It was not tightened in time. At 11:35:58 on 2026-09-04 a caller in
         * exactly this position -- no session, no key, naming its own role --
         * was answered 200 by api_admin_panel.php and deleted an admin row,
         * which cascaded to 186 units, 191 channel memberships and 114,514 log
         * rows.
         */
        const res = await get('/api_dashboard_stats.php?admin_id=1&role=superadmin', null);
        assert.equal(res.status, 401, 'an unauthenticated caller is still served');
    });

    test('the endpoint that was used is refused too', async () => {
        // Named separately from the one above: this is the specific URL that
        // did the damage, and a regression here has a body count.
        const res = await fetch(`${BASE}/api_admin_panel.php`, {
            method: 'POST', redirect: 'manual',
            headers: { Host: HOST, Accept: 'application/json',
                       'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'action=delete&id=4',
        });
        assert.equal(res.status, 401);
    });

    test('a session cannot widen its own scope by naming another admin', async () => {
        // The other half of the same defect: identity used to be whatever the
        // request said whenever the session did not object. A branch session
        // asking as the superadmin must still answer as the branch.
        const claimed = await json(
            await get(`/api_dashboard_chart.php?admin_id=${ctAdminId('ct_super')}&role=superadmin`, branchA));
        const honest = await json(await get('/api_dashboard_chart.php', branchA));
        assert.deepEqual(claimed.values, honest.values,
            'naming another admin in the query string changed the answer');
    });
});

describe('node relay routes', () => {
    test('the four panel-only routes are gated at the relay and at the edge', async () => {
        // This asserted 400 from localhost, back when the routes took anyone's
        // word for it and only a missing userId could stop them. They are now
        // behind a key, so an unauthenticated call is refused before any
        // parameter is looked at -- which is the right order: a caller with no
        // credential learns nothing about the shape of the request.
        const local = await fetch(`${NODE_URL}/api/admin/sync-channels`);
        assert.equal(local.status, 401, 'the relay accepted an unauthenticated admin call');

        const edge = await fetch('https://apiapi.am2-poc.com/api/admin/sync-channels',
            { redirect: 'manual' });  // deliberately the public edge, not the origin
        assert.equal(edge.status, 403, 'denied at nginx');
    });

    test('authentication is decided before the parameters are', async () => {
        // Both routes used to answer 400 for a missing parameter. Behind the
        // key the answer is 401 and the body says only "Unauthorized": the
        // parameter check is real and still there, but it is not reachable
        // without a credential, so it cannot be used to probe the API's shape.
        assert.equal((await fetch(`${NODE_URL}/api/admin/sync-channels`)).status, 401);
        const r = await fetch(`${NODE_URL}/api/admin/refresh-branch-permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(r.status, 401);
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

    test('the admin routes require a credential', async () => {
        // This asserted the opposite, with a note that tightening the API
        // credential would change it. It did: ten routes were reachable from
        // the internet with no credential, six of them uncalled and now gone,
        // and a key gates the four that remain. The assertion is inverted
        // rather than deleted so a regression to the open state fails loudly.
        const res = await fetch(`${NODE_URL}/api/admin/force-logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 401, 'an admin route ran without a credential');
        assert.notEqual(res.status, 403);
    });
});

describe('tenant scoping, corrected in the security release', () => {
    // These four assertions replace entries that used to sit in the KNOWN
    // BROKEN block above. They are kept, not deleted, so a regression reads as
    // a failure rather than as silence.

    test('the roster is scoped by the session, not by the query string', async () => {
        // Was: "omitting admin_id narrows to nothing". admin_id is no longer
        // read at all, so the property worth asserting is the stronger one --
        // what the caller writes in the URL cannot change what it sees.
        const honest = await json(await get('/api_get_users.php', branchA));
        const greedy = await json(await get('/api_get_users.php?admin_id=1&role=superadmin', branchA));
        assert.ok(Array.isArray(honest) && Array.isArray(greedy));
        assert.equal(greedy.length, honest.length,
            'claiming another admin in the URL widened the roster');
    });

    test('api_user_access.php search runs', async () => {
        const res = await get('/api_user_access.php?admin_id=1&role=superadmin&search=CT', sup);
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
        /*
         * This used to assert branch < global, which says "some other branch
         * must also be busy" rather than "the filter works". It went red the
         * day ct_branch_a happened to own every event in the window: 430 out
         * of 430, filter working perfectly, test failing.
         *
         * The property is that each answer matches what the database holds for
         * that scope. A small tolerance covers rows arriving between the two
         * reads -- staging takes real traffic, and the alternative is a test
         * that fails whenever a unit keys the mic at the wrong moment.
         */
        const branchId = ctAdminId('ct_branch_a');
        // Scope now follows the session, so the two answers come from two
        // sessions rather than from two different query strings.
        const branch = await json(await get('/api_dashboard_chart.php', branchA));
        const global = await json(await get('/api_dashboard_chart.php', sup));

        const sum = (a) => a.reduce((x, y) => x + y, 0);
        // event_time is a timestamp without a zone, and the endpoint reads it
        // with the session set to Jakarta. psql here has its own session, so
        // the zone is written into the expression rather than the session --
        // a SET in the same -c returns its own command tag and broke the parse.
        const count = (where) => Number(sqlOne(
            `SELECT COUNT(*) FROM public.ptt_logs l
              WHERE l.event_time > (NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '24 hours'
              ${where}`)[0]);

        const expectedBranch = count(
            `AND l.user_id IN (SELECT id FROM public.users WHERE admin_id = ${branchId})`);
        const expectedGlobal = count('');

        assert.ok(Math.abs(sum(branch.values) - expectedBranch) <= 5,
            `branch chart says ${sum(branch.values)}, the branch's own rows are ${expectedBranch}`);
        assert.ok(Math.abs(sum(global.values) - expectedGlobal) <= 5,
            `global chart says ${sum(global.values)}, every row is ${expectedGlobal}`);
        assert.ok(sum(branch.values) <= sum(global.values),
            'a branch cannot hold more events than exist');
    });

    test('the chart refuses a caller with no session at all', async () => {
        // Was: "a branch request with no branch falls back to the global
        // figure, and that is the leak". There is no such request any more --
        // a caller without a session never reaches the query.
        const res = await get('/api_dashboard_chart.php?role=admin', null);
        assert.equal(res.status, 401, 'falling back to the global figure is what leaked');
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
