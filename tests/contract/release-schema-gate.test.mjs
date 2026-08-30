// A release may not go live ahead of its own schema.
//
// 80ab744 shipped the device-token login and 005_device_tokens.sql together.
// The code went to staging; whether the table existed depended on somebody
// remembering apply-migrations.sh. Production still has 001 through 004 and
// not 005, so that release landing there would have found no table -- and the
// relay would not have said so: issueDeviceToken is wrapped in a try that logs
// and continues, and userForDeviceToken leaves through the login catch-all,
// which reports it to the handset as a database timeout.
//
// The check belongs before the symlink moves, not at ExecStartPre. A relay
// that refuses to start has already stopped the one that was working; a smoke
// that refuses to pass leaves the old release serving while somebody runs the
// migration.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const SMOKE = fs.readFileSync(path.join(ROOT, 'infra/scripts/smoke-release.sh'), 'utf8');

/** The script with its comment lines removed, so prose cannot satisfy a check. */
const code = SMOKE.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

describe('the release smoke', () => {
    test('it refuses a release whose migrations are not applied', () => {
        assert.match(code, /schema_migrations/,
            'the smoke never asks which migrations the database has, so a release '
            + 'can go live against a schema that predates it');
        assert.match(code, /infra\/migrations/,
            'the smoke does not read the migrations this release carries');
    });

    test('it names the file to run rather than only failing', () => {
        assert.match(code, /apply-migrations\.sh/,
            'a failure here leaves an operator to work out the remedy themselves');
    });

    test('it asks the database the relay itself will use', () => {
        // Not psql as postgres: that proves a superuser can see the row, not
        // that the relay's own credentials and database can.
        const gate = code.slice(code.indexOf('schema_migrations') - 2000);
        assert.match(gate, /DB_NAME|DB_USER|process\.env/,
            'the gate does not connect the way the relay connects');
    });

    test('every migration in the tree is a plain forward-only file', () => {
        // The gate compares filenames, so a migration that is applied under a
        // different name than it carries would pass while doing nothing.
        const dir = path.join(ROOT, 'infra/migrations');
        const files = fs.readdirSync(dir);
        assert.ok(files.length > 0, 'no migrations to gate on');
        for (const name of files) {
            assert.match(name, /^\d{3}_[a-z0-9_]+\.sql$/,
                `${name} is not named the way the gate matches migrations`);
        }
    });
});
