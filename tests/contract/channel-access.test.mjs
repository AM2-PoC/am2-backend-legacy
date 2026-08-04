// One contract for user-to-channel membership, whichever page writes it.
//
// Three pages used to write user_channels and all three disagreed. The Units
// page recreated every row as FULL DUPLEX, so a receive-only unit silently
// gained transmit rights; it also made whichever channel came first in the
// JSON the default and never touched users.last_channel_id. The Channels page
// recreated a whole roster with is_default = false, stripping the default from
// every unit on it. A unit whose last_channel_id names a channel it does not
// hold, or holds without a default, cannot sign in.
//
// These tests state the invariants rather than the implementation, so they
// keep their meaning if the service is rewritten.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { asBranchA, asSuper, postForm, sql, sqlOne } from './helpers.mjs';

const UNIT = 'CT_A1';
const OTHER_TENANT_UNIT = 'CT_B1';

const channelId = (name) => sqlOne(`SELECT id FROM public.channels WHERE name = '${name}'`)[0];

function membership(unit) {
    const rows = sql(
        `SELECT uc.channel_id, uc.permission, uc.is_default
           FROM public.user_channels uc WHERE uc.user_id = '${unit}'
          ORDER BY uc.channel_id`
    );
    return rows.map(([id, permission, isDefault]) => ({
        id, permission, isDefault: isDefault === 't',
    }));
}

// A sentinel rather than an empty string: psql prints null as a blank line and
// sql() drops blank lines, so an empty result would read as no row at all.
const NO_CHANNEL = '-';
const lastChannel = (unit) => sqlOne(
    `SELECT coalesce(last_channel_id::text, '${NO_CHANNEL}') FROM public.users WHERE id = '${unit}'`
)[0];

/** Every invariant a signed-in unit depends on, checked in one place. */
function assertConsistent(unit) {
    const rows = membership(unit);
    const last = lastChannel(unit);
    const defaults = rows.filter((r) => r.isDefault);

    if (rows.length === 0) {
        assert.strictEqual(last, NO_CHANNEL,
            `${unit} holds no channel, so last_channel_id must be null`);
        return;
    }
    assert.strictEqual(defaults.length, 1,
        `${unit} must have exactly one default, found ${defaults.length}`);
    assert.strictEqual(last, defaults[0].id,
        `${unit} last_channel_id must name its default channel`);
    assert.ok(rows.some((r) => r.id === last),
        `${unit} last_channel_id must name a channel it actually holds`);
}

let CH_A, CH_A2, CH_B, cookie;

before(async () => {
    CH_A = channelId('ct_channel_a');
    CH_A2 = channelId('ct_channel_a2');
    CH_B = channelId('ct_channel_b');
    cookie = await asBranchA();
});

after(() => {
    // Only the units this file touches. It used to clear CT_A2 as well, which
    // session-order.test.mjs is using -- the runner executes files in parallel,
    // so that cleanup was deleting rows out from under another file's
    // assertions. It failed roughly one run in ten and looked like a flake.
    sql(`DELETE FROM public.user_channels WHERE user_id IN ('CT_A1','CT_B1')`);
    sql(`UPDATE public.users SET last_channel_id = NULL WHERE id IN ('CT_A1','CT_B1')`);
});

/** Put the unit into a known state: two channels, A default, A2 receive-only. */
async function seed() {
    const res = await postForm('/user_access.php', cookie, {
        update_multi_access: '1',
        user_id: UNIT,
        'channels[]': [CH_A, CH_A2],
        default_channel: CH_A,
        [`permissions[${CH_A2}]`]: 'RX',
    });
    assert.ok(res.status < 400, `seed failed with ${res.status}`);
}

