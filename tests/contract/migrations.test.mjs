/**
 * Schema changes are applied by something, and recorded somewhere.
 *
 * They were not. Two migration files sat in infra/migrations/ referenced by
 * nothing -- a repo-wide grep for their names returned only the files
 * themselves -- and the deploy runbook went archive, npm ci, php -l, symlink
 * swap, with no step that touched the schema. Whether a database had the
 * columns depended on whether somebody remembered to paste the SQL in by hand.
 * Production had not: checked against information_schema, neither migration was
 * present.
 *
 * That was survivable only while main did not carry the code that needs them.
 * fetch_logs.php selects event_code, so the deploy that merges this stack onto
 * an unmigrated database takes the Activity Log down and leaves am2_log()
 * writing nothing -- silently, because it swallows its own failures by design.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const RUNNER = 'infra/scripts/apply-migrations.sh';
const RUNBOOK = 'docs/how-to/deploy-and-roll-back.md';
const MIG_DIR = join(ROOT, 'infra', 'migrations');

const migrations = () => readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

/** A migration's SQL with its comments removed. */
const sql = (f) => readFileSync(join(MIG_DIR, f), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

test('something applies the migrations, and it is executable', () => {
    const runner = read(RUNNER);
    assert.match(runner, /schema_migrations/,
        'the runner does not record what it applied, so nothing knows what has run');
    assert.ok(statSync(join(ROOT, RUNNER)).mode & 0o111,
        'the runner is not executable, so the runbook step cannot invoke it');
});

test('the deploy runbook applies them before the swap', () => {
    /*
     * Order is the whole point. Migrations after the symlink swap means a
     * window -- however short -- where the new code is live against the old
     * schema, and on this application that window is a broken Activity Log.
     */
    const doc = read(RUNBOOK);
    assert.match(doc, /apply-migrations\.sh/,
        'the deploy runbook never applies migrations, so a schema change ships as code only');

    const migrateAt = doc.indexOf('apply-migrations.sh');
    const swapAt = doc.search(/ln -sfn "?\$REL"? \/var\/www\/am2\/current/);
    assert.notEqual(swapAt, -1, 'the runbook no longer contains the symlink swap');
    assert.ok(migrateAt < swapAt,
        'migrations run after the release is swapped in, so new code serves against the old schema');
});

test('the runner is told which database, never guessing', () => {
    // A runner with a default is one keystroke from migrating the wrong
    // database, and the wrong one here is production.
    const runner = read(RUNNER);
    assert.match(runner, /REFUSING[\s\S]{0,80}--db is required/,
        'the runner accepts a missing --db, so it can pick a database on its own');
});

test('a migration that cannot run in a transaction is not put in one', () => {
    /*
     * CREATE INDEX CONCURRENTLY fails outright inside a transaction block, and
     * both migrations use it deliberately: ptt_logs is written on every
     * transmission, so the plain form would hold a write lock against live
     * traffic. A runner that wraps everything would fail on the first file.
     */
    const runner = read(RUNNER);
    assert.match(runner, /CONCURRENTLY/,
        'the runner does not know about CONCURRENTLY, so it will fail on the first migration');
    assert.match(runner, /single-transaction/,
        'nothing wraps the ordinary migrations, so a half-applied file can be recorded as done');
    // Comments must not decide this: 001 explains CONCURRENTLY in prose above
    // the statement using it, and a file that merely mentioned the word would
    // otherwise lose its transaction silently.
    assert.match(runner, /sed 's\/--\.\*\/\/'[^\n]*grep -qi 'CONCURRENTLY'/,
        'the runner decides on transactions by matching raw text, so a comment mentioning '
        + 'CONCURRENTLY would strip a real migration of its transaction');
});

test('every migration can be run twice', () => {
    /*
     * The runner records what it applied, so a second run skips. That record is
     * the safety net, not the guarantee: a restore, a lost row, or the
     * non-atomic CONCURRENTLY path can all leave a migration applied but
     * unrecorded, and re-running has to be uneventful when it happens.
     */
    for (const f of migrations()) {
        const body = sql(f);
        for (const [stmt, re, guard] of [
            ['CREATE INDEX', /CREATE\s+INDEX/i, /IF\s+NOT\s+EXISTS/i],
            ['ADD COLUMN', /ADD\s+COLUMN/i, /IF\s+NOT\s+EXISTS/i],
            ['CREATE FUNCTION', /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i, /OR\s+REPLACE/i],
        ]) {
            if (!re.test(body)) continue;
            assert.match(body, guard,
                `${f} uses ${stmt} without an idempotence guard; running it twice fails`);
        }
    }
});

test('the migrations are named so their order is their name', () => {
    // The runner applies them in sorted order and keys the record on the
    // filename. A name that does not sort is a migration that runs at the wrong
    // time on a fresh database.
    for (const f of migrations()) {
        assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/,
            `${f} does not follow NNN_lower_snake.sql, so its position in the order is unclear`);
    }
    const numbers = migrations().map((f) => f.slice(0, 3));
    assert.equal(new Set(numbers).size, numbers.length,
        `two migrations share a number, so which runs first depends on the rest of the name: ${numbers}`);
});

