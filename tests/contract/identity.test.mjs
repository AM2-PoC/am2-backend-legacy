// Who the server thinks the caller is.
//
// Every api_*.php file used to take `admin_id` and `role` off the request.
// That is the Admin Native contract, but it also meant a branch admin holding
// a perfectly ordinary panel session could append `&role=superadmin` and act
// as one. These tests pin the rule that closed it: a session states nothing
// about itself, only a key-bearing caller may.
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { BASE, HOST, asSuper, asBranchA, get, postForm, json, sql,
         ctAdminId, adminPasswordHash, restoreAdminPasswordHash } from './helpers.mjs';

// Run this file against a build where the hole is still open and the escalation
// probe succeeds -- an actual superadmin account, with a password written in
// this file, left behind on the host. It happened once. Never leave it there.
after(() => {
    sql("DELETE FROM public.admin WHERE username = 'ct_escalation_probe'");
});

/** A branch session, with an escalation attempt bolted on. */
// Resolved rather than literal, so this can never name a real row.
const CLAIM = () => `admin_id=${ctAdminId('ct_super')}&role=superadmin`;

describe('identity is the server\'s to decide', () => {
    test('a branch session cannot export the database by claiming superadmin', async () => {
        const cookie = await asBranchA();
        const res = await get(`/api_settings.php?action=export_db&${CLAIM()}`, cookie);

        assert.strictEqual(res.status, 403, 'export_db must refuse a branch admin');
        const body = await res.text();
        assert.ok(!/CREATE TABLE|PostgreSQL database dump/i.test(body),
            'no part of a dump may reach a branch admin');
    });

    test('a branch session cannot reach the admin panel by claiming superadmin', async () => {
        const cookie = await asBranchA();
        const res = await get(`/api_admin_panel.php?${CLAIM()}`, cookie);
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
        // The target is resolved from the fixture, never hardcoded. This probe
        // used to send admin_id=1, which on staging is the real superadmin --
        // and when it was run against a build without the guard, it changed
        // that account's password. The assertion could not prevent it: by then
        // the request had already been served.
        const target = ctAdminId('ct_super');
        const before = adminPasswordHash('ct_super');
        const cookie = await asBranchA();
        try {
            const res = await postForm('/api_settings.php', cookie, {
                action: 'update_password',
                admin_id: String(target),
                new_password: 'probe-should-never-apply',
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(adminPasswordHash('ct_super'), before,
                'the hash changed, so the request was served');
        } finally {
            // Unconditional: if the guard ever regresses, the fixture is still
            // repaired and the next run can sign in.
            restoreAdminPasswordHash('ct_super', before);
        }
    });

    // Sandwiched between two honest calls: other files in the suite edit this
    // tenant's memberships while this runs, so a plain before/after comparison
    // fails on a data change rather than on the thing being tested.
    async function chartUnaffectedBy(query) {
        const cookie = await asBranchA();
        const before = await json(await get('/api_dashboard_chart.php', cookie));
        const claimed = await json(await get(`/api_dashboard_chart.php?${query}`, cookie));
        const after = await json(await get('/api_dashboard_chart.php', cookie));

        const c = JSON.stringify(claimed);
        assert.ok(c === JSON.stringify(before) || c === JSON.stringify(after),
            `appending ${query} must make no difference to a session caller`);
    }

    test('the chart ignores a claimed identity and answers for the session', async () => {
        await chartUnaffectedBy(CLAIM());
    });

    test('a superadmin session still reaches the admin panel', async () => {
        const cookie = await asSuper();
        const res = await get('/api_admin_panel.php', cookie);
        assert.strictEqual(res.status, 200, 'the gate must not lock out the people who need it');
        const body = await json(res);
        assert.ok(Array.isArray(body) || typeof body === 'object');
    });

    test('a superadmin session keeps its own identity, not a claimed one', async () => {
        // The fields are ignored in both directions: claiming to be a branch
        // admin must not narrow a superadmin's view either.
        const cookie = await asSuper();
        const before = await json(await get('/api_dashboard_chart.php', cookie));
        const claimed = await json(
            await get('/api_dashboard_chart.php?admin_id=99999&role=admin', cookie));
        const after = await json(await get('/api_dashboard_chart.php', cookie));

        const c = JSON.stringify(claimed);
        assert.ok(c === JSON.stringify(before) || c === JSON.stringify(after));
    });
});

describe('CLOSED — an anonymous caller states nothing', () => {
    // This block was headed KNOWN OPEN and asserted the hole: with no session
    // and no key, a caller stated its own role and was served, because that is
    // what Admin Native did. It carried the instruction "do not delete it --
    // change it", and this is the change. The app has held a session since
    // build 83, identity now comes only from that session, and there is no
    // longer a setting under which the permissive branch can be reached.
    test('an anonymous caller claiming superadmin is refused', async () => {
        const res = await fetch(`${BASE}/api_admin_panel.php?${CLAIM()}`, {
            headers: { Host: HOST, Accept: 'application/json' },
        });
        assert.strictEqual(res.status, 401,
            'an unauthenticated caller is still served');
    });
});
