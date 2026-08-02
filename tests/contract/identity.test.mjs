// Who the server thinks the caller is.
//
// Every api_*.php file used to take `admin_id` and `role` off the request.
// That is the Admin Native contract, but it also meant a branch admin holding
// a perfectly ordinary panel session could append `&role=superadmin` and act
// as one. These tests pin the rule that closed it: a session states nothing
// about itself, only a key-bearing caller may.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { BASE, HOST, asSuper, asBranchA, get, postForm, json } from './helpers.mjs';

/** A branch session, with an escalation attempt bolted on. */
const CLAIM = 'admin_id=1&role=superadmin';

describe('identity is the server\'s to decide', () => {
    test('a branch session cannot export the database by claiming superadmin', async () => {
        const cookie = await asBranchA();
        const res = await get(`/api_settings.php?action=export_db&${CLAIM}`, cookie);

        assert.strictEqual(res.status, 403, 'export_db must refuse a branch admin');
        const body = await res.text();
        assert.ok(!/CREATE TABLE|PostgreSQL database dump/i.test(body),
            'no part of a dump may reach a branch admin');
    });

    test('a branch session cannot reach the admin panel by claiming superadmin', async () => {
        const cookie = await asBranchA();
        const res = await get(`/api_admin_panel.php?${CLAIM}`, cookie);
        assert.strictEqual(res.status, 403);
    });

    test('a branch session cannot create an admin by claiming superadmin', async () => {
        const cookie = await asBranchA();
        const res = await postForm('/api_admin_panel.php', cookie, {
            action: 'save', admin_id: '', username: 'ct_escalation_probe',
            password: 'probe-should-never-exist', role: 'superadmin',
        });
        assert.strictEqual(res.status, 403);
    });

    test('a branch session cannot reset another admin\'s password', async () => {
        const cookie = await asBranchA();
        // admin_id 1 is a superadmin on the fixture data; the caller is not it.
        const res = await postForm('/api_settings.php', cookie, {
            action: 'update_password', admin_id: '1', new_password: 'probe-should-never-apply',
        });
        assert.strictEqual(res.status, 403);
    });

    test('the chart ignores a claimed identity and answers for the session', async () => {
        const cookie = await asBranchA();
        const honest = await json(await get('/api_dashboard_chart.php', cookie));
        const claimed = await json(await get(`/api_dashboard_chart.php?${CLAIM}`, cookie));

        assert.deepStrictEqual(claimed, honest,
            'appending admin_id/role must make no difference to a session caller');
    });

    test('a superadmin session still reaches the admin panel', async () => {
        const cookie = await asSuper();
        const res = await get('/api_admin_panel.php', cookie);
        assert.strictEqual(res.status, 200, 'the gate must not lock out the people who need it');
        const body = await json(res);
        assert.ok(Array.isArray(body) || typeof body === 'object');
    });

    test('a superadmin session keeps its own identity, not a claimed one', async () => {
        const cookie = await asSuper();
        // Claiming to be a branch admin must not narrow a superadmin's view
        // either: the request fields are ignored in both directions.
        const honest = await json(await get('/api_dashboard_chart.php', cookie));
        const claimed = await json(await get('/api_dashboard_chart.php?admin_id=99999&role=admin', cookie));
        assert.deepStrictEqual(claimed, honest);
    });
});

describe('KNOWN OPEN — closes when AM2_API_AUTH_MODE=enforce', () => {
    // A caller with no session and no key still states its own role, because
    // that is exactly what Admin Native does today. The switch cannot be
    // thrown until the app ships a key; until then this test records the hole
    // rather than pretending it is shut. Do not delete it — change it.
    test('an anonymous caller can still claim superadmin while the mode is log', async () => {
        const res = await fetch(`${BASE}/api_admin_panel.php?${CLAIM}`, {
            headers: { Host: HOST },
        });
        const mode = (process.env.AM2_API_AUTH_MODE || 'log').toLowerCase();
        if (mode === 'enforce') {
            assert.ok(res.status === 401 || res.status === 403,
                'in enforce mode an anonymous caller must be refused');
        } else {
            assert.strictEqual(res.status, 200,
                'log mode is deliberately permissive; this is the gap R3 documented');
        }
    });
});