test('live location identity migration is additive and does not fake old sample times', () => {
    const body = sql('003_live_location_identity.sql');
    assert.match(body, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+entity_type/i);
    assert.match(body, /DEFAULT\s+'user'/i);
    assert.match(body, /CHECK[\s\S]*'user'[\s\S]*'tracker'/i);
    assert.match(body, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+location_updated_at/i);
    assert.doesNotMatch(body, /SET\s+location_updated_at\s*=\s*updated_at/i,
        'mixed account timestamps must not be presented as GPS sample times');
    assert.doesNotMatch(body, /DROP\s+(?:COLUMN|TABLE)|ALTER\s+COLUMN[\s\S]*TYPE/i,
        'the first release must remain code-rollback compatible');
});

test('fresh-install users schema matches live-location migration', () => {
    const schema = read('infra/docker/seed/01-schema.sql');
    assert.match(schema, /entity_type\s+(?:character varying|varchar)\(16\)[\s\S]*DEFAULT\s+'user'/i);
    assert.match(schema, /location_updated_at\s+timestamp\s+with\s+time\s+zone/i);
    assert.match(schema, /CHECK[\s\S]*entity_type[\s\S]*'tracker'/i);
});

test('synthetic fixtures exercise both live-track entity identities', () => {
    const fixtures = read('infra/scripts/contract-test-fixtures.sh');
    const seed = read('infra/docker/seed/02-seed.sql');
    assert.match(fixtures, /entity_type/i);
    assert.match(fixtures, /CT_A3[\s\S]*tracker/i);
    assert.match(fixtures, /ON\s+CONFLICT[\s\S]*DO\s+UPDATE[\s\S]*entity_type/i);
    assert.match(seed, /entity_type/i);
    assert.match(seed, /DEMO_UNIT_3[\s\S]*tracker/i);
});

test('deleting one admin cannot delete a branch', () => {
    /*
     * On 2026-09-04 a single unauthenticated POST deleted admin id 4 and
     * ON DELETE CASCADE took 186 units, 191 channel memberships, 186 permission
     * rows and 114,514 log rows with it. No confirmation, no count, no pause.
     *
     * The authentication hole that let the POST through is closed, but the
     * cascade is a separate hazard and it points at the same outcome for a
     * legitimate superadmin in a hurry. RESTRICT is the one guard that holds
     * regardless of which path tries -- panel, Admin app, a future Laravel
     * adapter, or psql at two in the morning -- because it is the database
     * refusing rather than an application remembering.
     *
     * Soft delete was the alternative and is the wrong trade here: retrofitting
     * `deleted_at` across 167 raw SQL statements fails *open* when one is
     * missed -- a deleted unit that still answers, still logs in, still
     * transmits. RESTRICT fails closed.
     */
    // Comments stripped, so the rule has to be in the SQL rather than in a
    // note promising it.
    const all = migrations().map(sql).join('\n');
    assert.match(all, /ALTER TABLE[\s\S]{0,160}users[\s\S]{0,240}ON DELETE RESTRICT/i,
        'users.admin_id still cascades; one admin row still takes a branch with it');
});