describe('membership invariants hold whichever page writes them', () => {
    test('the access page stores what it was told', async () => {
        await seed();
        const rows = membership(UNIT);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows.find((r) => r.id === CH_A2).permission, 'RX');
        assert.ok(rows.find((r) => r.id === CH_A).isDefault);
        assertConsistent(UNIT);
    });

    test('editing from the units page does not grant transmit to an RX channel', async () => {
        await seed();
        // The Units page sends a membership list and nothing more. Every
        // channel it keeps must keep the permission it already had.
        const res = await postForm('/users.php', cookie, {
            save_user_channels: '1',
            u_id: UNIT,
            channels: JSON.stringify([CH_A, CH_A2]),
        });
        assert.ok(res.status < 400);

        const a2 = membership(UNIT).find((r) => r.id === CH_A2);
        assert.strictEqual(a2.permission, 'RX',
            'a receive-only channel must not become transmit-capable by being re-saved');
        assertConsistent(UNIT);
    });

    test('editing from the units page does not move the default channel', async () => {
        await seed();
        // Reversed order on purpose: the old code made element zero the default.
        await postForm('/users.php', cookie, {
            save_user_channels: '1',
            u_id: UNIT,
            channels: JSON.stringify([CH_A2, CH_A]),
        });

        const def = membership(UNIT).find((r) => r.isDefault);
        assert.strictEqual(def.id, CH_A,
            'the default must survive a list the caller said nothing about');
        assertConsistent(UNIT);
    });

    test('revoking every channel clears last_channel_id rather than dangling', async () => {
        await seed();
        await postForm('/users.php', cookie, {
            save_user_channels: '1', u_id: UNIT, channels: JSON.stringify([]),
        });
        assert.strictEqual(membership(UNIT).length, 0);
        assertConsistent(UNIT);
    });

    test('editing a channel roster does not strip the default from its members', async () => {
        await seed();
        // CH_A is this unit's default. Re-saving the roster it is already on
        // used to rewrite every row with is_default = false.
        const res = await postForm('/channels.php', cookie, {
            save_channel_access: '1',
            manage_ch_id: CH_A,
            'users[]': [UNIT],
        });
        assert.ok(res.status < 400);

        const def = membership(UNIT).find((r) => r.isDefault);
        assert.ok(def, 'the unit must still have a default channel');
        assertConsistent(UNIT);
    });

    test('removing a unit from its default channel resettles it, not strands it', async () => {
        await seed();
        // Drop CT_A1 from CH_A, which is its default. It still holds CH_A2.
        await postForm('/channels.php', cookie, {
            save_channel_access: '1', manage_ch_id: CH_A, 'users[]': [],
        });

        const rows = membership(UNIT);
        assert.ok(!rows.some((r) => r.id === CH_A), 'it must actually be removed');
        assert.strictEqual(rows.length, 1);
        assertConsistent(UNIT);
    });
});

