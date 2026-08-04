// The panel pages that are also JSON endpoints.
//
// These are the easiest thing to lose in a redesign, because they live inside
// files that look like pure views. Each one dispatches on a request parameter
// before any HTML is emitted.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, asBranchA, get, postForm, json , ctChannelId} from './helpers.mjs';

// This file owns CT_A3. It used to write CT_A1, which channel-access.test.mjs
// seeds and asserts on -- the two ran concurrently and the cross-tenant
// assertion failed on membership this file had rewritten underneath it.
//
// The same mistake, one level up: it owned the unit but shared ct_channel_a
// with channel-access.test.mjs, which empties that channel's roster to prove
// that emptying it works. As superadmin that removes every member, including
// the one this file had just put there -- so "save_user_channels then read it
// back" came back empty roughly one run in eight. The channel is owned now
// too.
const PANEL_UNIT = 'CT_A3';
const PANEL_CHANNEL = ctChannelId('ct_channel_a3');

let sup, branchA;
before(async () => {
    sup = await asSuper();
    branchA = await asBranchA();
});

describe('users.php hidden JSON endpoints', () => {
    test('GET ?get_user_channels=1&u_id= returns a bare array of channel ids', async () => {
        const res = await get(`/users.php?get_user_channels=1&u_id=${PANEL_UNIT}`, sup);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /application\/json/);
        const body = await json(res);
        assert.ok(Array.isArray(body), 'must be a bare array, not an envelope');
        body.forEach((v) => assert.equal(typeof v, 'number'));
    });

    test('POST update_feature answers {success} and uses msg (not message) on failure', async () => {
        const ok = await json(await postForm('/users.php', sup, {
            update_feature: '1', u_id: PANEL_UNIT, feature: 'enable_maps', val: 'true',
        }));
        assert.equal(ok.success, true);

        // Restore, so the suite is repeatable.
        await postForm('/users.php', sup, {
            update_feature: '1', u_id: PANEL_UNIT, feature: 'enable_maps', val: 'false',
        });

        const bad = await json(await postForm('/users.php', sup, {
            update_feature: '1', u_id: PANEL_UNIT, feature: 'not_a_feature', val: 'true',
        }));
        assert.equal(bad.success, false);
        assert.ok('msg' in bad, 'users.php uses msg; every api_*.php uses message');
        assert.ok(!('message' in bad));
    });

    test('POST update_feature accepts exactly four feature names', async () => {
        for (const feature of ['enable_maps', 'enable_p2p', 'enable_ptt_video']) {
            const r = await json(await postForm('/users.php', sup, {
                update_feature: '1', u_id: PANEL_UNIT, feature, val: 'false',
            }));
            assert.equal(r.success, true, `${feature} must be accepted`);
        }
        const duplex = await json(await postForm('/users.php', sup, {
            update_feature: '1', u_id: PANEL_UNIT, feature: 'duplex_mode', val: 'HALF DUPLEX',
        }));
        assert.equal(duplex.success, true);
    });

    test('POST save_user_channels takes a JSON string and makes the first entry default', async () => {
        const chans = await json(await get(`/channels.php?ajax_action=get_channel_users&channel_id=${PANEL_CHANNEL}`, sup));
        assert.ok(Array.isArray(chans));

        const res = await json(await postForm('/users.php', sup, {
            save_user_channels: '1', u_id: PANEL_UNIT, channels: JSON.stringify([PANEL_CHANNEL]),
        }));
        assert.equal(res.success, true);

        const after = await json(await get(`/users.php?get_user_channels=1&u_id=${PANEL_UNIT}`, sup));
        assert.deepEqual(after, [Number(PANEL_CHANNEL)]);

        // Empty list is a valid input meaning "revoke everything".
        const cleared = await json(await postForm('/users.php', sup, {
            save_user_channels: '1', u_id: PANEL_UNIT, channels: JSON.stringify([]),
        }));
        assert.equal(cleared.success, true);
        assert.deepEqual(await json(await get(`/users.php?get_user_channels=1&u_id=${PANEL_UNIT}`, sup)), []);
    });
});

describe('channels.php hidden JSON endpoint', () => {
    test('GET ?ajax_action=get_channel_users returns a bare array of user ids', async () => {
        const res = await get(`/channels.php?ajax_action=get_channel_users&channel_id=${PANEL_CHANNEL}`, sup);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.ok(Array.isArray(body), 'must be a bare array');
    });
});

describe('user_access.php force logout', () => {
    test('POST action=db_force_logout answers {success:true}', async () => {
        const res = await postForm('/user_access.php', sup, {
            action: 'db_force_logout', user_id: 'CT_A1',
        });
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.success, true);
    });

    test('the endpoint is the current URL, so a search query must survive', async () => {
        // The page posts to window.location.href, so ?search= rides along.
        const { BASE, HOST, csrfToken } = await import('./helpers.mjs');
        const res = await fetch(
            `${BASE}/user_access.php?search=CT`,
            {
                method: 'POST', redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                           Host: HOST, Cookie: sup },
                body: new URLSearchParams({
                    action: 'db_force_logout', user_id: 'CT_A1',
                    _csrf: await csrfToken(sup),
                }),
            }
        );
        assert.equal((await json(res)).success, true);
    });
});

describe('session guards on the AJAX endpoints', () => {
    test('fetch_logs.php returns the two-array envelope for a session', async () => {
        const body = await json(await get('/fetch_logs.php', sup));
        assert.ok(Array.isArray(body.ptt) && Array.isArray(body.adm),
            'shape is {ptt:[], adm:[]}');
        // Not conditional on there being rows: an empty result would silently
        // skip every key assertion and report green.
        assert.ok(body.ptt.length > 0, 'staging must carry ptt_logs rows for this to mean anything');
        for (const k of ['id', 'aksi', 'jam', 'tanggal', 'raw_time', 'target',
                         'pelaksana', 'pelaksana_id', 'kategori']) {
            assert.ok(k in body.ptt[0], `fetch_logs row must keep the key ${k}`);
        }
    });

    test('fetch_logs.php refuses an anonymous caller', async () => {
        const body = await json(await get('/fetch_logs.php', null));
        assert.ok('error' in body);
    });

    test('get-users-ajax.php returns a bare array and 401s anonymously', async () => {
        const ok = await get('/get-users-ajax.php', sup);
        assert.equal(ok.status, 200);
        assert.ok(Array.isArray(await json(ok)));

        const anon = await get('/get-users-ajax.php', null);
        assert.equal(anon.status, 401);
    });

    test('page requests without a session redirect to login', async () => {
        for (const p of ['/dashboard.php', '/users.php', '/channels.php',
                         '/logs.php', '/settings.php', '/user_access.php', '/livetrack.php']) {
            const res = await get(p, null);
            assert.equal(res.status, 302, `${p} must redirect`);
            assert.match(res.headers.get('location'), /login\.php/);
        }
    });

    test('admin_panel.php sends a branch admin to the dashboard, not the login page', async () => {
        const res = await get('/admin_panel.php', branchA);
        assert.equal(res.status, 302);
        assert.match(res.headers.get('location'), /dashboard\.php/);
    });
});
