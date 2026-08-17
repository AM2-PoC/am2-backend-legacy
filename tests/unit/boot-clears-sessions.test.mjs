import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nobody is connected to a process that has just started.
 *
 * Session state lives in two places: in memory, which a restart clears for
 * free, and in `public.users` -- `status`, `current_device_id`, `is_speaking` --
 * which it does not. Only the close handler wrote those back, and it runs after
 * a ten second grace timer, so any termination that is not graceful leaves them
 * set: a crash, an OOM kill, or `systemctl restart` during a deploy, which is
 * every deploy with anyone on the air.
 *
 * Two things then go wrong, and neither announces itself.
 *
 * The roster lies. `broadcastUsersInChannel` selects on `status = 'online'`, so
 * units that were connected to the dead process keep appearing in every
 * client's list until each of them signs in again.
 *
 * And login can be refused outright. The single-device check reads
 * `current_device_id` from the database and, outside a grace period, refuses a
 * different one -- so an operator is told "signed in on another device" when no
 * device is signed in anywhere, and the only recovery is an administrator
 * editing the row. That is not hypothetical here: `ANDROID_ID` is derived from
 * the signing key, and every CI build is signed with a different one, so
 * installing a fresh staging APK presents a new device id to a row that still
 * names the old one.
 *
 * The reset is unconditional because the premise is: this process has no
 * connections yet.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = readFileSync(join(ROOT, 'server', 'lib', 'db.js'), 'utf8');
const server = readFileSync(join(ROOT, 'server', 'server.js'), 'utf8');

test('a boot-time session reset exists', () => {
    assert.match(db, /resetSessions|clearStaleSessions/,
        'nothing clears session state that outlived the previous process');
});

test('it is run at boot, before connections are accepted', () => {
    assert.match(server, /resetSessions|clearStaleSessions/,
        'the reset is never called');
});

test('it clears every column a live session writes', () => {
    const body = db.slice(db.indexOf('const resetSessions'));
    const fn = body.slice(0, body.indexOf('\n};') + 3);
    assert.match(fn, /status\s*=\s*'offline'/, 'the roster keeps showing ghosts');
    assert.match(fn, /current_device_id\s*=\s*NULL/,
        'a stale device id still refuses the operator their own account');
    assert.match(fn, /is_speaking\s*=\s*false/, 'a unit stays marked as transmitting');
});

test('it does not touch anything a session does not own', () => {
    // A boot-time write against every row is the kind of statement that is
    // cheap to get wrong. It may correct session state and nothing else --
    // not channel membership, not permissions, not passwords.
    const body = db.slice(db.indexOf('const resetSessions'));
    const fn = body.slice(0, body.indexOf('\n};') + 3);
    for (const forbidden of ['DELETE', 'DROP', 'password', 'permission', 'user_channels']) {
        assert.ok(!fn.includes(forbidden),
            `the boot reset touches ${forbidden}, which no session owns`);
    }
    assert.match(fn, /UPDATE public\.users/, 'the reset writes somewhere unexpected');
});

test('a failure to reset does not stop the relay booting', () => {
    // A radio that will not start because a cleanup query failed is worse than
    // one that starts with a stale roster.
    const body = db.slice(db.indexOf('const resetSessions'));
    const fn = body.slice(0, body.indexOf('\n};') + 3);
    assert.match(fn, /catch/, 'a database hiccup at boot takes the relay down with it');
});
