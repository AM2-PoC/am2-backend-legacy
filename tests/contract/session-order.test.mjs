// Expiry has to happen before authorization, not after it.
//
// Pages included auth.php first and config.php second, but idle expiry lives
// in config.php. So the first request after a timeout passed the guard, had
// its session destroyed, and ran the handler anyway with no identity.
// am2_csrf_require() does not catch that either -- it returns early when the
// session is not logged in -- so a POST arriving after the timeout was
// executed with a null admin id.
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { asBranchA, get, postForm, sql, sqlOne, csrfToken } from './helpers.mjs';
import { execFileSync } from 'node:child_process';

// The staging lane's own store. Both lanes shared /var/lib/php/sessions until
// 2026-09-04, which meant a staging session was accepted by production; each
// vhost now pins its own save_path. This test backdates a session file by hand,
// so it has to look where the lane it is testing actually writes.
const SESSION_DIR = process.env.CT_SESSION_DIR || '/var/lib/php/sessions/am2-staging';
const UNIT = 'CT_A2';

const sid = (cookie) => cookie.split('=')[1];

/** Backdate last_seen so the next request looks idle past the cutoff. */
function ageSession(cookie, seconds = 60 * 60 * 24) {
    const file = `${SESSION_DIR}/sess_${sid(cookie)}`;
    const old = Math.floor(Date.now() / 1000) - seconds;
    // sed in place as www-data's file owner; the test runs as am2deploy.
    execFileSync('sudo', [
        'sed', '-i', '-E', `s/last_seen\\|i:[0-9]+;/last_seen|i:${old};/`, file,
    ]);
    const after = execFileSync('sudo', ['cat', file], { encoding: 'utf8' });
    assert.ok(after.includes(`last_seen|i:${old};`),
        'the session file was not backdated, so this test would prove nothing');
}

let cookie;

before(async () => {
    cookie = await asBranchA();
    // One request so config.php writes last_seen into the session file.
    await get('/dashboard.php', cookie);
});

describe('the first request after an idle timeout runs nothing', () => {
    test('a page request is sent to the login screen, not rendered', async () => {
        const fresh = await asBranchA();
        await get('/dashboard.php', fresh);
        ageSession(fresh);

        const res = await get('/dashboard.php', fresh);
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.get('location') || '', /login\.php/);
    });

    test('an expired session is told so, rather than sent a login page as JSON', async () => {
        const fresh = await asBranchA();
        await get('/dashboard.php', fresh);
        ageSession(fresh);

        const res = await get('/dashboard.php', fresh, {
            headers: { Host: 'staging-webadmin.am2-poc.com', Cookie: fresh, Accept: 'application/json' },
        });
        assert.strictEqual(res.status, 401, 'a fetch() caller needs a status it can act on');
        const body = await res.json();
        // 401 covers both cases; `code` is what tells "timed out" from
        // "never signed in", so a tab can say the right thing.
        assert.strictEqual(body.code, 'session_expired');
    });

    test('a mutation arriving after the timeout does not reach the database', async () => {
        const fresh = await asBranchA();
        await get('/dashboard.php', fresh);
        // Take the token while the session is still alive, exactly as a tab
        // left open overnight would have.
        const chA = sqlOne("SELECT id FROM public.channels WHERE name = 'ct_channel_a'")[0];
        sql(`DELETE FROM public.user_channels WHERE user_id = '${UNIT}'`);
        sql(`UPDATE public.users SET last_channel_id = NULL WHERE id = '${UNIT}'`);

        // Read the token before the session dies, which is the whole scenario:
        // a page rendered last night, submitted this morning.
        const token = await csrfToken(fresh);
        ageSession(fresh);

        await postForm('/user_access.php', fresh, {
            update_multi_access: '1', user_id: UNIT, 'channels[]': [chA],
            default_channel: chA, _csrf: token,
        });

        const rows = sql(`SELECT channel_id FROM public.user_channels WHERE user_id = '${UNIT}'`);
        assert.strictEqual(rows.length, 0,
            'the handler ran on a session that had already expired');
    });
});
