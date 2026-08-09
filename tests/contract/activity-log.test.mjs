// The activity log: written as an event, rendered as a sentence.
//
// The failure this file exists for is quiet. Every entry used to be one
// Indonesian string built where it was written, so the Logs page could only
// ever be as bilingual as the database — and nothing failed when it was not.
// A page simply showed Indonesian to an English reader and looked fine.
//
// It also pins the shape api_logs.php hands to the Admin Native log screen.
// The structure went into the database, not into that response, and this is
// what says so.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { asSuper, get, postForm, sql, sqlOne, guardCtTarget, readSrc, SRC, BASE, HOST }
    from './helpers.mjs';

// One session for the file. Each login is a session_regenerate_id(true) on
// the staging server, and this suite already opens a dozen of them in
// parallel; there is no reason for this file to add three more.
const sup = await asSuper();

/** The admin log as one language renders it. */
async function admLogs(cookie, lang) {
    const res = await fetch(`${BASE}/fetch_logs.php`, {
        headers: { Host: HOST, Cookie: `${cookie}; am2_lang=${lang}` },
    });
    return (await res.json()).adm ?? [];
}

describe('the activity log is an event, not a sentence', () => {
    test('one event renders in both languages', async () => {
        const cookie = sup;

        // The fixture is resolved, then checked. A mutation test that names
        // its target in a string is one rename away from touching a real unit.
        // This file owns CT_A4 and writes nothing else. Picking "the first
        // ct_ unit" reached CT_A1, which channel-access.test.mjs owns, and the
        // two files run in parallel.
        const unit = sqlOne(
            "SELECT id FROM public.users WHERE id = 'CT_A4' AND role = 'user'");
        assert.ok(unit, 'staging is missing the CT_A4 fixture — rerun contract-test-fixtures.sh');
        guardCtTarget(unit[0]);
        const unitId = unit[0];

        try {
            const res = await postForm('/users.php', cookie, {
                update_feature: '1', u_id: unitId, feature: 'enable_maps', val: 'true',
            });
            const body = await res.json();
            assert.notEqual(body.success, false, `the toggle was refused: ${JSON.stringify(body)}`);

            // Found by what it is, not by being the newest row. The suite
            // runs its files in parallel and several of them write log rows,
            // so "ORDER BY id DESC LIMIT 1" is whichever test got there last.
            const row = sqlOne(
                'SELECT id, event_code, event_params::text, aksi FROM public.admin_activity_logs '
                + "WHERE event_code = 'feature.enable' "
                + `AND event_params->>'id' = '${unitId}' ORDER BY id DESC LIMIT 1`);
            assert.ok(row, 'the toggle wrote no log row at all');
            assert.equal(row[1], 'feature.enable', 'the row carries no event code');
            assert.equal(row[3], 'UPDATE_FEATURE',
                'aksi is what the Admin Native log screen groups by — it must not move');
            assert.match(row[2], /@log\.f_maps/,
                'the feature name must travel as a catalog key, not as Indonesian');

            const byId = (rows) => rows.find((r) => String(r.id) === String(row[0]));
            const id = byId(await admLogs(cookie, 'id'));
            const en = byId(await admLogs(cookie, 'en'));
            assert.ok(id && en, 'the row this test wrote is not in the newest hundred');
            assert.match(id.target, /Mengaktifkan/);
            assert.match(en.target, /Enabled/);
            assert.match(id.target, /Fitur Lokasi/);
            assert.match(en.target, /Location/);
            assert.ok(id.target.includes(unitId) && en.target.includes(unitId));
        } finally {
            sql("DELETE FROM public.admin_activity_logs WHERE event_code = 'feature.enable' "
                + `AND event_params->>'id' = '${unitId}' AND waktu > NOW() - INTERVAL '5 minutes'`);
        }
    });

    test('rows written before the migration still read', async () => {
        // 5,464 of them, and they clear themselves within 30 days — runCleanup()
        // in server.js. Until then the free text is the only record they have.
        const cookie = sup;
        const old = sqlOne("SELECT id, keterangan FROM public.admin_activity_logs "
            + "WHERE event_code IS NULL AND keterangan IS NOT NULL AND keterangan <> '' "
            + 'ORDER BY id DESC LIMIT 1');
        if (!old) return;   // they have aged out; nothing left to protect

        const rows = await admLogs(cookie, 'en');
        const found = rows.find((r) => String(r.id) === String(old[0]));
        if (!found) return; // not in the newest hundred
        assert.equal(found.target, old[1],
            'a pre-migration row lost its free text — that is its only record');
    });

    test('api_logs.php hands the app a finished string and no new keys', async () => {
        const cookie = sup;
        const rows = await (await get('/api_logs.php?category=ADM', cookie)).json();
        const adm = rows.find((r) => r.kategori === 'ADM');
        assert.ok(adm, 'staging must carry admin log rows for this assertion to bite');

        assert.equal(typeof adm.target, 'string');
        assert.ok(adm.target.length > 0, 'target is what the log screen displays');
        for (const k of ['aksi', 'jam', 'tanggal', 'pelaksana', 'pelaksana_id', 'kategori']) {
            assert.ok(k in adm, `api_logs row lost ${k}`);
        }
        for (const k of ['event_code', 'event_params', 'keterangan']) {
            assert.ok(!(k in adm),
                `api_logs now leaks ${k} to the mobile app — the rendering belongs on this side`);
        }
    });

    test('nothing writes the log by hand any more', () => {
        // One writer means one shape. Two writers of one event is exactly how
        // "Update akses X ke: …" and the same line with " (via Mobile)" glued
        // on the end came to exist in two files.
        const offenders = [];
        for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.php'))) {
            if (f === 'activity_log.php') continue;
            const src = readSrc(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            if (/INSERT\s+INTO\s+public\.admin_activity_logs/i.test(src)) offenders.push(f);
        }
        assert.deepEqual(offenders, [],
            `these write the log directly instead of through am2_log(): ${offenders.join(', ')}`);
    });

    test('every event code the code can write has a catalog entry', () => {
        // t() answers with the key when it is missing, so a typo here would
        // put "log.user.creat" on the screen rather than failing.
        const codes = new Set();
        for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.php'))) {
            for (const m of readSrc(f).matchAll(/am2_log\([^;]*?,\s*'([a-z_]+\.[a-z_]+)'/gs)) {
                codes.add(m[1]);
            }
        }
        assert.ok(codes.size > 0, 'no am2_log() call sites found — the matcher has drifted');

        for (const lang of ['id', 'en']) {
            const catalog = fs.readFileSync(`${SRC}/lang/${lang}.php`, 'utf8');
            for (const code of codes) {
                assert.ok(catalog.includes(`'log.${code}'`),
                    `lang/${lang}.php has no entry for log.${code}`);
            }
        }
    });

    test('the trigger writes codes, not Indonesian', () => {
        // Asked as three booleans rather than fetched as source: prosrc is
        // multi-line, and the helper splits psql output on newlines, so
        // reading it directly returns the word DECLARE and nothing else.
        const row = sqlOne(`SELECT
                prosrc LIKE '%event_code%',
                prosrc LIKE '%IS DISTINCT FROM%',
                prosrc LIKE '%Tambah %'
            FROM pg_proc WHERE proname = 'log_admin_activity'`);
        assert.ok(row, 'the trigger function is missing');
        assert.equal(row[0], 't', 'migration 002 has not been applied to this database');
        // OLD.name <> NEW.name is false when either side is NULL, so renaming a
        // row with no name recorded nothing at all.
        assert.equal(row[1], 't', 'the trigger still compares names with <>');
        assert.equal(row[2], 'f', 'the trigger still concatenates an Indonesian sentence');
    });
});
