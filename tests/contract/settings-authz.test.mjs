/**
 * The backup endpoint requires a signed-in superadmin.
 *
 * api_settings.php had no authentication of any kind. It read the caller's role
 * from `$_GET['role']` and, on that word, streamed a pg_dump of the whole public
 * schema; its import action shell_exec'd psql against an uploaded .sql with no
 * role check at all. Both were reachable from the internet, because the panel's
 * vhost forwards every path. Verified against the release running in production
 * on 2026-08-09: zero occurrences of any session or auth check in the file.
 *
 * This is the first test file in the repository, added with the fix rather than
 * after it, so it deliberately depends on nothing: no harness, no credentials,
 * no running host. It reads the source, because the property being pinned is
 * structural -- which identity the file trusts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

/** A file's PHP with comments stripped: prose naming a guard is not a guard. */
const code = (p) => readFileSync(join(WEBADMIN, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

const SETTINGS = () => code('api_settings.php');

test('nothing in the backup endpoint runs without a session', () => {
    const src = SETTINGS();
    /*
     * The property is that the endpoint runs inside a started session, not that
     * this file contains a particular call. Session startup moved into
     * session_boot.php so every entry point gets the same cookie flags, and
     * demanding the literal session_start() here would have punished that.
     *
     * An indirection is worth only what it does, so the helper is checked too:
     * booting through one that never starts a session would otherwise satisfy
     * this test while protecting nothing.
     */
    const bootsDirectly = /session_start\(\)/.test(src);
    const bootsViaHelper = /am2_session_boot\(\)/.test(src);
    assert.ok(bootsDirectly || bootsViaHelper, 'api_settings.php never starts a session');
    if (bootsViaHelper) {
        const boot = code('session_boot.php');
        assert.match(boot, /session_start\(\)/, 'am2_session_boot() does not start a session');
        assert.match(boot, /'httponly'\s*=>\s*true/, 'the session cookie is readable by script');
        assert.match(boot, /'samesite'\s*=>\s*'Lax'/, 'the session cookie rides cross-site requests');
    }
    const gate = src.search(/admin_logged_in/);
    assert.notEqual(gate, -1, 'api_settings.php does not check that anyone is signed in');
    // Before the first thing that acts, not somewhere further down.
    for (const act of ['export_db', 'import_db', 'update_password']) {
        assert.ok(gate < src.indexOf(act),
            `the ${act} handler is reachable before the session check`);
    }
});

test('the role is the session\'s, never the request\'s', () => {
    /*
     * The whole defect in one line: `$role = $_GET['role'] ?? 'admin'`, then
     * `if ($role === 'superadmin')` decided whether to dump the entire schema.
     */
    const src = SETTINGS();

    // A role can never come from the request: there is no reading of it that
    // is not the caller choosing their own privileges.
    for (const bad of [/\$_GET\['role'\]/, /\$_POST\['role'\]/]) {
        assert.doesNotMatch(src, bad, `api_settings.php takes a role from the request: ${bad}`);
    }

    /*
     * admin_id is different: reading it to refuse a mismatch is not trusting
     * it. Ignoring it outright was the first fix and it was too quiet -- a
     * caller asking to change admin 5's password had admin 6's changed and was
     * told it worked, which a contract test found by having its own fixture
     * password rewritten underneath it.
     *
     * So the rule is about use, not mention: it may be compared against the
     * session, never assigned from.
     */
    for (const m of src.matchAll(/\$(?:admin_id|target)\s*=\s*[^;\n]*\$_(?:GET|POST)\['admin_id'\]/g)) {
        assert.fail(`api_settings.php selects an admin from the request: ${m[0]}`);
    }
    if (/\$_(?:GET|POST)\['admin_id'\]/.test(src)) {
        assert.match(src, /!==\s*\(string\)\s*\$admin_id|\$named\s*!==\s*null/,
            'admin_id is read from the request but never compared against the session');
    }
    assert.match(src, /\$_SESSION\['admin_role'\]/, 'the role no longer comes from the session');
});

test('export and import both require superadmin', () => {
    const src = SETTINGS();
    for (const action of ['export_db', 'import_db']) {
        const at = src.indexOf(action);
        assert.notEqual(at, -1, `the ${action} handler is gone`);
        const after = src.slice(at, at + 400);
        assert.match(after, /am2_settings_require_superadmin|is_superadmin/,
            `${action} does not check for superadmin`);
    }
});

test('neither database command is assembled as a shell string', () => {
    /*
     * `psql ... < $file` and `pg_dump -h $host ...` were built by concatenation
     * and handed to a shell. Nothing in them is attacker-controlled today --
     * they come from the env file -- but a shell string is one configuration
     * change away from being command injection, and there is no reason to keep
     * one when proc_open takes an argument array.
     */
    const src = SETTINGS();
    // Word-bounded: fpassthru() streams a file pointer and is not a shell call.
    // Matching it was a false positive on the very fix this test is here for.
    for (const fn of ['shell_exec', 'exec', 'system', 'passthru', 'popen']) {
        assert.doesNotMatch(src, new RegExp(`(?<![a-z_])${fn}\\s*\\(`),
            `a database command still goes through a shell (${fn})`);
    }
    assert.match(src, /proc_open\s*\(\s*\[/, 'the commands are not passed as an argument array');
});

test('the database password does not reach the process table', () => {
    // putenv() sets it on this process, where `ps` shows it to every account on
    // the host. proc_open's env argument sets it on the child alone.
    const src = SETTINGS();
    assert.doesNotMatch(src, /putenv\s*\(\s*"PGPASSWORD/,
        'PGPASSWORD is set on this process, so `ps` reveals it');
    assert.match(src, /'PGPASSWORD'\s*=>/, 'the child process is not given the password');
});

test('a restore only ever reads a real upload', () => {
    // Without is_uploaded_file(), a handler that takes a path from the request
    // can be pointed at any file the web user can read.
    assert.match(SETTINGS(), /is_uploaded_file\s*\(/,
        'the restore path is not checked to be an actual upload');
});

test('live positions are scoped to the branch that asks for them', () => {
    /*
     * get_users_location.php is what livetrack.php polls, and it had neither a
     * session check nor a tenant filter: every branch admin saw every branch's
     * units by name, channel and coordinates, and so did anyone who could reach
     * the host.
     */
    const src = code('get_users_location.php');
    assert.match(src, /admin_logged_in/, 'the position feed answers without a session');
    assert.match(src, /u\.admin_id = :admin_id/,
        'the position feed returns every online unit regardless of who is asking');
    assert.match(src, /\$_SESSION\['admin_id'\]/,
        'the tenant scope is taken from the request rather than the session');
    assert.doesNotMatch(src, /\$_GET\['admin_id'\]/,
        'the tenant scope can be chosen by the caller');
});
