import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A process that visits this database must not write to it as though it owned
 * it.
 *
 * resetSessions() and the boot-time cleanup were unconditional, under the
 * premise "this process has no connections yet". That is true of the process
 * and false of the database, which is shared. infra/scripts/smoke-release.sh
 * proves a candidate release can cold-start by running server.js against the
 * real environment file on a loopback port, so every deploy started a second
 * relay against production: it marked every connected unit offline and ran the
 * cleanup DELETE immediately.
 *
 * Measured on production: the busiest unit on the network -- 137 transmissions
 * in fifteen minutes, one of them seven seconds earlier -- sat at
 * status='offline' with its row untouched since login. Live Track selects on
 * status='online', so it had been invisible while transmitting perfectly.
 *
 * Reproduced on staging against the deployed release: two units set online and
 * speaking, one smoke run, both offline and not speaking.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const server = read('server/server.js');
const db = read('server/lib/db.js');
const smoke = read('infra/scripts/smoke-release.sh');
const usersAjax = read('WebAdmin/get-users-ajax.php');

test('nothing writes at boot before ownership is settled', () => {
    const boot = server.slice(server.indexOf('connectRedis();'), server.indexOf('// --- MIDDLEWARE ---'));
    assert.match(boot, /claimRelayOwnership\(\)\.then\(\(owned\) => \{/);
    // Both writers live inside the gate, and neither is called anywhere else.
    for (const call of ['startCleanup();', 'resetSessions();']) {
        assert.equal(server.split(call).length - 1, 1, `${call} is called more than once`);
        const at = server.indexOf(call);
        assert.ok(at > server.indexOf('claimRelayOwnership()'), `${call} runs before ownership is known`);
        assert.ok(at < server.indexOf('// --- MIDDLEWARE ---'), `${call} moved out of the boot block`);
    }
    assert.match(boot, /if \(!owned\) return;/, 'a visitor still performs the boot writes');
});

test('ownership is a lock on the database, not a flag from the caller', () => {
    // A flag the launcher has to remember is a flag the next launcher forgets,
    // and the smoke script is not the only thing that can start server.js.
    const fn = db.slice(db.indexOf('const claimRelayOwnership'), db.indexOf('const resetSessions'));
    assert.match(fn, /pg_try_advisory_lock\(\$1\)/);
    assert.doesNotMatch(fn, /process\.env/, 'ownership is decided by an environment variable');
});

test('the lock is held for the life of the process', () => {
    // An advisory lock belongs to a session. A pooled connection handed back
    // drops it the moment it is reused, and the next probe would then believe
    // it owns the database.
    const fn = db.slice(db.indexOf('const claimRelayOwnership'), db.indexOf('const resetSessions'));
    // Only the success path: a probe that did not get the lock must hand its
    // connection back, and does.
    const success = fn.slice(fn.indexOf('return false;'), fn.indexOf('return true;'));
    assert.doesNotMatch(success, /client\.release\(\)/,
        'the connection holding the lock is returned to the pool');
    assert.match(fn, /await pool\.connect\(\)/);
    assert.match(fn, /client\.release\(\);[\s\S]{0,200}return false;/,
        'a probe keeps a pooled connection it will never use');
});

test('a failed check makes this process a visitor, not a writer', () => {
    // Refusing to start because it could not ask who owns the database is worse
    // than starting without the answer; assuming ownership is worse than both.
    const fn = db.slice(db.indexOf('const claimRelayOwnership'), db.indexOf('const resetSessions'));
    const rescue = fn.slice(fn.indexOf('} catch (err) {'));
    assert.match(rescue, /return false;/);
    assert.doesNotMatch(rescue, /return true;/);
});

test('the smoke test still starts the candidate against the real environment', () => {
    // The guard exists so this can stay as it is: booting against the real
    // configuration is the whole point of the check.
    assert.match(smoke, /source "\$env_file"/);
    assert.match(smoke, /exec node "\$release_root\/server\/server\.js"/);
});

test('who is transmitting comes from the column the relay maintains', () => {
    /*
     * It was inferred from the newest ptt_logs row inside a seven-second
     * window, so a transmission stopped being shown as one at its eighth
     * second. Over thirty days that is 38.9% of transmissions: median 4.4s,
     * p90 26.2s, longest 899s.
     */
    assert.match(usersAjax, /CASE WHEN u\.is_speaking THEN 1 ELSE 0 END as is_speaking/);
    assert.doesNotMatch(usersAjax, /INTERVAL '7 seconds'/, 'the seven-second window is back');
    assert.doesNotMatch(usersAjax, /FROM public\.ptt_logs/,
        'the map still scans the log table on every poll');
});
