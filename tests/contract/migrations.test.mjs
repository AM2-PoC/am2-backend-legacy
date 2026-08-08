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
