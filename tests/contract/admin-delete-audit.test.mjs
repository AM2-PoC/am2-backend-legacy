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

test('deleting an admin with owned users succeeds and removes its users', async () => {
    const cookie = await asSuper();
    const res = await postForm('/admin_panel.php', cookie, {
        delete_admin_id: adminId,
        ajax: '1',
    });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.deepEqual(body, { success: true });
    assert.equal(sqlOne(`SELECT id FROM public.admin WHERE id = ${adminId}`), null);
    assert.equal(sqlOne(`SELECT id FROM public.users WHERE id = '${USER}'`), null);
});
