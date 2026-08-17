/**
 * The API key stays recorded-not-enforced until somebody decides otherwise.
 *
 * `log` mode is a measurement, not a permanent state: it records what `enforce`
 * would have refused, so the switch can be flipped on evidence rather than
 * hope. The callers are field devices nobody can survey directly.
 *
 * Two failures are worth guarding against, and they point in opposite
 * directions. Flipping the default to `enforce` in code -- rather than per
 * environment, deliberately -- would 401 every unkeyed caller the moment a
 * release lands, with no measurement having happened. Removing the recording
 * would take away the only instrument that can ever say the flip is safe.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PHP = read('WebAdmin/config.php');
const NODE = read('server/server.js');
const REPORT = 'infra/scripts/api-auth-report.sh';

test('both halves default to refusing, not recording', () => {
    /*
     * This asserted the opposite while the callers were being migrated, and the
     * reason was sound: enforcing by default would have refused callers nobody
     * had measured yet.
     *
     * They have been measured. Across seven days and 101,361 production log
     * lines exactly one request would have been refused, and it was for a route
     * nginx already denied. The six routes with no caller are deleted, and the
     * one real consumer -- the panel, through node_client.php -- sends the
     * header. So the migration is over, and a credential control whose default
     * is "allow" is a default waiting to be forgotten on the next host somebody
     * builds.
     *
     * The concern that motivated the old assertion is answered by a boot-time
     * error instead of by failing open: see the enforce-without-a-key warning
     * in server.js, which makes a misconfigured host loud rather than either
     * silently insecure or silently broken.
     */
    for (const [name, src] of [['WebAdmin/config.php', PHP], ['server/server.js', NODE]]) {
        const fallback = src.match(/AM2_API_AUTH_MODE'?\)?\s*(?:\|\||\?:)\s*'([a-z]+)'/);
        assert.ok(fallback, `${name} no longer has a default auth mode`);
        assert.equal(fallback[1], 'enforce',
            `${name} defaults to "${fallback[1]}"; an unconfigured host must not `
            + 'let unauthenticated admin calls through');
    }
});

test('a host that enforces without a key is told so at boot', () => {
    // The failure mode the old default existed to avoid, handled directly.
    assert.match(NODE, /AM2_API_AUTH_MODE=enforce with no AM2_API_KEY/,
        'a misconfigured host refuses its own panel with nothing explaining why');
});

test('both halves read the same variable, so one cannot be flipped alone', () => {
    // Setting one and leaving the other is the failure that looks like success:
    // the panel refuses and the relay does not, or the reverse.
    for (const [name, src] of [['WebAdmin/config.php', PHP], ['server/server.js', NODE]]) {
        assert.match(src, /AM2_API_AUTH_MODE/, `${name} does not read AM2_API_AUTH_MODE`);
        assert.match(src, /enforce/, `${name} has no enforce branch, so the switch does nothing there`);
    }
});

test('a rejection is recorded whether or not it is refused', () => {
    /*
     * This is the instrument. Without it there is no way to ever answer whether
     * enforcing is safe, and the switch stays open forever by default.
     */
    for (const [name, src] of [['WebAdmin/config.php', PHP], ['server/server.js', NODE]]) {
        assert.match(src, /REJECT-CANDIDATE/,
            `${name} no longer records rejections, so nothing can measure the flip`);
    }
    // Recorded before the mode is consulted, not inside the enforce branch --
    // otherwise log mode records nothing, which is the one thing it is for.
    const recordAt = PHP.indexOf('REJECT-CANDIDATE');
    const enforceAt = PHP.search(/===\s*'enforce'/);
    assert.notEqual(enforceAt, -1, 'the enforce branch is gone from config.php');
    assert.ok(recordAt < enforceAt,
        'the rejection is recorded inside the enforce branch, so log mode measures nothing');
});

test('a panel session is accepted without a key', () => {
    /*
     * dashboard.php fetches api_dashboard_chart.php from the browser, carrying
     * a session cookie and no key. Before the session-aware path landed those
     * calls were logged as rejection candidates -- sixty of them -- which under
     * enforce would have been the panel 401ing its own dashboard.
     */
    const auth = PHP.match(/function am2_api_auth\(\)[\s\S]*?\n\}/);
    assert.ok(auth, 'am2_api_auth() is gone');
    assert.match(auth[0], /admin_logged_in/,
        'am2_api_auth() no longer accepts a panel session, so enforcing would refuse the '
        + "panel's own endpoints");
    const sessionAt = auth[0].indexOf('admin_logged_in');
    const keyAt = auth[0].indexOf('AM2_API_KEY');
    assert.ok(sessionAt < keyAt,
        'the session check runs after the key check, so a signed-in admin is judged as anonymous');
});

test('the readiness report exists and is runnable', () => {
    const src = read(REPORT);
    assert.ok(statSync(join(ROOT, REPORT)).mode & 0o111, 'the readiness report is not executable');
    // The two misreadings this report exists to prevent.
    assert.match(src, /ua=node/,
        'the report no longer separates this repo\'s own test traffic, which is most of it');
    assert.match(src, /ABSENT|NOT READY TO DECIDE/,
        'the report no longer says when a quiet log means the check simply is not deployed');
});

test('the flip is documented as a sequence, not a setting', () => {
    const doc = read('docs/how-to/enforce-the-api-key.md');
    assert.match(doc, /api-auth-report\.sh/, 'the runbook does not tell anyone how to measure first');
    assert.match(doc, /api\.\w*\.?env|api\.<environment>\.env/,
        'the runbook does not mention the relay env file, so only half the switch gets flipped');
});
