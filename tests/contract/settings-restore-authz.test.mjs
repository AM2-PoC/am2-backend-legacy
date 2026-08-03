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
    asSuper, asBranchA, asBranchB, get, postForm, csrfToken, readSrc, sql, sqlOne,
    guardCtTarget, BASE, HOST,
} from './helpers.mjs';

const FIXTURE = 'ct_channel_a';
// channels.category is varchar(20), so the nonce has to fit in it.
const NONCE = ('ctp' + Date.now()).slice(0, 20);

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

        // Two independent ends. The fixture proves psql was never reached;
        // the refusal proves the operator was told why. Both were watched
        // failing with the guard removed.
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
            // The opening quote, so a mention of the tool in a comment is not
            // mistaken for the command. Each is assembled over several lines,
            // so the whole statement is what gets read.
            const i = src.indexOf(`'${tool}`);
            assert.ok(i > 0, `${tool} is no longer built here`);
            const stmt = src.slice(i, src.indexOf(';', i));
            assert.match(stmt, /-p ' \. \$port/, `${tool} does not pass -p $port`);
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

describe('settings.php restore reports what psql actually did', () => {
    // psql exits 0 even when every statement in the file was rejected, and the
    // page discarded the result, so a restore that changed nothing was shown
    // as done. Both halves are asserted here: a good file must apply, and a
    // file that breaks halfway must leave the database exactly as it was.
    //
    // SAFETY: every statement names the ct_channel_a fixture and the fixture is
    // put back in a finally. channels.category is varchar(20), which is what
    // makes a statement fail on demand without inventing anything.
    let sup, original;

    before(async () => { sup = await asSuper(); original = categoryOf(FIXTURE); });
    after(() => {
        guardCtTarget(FIXTURE);
        sql(original === ''
            ? `UPDATE public.channels SET category = NULL WHERE name = '${FIXTURE}'`
            : `UPDATE public.channels SET category = '${original}' WHERE name = '${FIXTURE}'`);
    });

    const runRestore = async (body_sql) => {
        const body = new FormData();
        body.append('_csrf', await csrfToken(sup));
        body.append('import_db', '1');
        body.append('sql_file', new Blob([body_sql], { type: 'application/sql' }), 'ct-probe.sql');
        return (await fetch(`${BASE}/settings.php`, {
            method: 'POST', redirect: 'manual', headers: { Host: HOST, Cookie: sup }, body,
        })).text();
    };

    test('a file that applies is reported as applied', async () => {
        guardCtTarget(FIXTURE);
        const html = await runRestore(
            `UPDATE public.channels SET category = 'ct-ok' WHERE name = '${FIXTURE}';\n`);
        assert.equal(categoryOf(FIXTURE), 'ct-ok', 'the statement did not run');
        assert.match(html, /Proses pemulihan data selesai/, 'a restore that worked was not reported');
    });

    test('a file that breaks halfway changes nothing and says why', async () => {
        guardCtTarget(FIXTURE);
        sql(`UPDATE public.channels SET category = 'ct-before' WHERE name = '${FIXTURE}'`);

        // The first statement is valid and the second is 26 characters into a
        // varchar(20). Without --single-transaction the first one sticks.
        const html = await runRestore(
            `UPDATE public.channels SET category = 'ct-first' WHERE name = '${FIXTURE}';\n`
            + `UPDATE public.channels SET category = 'ct-far-too-long-for-column' `
            + `WHERE name = '${FIXTURE}';\n`);

        assert.equal(categoryOf(FIXTURE), 'ct-before',
            'the database was left half restored, which is the worst outcome');
        assert.ok(!/Proses pemulihan data selesai/.test(html),
            'a restore that was rolled back was reported as done');
        assert.match(html, /Pemulihan dibatalkan/, 'the operator was not told it failed');
        assert.match(html, /ERROR/, 'the refusal gives no reason to act on');
    });
});

describe("settings.php export is the caller's own rows", () => {
    // pg_dump has no WHERE, so `-t public.users -t public.channels` gave a
    // branch admin every branch's rows under a filename bearing its own name.
    // Read-only throughout: an export changes nothing, so there is nothing to
    // put back.
    let branchA, branchB, sup;
    before(async () => {
        branchA = await asBranchA();
        branchB = await asBranchB();
        sup = await asSuper();
    });

    const exportOf = async (cookie) =>
        (await postForm('/settings.php', cookie, { export_db: '1' })).text();

    test('a branch export carries that branch and no other', async () => {
        const a = await exportOf(branchA);
        const b = await exportOf(branchB);

        assert.ok(a.includes("'CT_A1'"), "branch A's export is missing its own unit");
        assert.ok(!a.includes("'CT_B1'"), "branch A's export carries branch B's unit");
        assert.ok(b.includes("'CT_B1'"), "branch B's export is missing its own unit");
        assert.ok(!b.includes("'CT_A1'"), "branch B's export carries branch A's unit");
    });

    test('a branch export is still restorable SQL', async () => {
        const a = await exportOf(branchA);
        assert.match(a, /^INSERT INTO public\.channels \(/m, 'no channel rows in the backup');
        assert.match(a, /^INSERT INTO public\.users \(/m, 'no user rows in the backup');
    });

    test('a superadmin still gets a real pg_dump', async () => {
        // Only the first chunk: the full dump is megabytes and the point is the
        // shape, not the contents.
        const res = await postForm('/settings.php', sup, { export_db: '1' });
        assert.match(res.headers.get('content-type'), /octet-stream/);
        const head = new TextDecoder().decode(
            (await res.body.getReader().read()).value ?? new Uint8Array());
        assert.match(head, /PostgreSQL database dump/, 'the full backup is no longer a pg_dump');
    });

    test('the branch path does not shell out at all', () => {
        // The whole point of building it here: no pg_dump, no PGPASSWORD, and
        // no table name that a WHERE cannot reach.
        // Comments are stripped first: the note explaining why the whole-table
        // dump was wrong is not the whole-table dump, and a guard that trips on
        // its own explanation is one people learn to route around.
        const src = readSrc('settings.php');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/^\s*\/\/.*$/gm, '')
                        .replace(/<!--[\s\S]*?-->/g, '');
        assert.ok(!/-t public\.users/.test(code),
            'the whole-table dump is back, and it is every branch\'s rows');
        const i = code.indexOf("if (isset($_POST['export_db']))");
        assert.ok(i > 0, 'the export branch is gone');
        const branch = code.slice(i, code.indexOf('am2_export_rows($pdo', i));
        assert.match(branch, /if \(\$is_super\)/,
            'pg_dump must be reachable only for a superadmin');
    });
});
