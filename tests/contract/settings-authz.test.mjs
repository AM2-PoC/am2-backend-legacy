// settings.php runs two operations that reach past the caller's own tenant: a
// full pg_dump and a psql restore. api_settings.php guarded the restore with
// am2_api_require_super(); the page ran the identical shell pipe with no role
// check at all, so any branch admin could overwrite every branch's data.
//
// SAFETY. The probe uploads a file whose only statement writes a nonce into
// the `category` column of the fixture channel ct_channel_a, and the fixture is
// put back in a finally. Nothing outside the ct_ fixtures is named, so the file
// is harmless whether the guard holds or not -- the authorization failure is
// what is being measured, so it must not also be what keeps the probe safe.
//
// The first version of this test watched for a RESTORE row in ptt_logs instead.
// That row can never be written -- ptt_logs.user_id is a foreign key to
// users(id) -- so the assertion could not have failed no matter what the page
// did. A guard that cannot fail is decoration.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    asSuper, asBranchA, get, csrfToken, readSrc, sql, sqlOne, guardCtTarget, BASE, HOST,
} from './helpers.mjs';

const FIXTURE = 'ct_channel_a';
const NONCE = 'ct-probe-' + Date.now();

const categoryOf = (name) => {
    guardCtTarget(name);
    const row = sqlOne(`SELECT COALESCE(category, '') FROM public.channels WHERE name = '${name}'`);
    if (!row) throw new Error(`fixture channel ${name} is missing; run contract-test-fixtures.sh`);
    return row[0];
};

/** A statement whose entire reach is one fixture row. */
const probeSql = () => {
    guardCtTarget(FIXTURE);
    return `-- am2 contract probe\nUPDATE public.channels SET category = '${NONCE}' `
         + `WHERE name = '${FIXTURE}';\n`;
};

async function postRestore(cookie) {
    const body = new FormData();
    body.append('_csrf', await csrfToken(cookie));
    body.append('import_db', '1');
    body.append('sql_file', new Blob([probeSql()], { type: 'application/sql' }), 'ct-probe.sql');
    return fetch(`${BASE}/settings.php`, {
        method: 'POST', redirect: 'manual', headers: { Host: HOST, Cookie: cookie }, body,
    });
}

describe('settings.php restore is superadmin only', () => {
    let sup, branchA, original;

    before(async () => {
        sup = await asSuper();
        branchA = await asBranchA();
        original = categoryOf(FIXTURE);
    });

    after(() => {
        guardCtTarget(FIXTURE);
        sql(original === ''
            ? `UPDATE public.channels SET category = NULL WHERE name = '${FIXTURE}'`
            : `UPDATE public.channels SET category = '${original}' WHERE name = '${FIXTURE}'`);
    });

    test('a branch admin cannot run the restore', async () => {
        const html = await (await postRestore(branchA)).text();

        // The refusal is the assertion that was watched failing with the guard
        // removed, so it is the one carrying this test.
        //
        // The nonce below is a second line rather than the primary one: the
        // page discards shell_exec()'s result and reports success whether or
        // not psql applied anything, and the uploaded file was observed
        // applying on one run and not on another. Until the restore reports
        // its real outcome, an unchanged fixture does not prove psql was never
        // reached -- so this assertion can catch an execution but cannot be
        // trusted to.
        assert.notEqual(categoryOf(FIXTURE), NONCE,
            'a branch admin reached psql: the uploaded file was executed');
        assert.ok(!/pemulihan data selesai|restore has finished/i.test(html),
            'the page reported the restore as done');
        assert.match(html, /Akses ditolak|Access denied/,
            'the refusal must be visible, not silent');
    });

    test('a branch admin is not shown the restore control at all', async () => {
        const html = await (await get('/settings.php', branchA)).text();
        assert.ok(!html.includes('data-hs-overlay="#am2-restore"'),
            'the restore dialog is offered to an account that may not use it');
        assert.ok(!/name="import_db"/.test(html), 'the restore submit is rendered');
        assert.ok(!/name="apk_file"/.test(html), 'the APK upload is rendered');
    });

    test('a superadmin still has both, so the guard hid them from the right account', async () => {
        const html = await (await get('/settings.php', sup)).text();
        assert.ok(html.includes('data-hs-overlay="#am2-restore"'), 'the restore dialog is gone');
        assert.match(html, /name="import_db"/);
        assert.match(html, /name="apk_file"/);
        assert.match(html, /name="export_db"/);
    });

    test('both shell commands name the port', () => {
        // api_settings.php passed -p and the page did not, so the two halves of
        // one feature read whichever cluster answered on the default port.
        const src = readSrc('settings.php');
        for (const tool of ['pg_dump', 'psql']) {
            const line = src.split('\n').find((l) => l.includes(tool + ' -h'));
            assert.ok(line, `${tool} is no longer built here`);
            assert.match(line, /-p ' \. \$port/, `${tool} does not pass -p $port`);
        }
    });

    test('the restore does not log to a table that rejects it', () => {
        // ptt_logs.user_id is a foreign key to users(id) and channel_id to
        // channels(id): an admin username and channel 0 satisfy neither, so the
        // INSERT threw, was caught, and told the operator the restore had
        // failed after it had already overwritten the database.
        const src = readSrc('settings.php');
        assert.ok(!/INSERT INTO public\.ptt_logs/.test(src),
            'the restore writes an audit row that the schema cannot accept');
        assert.match(src, /error_log\(sprintf\(\s*\n?\s*'AM2 settings RESTORE/,
            'the restore must still leave a record somewhere that works');
    });
});
