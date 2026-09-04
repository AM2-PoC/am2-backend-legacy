import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { asSuper, json, postForm, sql, sqlOne } from './helpers.mjs';

const ADMIN = 'ct_delete_admin';
const USER = 'ct_delete_admin_user';
let adminId;

function cleanup() {
    sql(`DELETE FROM public.users WHERE id = '${USER}'`);
    sql(`DELETE FROM public.admin WHERE username = '${ADMIN}'`);
}

before(() => {
    cleanup();
    sql(`INSERT INTO public.admin
            (username, password_hash, role, status, user_quota, channel_quota,
             can_manage_maps, can_manage_p2p, can_manage_video)
         VALUES ('${ADMIN}', 'not-used', 'admin', 'active', 1, 1, false, false, false)`);
    adminId = sqlOne(`SELECT id FROM public.admin WHERE username = '${ADMIN}'`)[0];
    sql(`INSERT INTO public.users
            (id, name, password, role, admin_id, created_by, status, entity_type)
         VALUES ('${USER}', 'Delete admin fixture', 'not-used', 'user',
                 ${adminId}, ${adminId}, 'offline', 'user')`);
});

after(cleanup);

test('deleting an admin that still owns units is refused, and the units stay', async () => {
    /*
     * This test used to be called "deleting an admin with owned users succeeds
     * and removes its users", and it asserted exactly that: the admin gone, the
     * unit gone with it. It was describing ON DELETE CASCADE as the contract.
     *
     * On 2026-09-04 at 11:35:58 that contract was honoured. One POST deleted
     * admin id 4 and took 186 units, 191 channel memberships, 186 permission
     * rows and 114,514 log rows with it, in a single statement, with no
     * confirmation and no count. Migration 006 changed the foreign key to
     * RESTRICT; am2_admin_undeletable() says so in words before the query runs.
     *
     * The unit surviving is the assertion that matters. A refusal that still
     * deleted something would be worse than no refusal at all.
     */
    const cookie = await asSuper();
    const res = await postForm('/admin_panel.php', cookie, {
        delete_admin_id: adminId,
        ajax: '1',
    });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, false, 'the deletion was allowed to proceed');
    assert.match(String(body.msg ?? ''), /1/,
        `the refusal does not say how many units are in the way: ${JSON.stringify(body)}`);
    assert.notEqual(sqlOne(`SELECT id FROM public.admin WHERE id = ${adminId}`), null,
        'the admin was deleted anyway');
    assert.notEqual(sqlOne(`SELECT id FROM public.users WHERE id = '${USER}'`), null,
        'the unit was deleted anyway');
});

test('an admin that owns nothing can still be deleted', async () => {
    // RESTRICT must not turn into "admins are permanent". The deliberate path
    // is: move or remove the units, then remove the admin.
    sql(`DELETE FROM public.users WHERE id = '${USER}'`);
    const cookie = await asSuper();
    const res = await postForm('/admin_panel.php', cookie, {
        delete_admin_id: adminId,
        ajax: '1',
    });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.deepEqual(body, { success: true });
    assert.equal(sqlOne(`SELECT id FROM public.admin WHERE id = ${adminId}`), null);
});