describe('a form is not an authorization', () => {
    test('a branch admin cannot set channels for another tenant\'s unit', async () => {
        const before = membership(OTHER_TENANT_UNIT);
        await postForm('/user_access.php', cookie, {
            update_multi_access: '1',
            user_id: OTHER_TENANT_UNIT,
            'channels[]': [CH_A],
            default_channel: CH_A,
        });
        // Reports both states on failure. This assertion has failed
        // intermittently, roughly one run in five; one cause was found and
        // fixed (a cleanup hook in this file clearing a unit another file was
        // using) and whatever remains has not reproduced since. Until it does,
        // the message has to carry enough to identify it.
        assert.deepStrictEqual(membership(OTHER_TENANT_UNIT), before,
            `another tenant's unit must be untouched. before=${JSON.stringify(before)} `
            + `after=${JSON.stringify(membership(OTHER_TENANT_UNIT))}`);
    });

    test('a branch admin cannot grant a channel it does not hold', async () => {
        await seed();
        const before = membership(UNIT);
        await postForm('/user_access.php', cookie, {
            update_multi_access: '1',
            user_id: UNIT,
            'channels[]': [CH_A, CH_B],
            default_channel: CH_A,
        });
        const after = membership(UNIT);
        assert.deepStrictEqual(after, before,
            `a channel belonging to another tenant must not be grantable. `
            + `CH_A=${CH_A} CH_A2=${CH_A2} CH_B=${CH_B} `
            + `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    });

    test('a branch admin cannot add another tenant\'s unit to a roster', async () => {
        const before = membership(OTHER_TENANT_UNIT);
        await postForm('/channels.php', cookie, {
            save_channel_access: '1', manage_ch_id: CH_A, 'users[]': [OTHER_TENANT_UNIT],
        });
        assert.deepStrictEqual(membership(OTHER_TENANT_UNIT), before);
    });

    test('a superadmin is still allowed to do all of it', async () => {
        const su = await asSuper();
        const res = await postForm('/user_access.php', su, {
            update_multi_access: '1',
            user_id: OTHER_TENANT_UNIT,
            'channels[]': [CH_B],
            default_channel: CH_B,
        });
        assert.ok(res.status < 400);
        assert.strictEqual(membership(OTHER_TENANT_UNIT).length, 1);
        assertConsistent(OTHER_TENANT_UNIT);
    });
});

/*
 * The same invariants, reached from the admin app.
 *
 * The three pages were made to agree; the three endpoints behind them were
 * not, and they are the copies that kept the original bugs. api_channels.php
 * wrote is_default='false' and 'FULL DUPLEX' for every member of a roster it
 * rebuilt, and api_users.php deleted every membership and recreated it with
 * the first entry as default. Both went through the shared writer afterwards;
 * these say so.
 */
describe('the admin app writes membership the same way the panel does', () => {
    const ADMIN = () => sqlOne("SELECT id FROM public.admin WHERE username = 'ct_branch_a'")[0];

    test('rebuilding a roster from the app keeps the default and the permission', async () => {
        await seed();   // CH_A default, CH_A2 receive-only

        // The app sends the whole roster of a channel, exactly as the panel's
        // access dialogue does.
        const res = await postForm(`/api_channels.php?admin_id=${ADMIN()}&role=admin`, null, {
            action: 'save_access', channel_id: CH_A, users: JSON.stringify([UNIT]),
        });
        assert.ok(res.status < 400, `save_access answered ${res.status}`);

        const rows = membership(UNIT);
        const onA = rows.find((r) => r.id === CH_A);
        assert.ok(onA, 'the unit was dropped from the channel it was being kept on');
        assert.ok(onA.isDefault,
            'rebuilding the roster cleared the default — the unit can no longer sign in');
        assert.strictEqual(rows.find((r) => r.id === CH_A2).permission, 'RX',
            'a receive-only channel elsewhere was rewritten to FULL DUPLEX');
        assertConsistent(UNIT);
    });

    test('saving a channel list from the app does not move where the unit comes up', async () => {
        await seed();   // CH_A default, CH_A2 receive-only

        // The same two channels, in the other order. Nothing about the request
        // says "make the first one default", and nothing should read it that way.
        const res = await postForm(`/api_users.php?admin_id=${ADMIN()}&role=admin`, null, {
            action: 'save_user_channels', u_id: UNIT, channels: JSON.stringify([CH_A2, CH_A]),
        });
        assert.ok(res.status < 400, `save_user_channels answered ${res.status}`);

        const rows = membership(UNIT);
        assert.strictEqual(rows.length, 2);
        assert.ok(rows.find((r) => r.id === CH_A).isDefault,
            'the default followed the order of the list instead of staying put');
        assert.strictEqual(rows.find((r) => r.id === CH_A2).permission, 'RX',
            'the receive-only permission was reset to FULL DUPLEX');
        assertConsistent(UNIT);
    });

    test('the app cannot put a unit on another tenant\'s channel', async () => {
        await seed();

        const res = await postForm(`/api_users.php?admin_id=${ADMIN()}&role=admin`, null, {
            action: 'save_user_channels', u_id: UNIT, channels: JSON.stringify([CH_B]),
        });
        const body = await res.json();
        assert.strictEqual(body.success, false,
            'branch A was allowed to grant its unit a branch B channel');
        assert.ok(!membership(UNIT).some((r) => r.id === CH_B));
    });
});
