/**
 * A branch admin cannot reach another branch's units.
 *
 * The security release claimed this and did not deliver it. Four paths were
 * left open, and each one was next to a sibling that had been fixed -- which is
 * what made them easy to miss:
 *
 *   user_access.php      db_force_logout guarded, update_multi_access not,
 *                        though the latter rewrites the target's entire channel
 *                        membership and pushes it to the relay
 *   channels.php         the DELETE scoped by admin_id, the INSERT loop after
 *                        it not, so a foreign unit could be grafted onto a
 *                        channel -- and then hear and transmit on it
 *   get_users_location.php   no tenant filter at all on live GPS, while the
 *                        identical leak in api_get_users.php was fixed and
 *                        given a test
 *   livetrack.php        one sink escaped, five left raw
 *
 * Read from this checkout, deliberately. The older contract tests read
 * /var/www/am2/staging/current/WebAdmin -- whatever staging last deployed --
 * so they answer for a different tree than the one under review, and can pass
 * while the branch is broken.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

/** A file's PHP with its comments removed: prose naming a guard is not a guard. */
const code = (p) => readFileSync(join(WEBADMIN, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** The text from a POST handler's opening to the first statement that writes. */
function handler(src, opener) {
    const start = src.indexOf(opener);
    assert.notEqual(start, -1, `the handler for ${opener} changed shape`);
    const write = src.slice(start).search(/beginTransaction\(\)|->prepare\("(?:DELETE|UPDATE|INSERT)/i);
    assert.notEqual(write, -1, `no write found after ${opener}`);
    return src.slice(start, start + write);
}

test('rewriting a unit\'s channel membership checks who owns the unit', () => {
    /*
     * The failure this pins: branch admin A posts update_multi_access with
     * branch B's user_id, from A's own page with A's own valid CSRF token. B's
     * unit is removed from every channel it belongs to and joined to one of A's
     * -- and syncUserChannels() pushes it live.
     */
    const src = code('user_access.php');
    const block = handler(src, "isset($_POST['update_multi_access'])");
    assert.match(block, /am2_admin_owns_user\(/,
        'update_multi_access rewrites channel membership for any user_id it is given');
});

test('the force-logout path keeps its guard', () => {
    // The sibling that was already correct. Pinned so a later edit cannot
    // quietly take it back out while attention is on the one above.
    const src = code('user_access.php');
    assert.match(handler(src, "'db_force_logout'"), /am2_admin_owns_user\(/,
        'db_force_logout no longer checks ownership');
});

test('channel membership is written only for units the admin owns', () => {
    /*
     * Both halves of the form are attacker-chosen. The DELETE was scoped and
     * the INSERT loop was not, so a foreign unit could be added to a channel
     * this admin controls -- which on this system means being able to hear and
     * transmit on it.
     */
    const src = code('channels.php');
    const block = handler(src, "isset($_POST['save_channel_access'])");
    assert.match(block, /am2_admin_owns_user\(|admin_id\s*=\s*\?/,
        'the users posted to save_channel_access are inserted without an ownership check');
    assert.match(block, /channels WHERE id = \? AND created_by/,
        'the channel id posted to save_channel_access is never checked against its owner');
});

test('live positions are scoped to the branch that asks for them', () => {
    /*
     * This is what livetrack.php polls. With no filter, every branch admin saw
     * every branch's units by name, channel and coordinates.
     */
    const src = code('get_users_location.php');
    assert.match(src, /u\.admin_id = :admin_id/,
        'get_users_location.php returns every online unit regardless of who is asking');
    // The scope must come from the session. A caller that can name its own
    // admin_id can name somebody else's.
    assert.match(src, /\$_SESSION\['admin_id'\]/,
        'the tenant scope is taken from a request parameter rather than the session');
    assert.doesNotMatch(src, /\$_GET\['admin_id'\]/,
        'the tenant scope can be chosen by the caller');
});

test('every value livetrack interpolates into markup is escaped', () => {
    /*
     * The page builds markup with template literals and hands it to innerHTML
     * and bindPopup. users.php only uppercases a unit name on the way in, and
     * an uppercase tag is still a tag -- so a unit called <IMG SRC=X ONERROR=…>
     * runs in the session of every admin who opens the page, superadmin
     * included.
     *
     * Enumerated rather than pinned to the one line that was fixed: the
     * previous test asserted a single historical string had gone, and passed
     * with five raw sinks live in the file.
     */
    const src = readFileSync(join(WEBADMIN, 'livetrack.php'), 'utf8');
    const raw = [...src.matchAll(/\$\{\s*(?:u|user)\.[a-z_]+\s*\}/g)].map((m) => m[0]);
    assert.deepEqual(raw, [],
        `livetrack.php interpolates unescaped values into markup: ${raw.join(', ')}`);
    // Either declaration form: the page was later rebuilt and the helper
    // became `const esc = (v) => ...`. What matters is that one exists, not
    // which keyword introduced it.
    assert.match(src, /function esc\s*\(|const esc\s*=/, 'the escaping helper is gone');
});

test('the escaping helper is reachable from every caller', () => {
    // It was first added inside renderList(), where the two sinks in
    // updateMarkers() could not see it -- a ReferenceError at runtime, and
    // invisible to any test that only greps for the calls.
    const src = readFileSync(join(WEBADMIN, 'livetrack.php'), 'utf8');
    const script = src.slice(src.lastIndexOf('<script>') + 8, src.lastIndexOf('</script>'));
    const def = script.match(/function esc\s*\(|const esc\s*=/);
    assert.ok(def, 'esc() is not defined in the page script');
    const escAt = def.index;

    /*
     * Every call must come after the definition and no deeper than it.
     *
     * The first version of this checked only that the definition sat at depth
     * zero -- which was right for a function declaration hoisted to the top of
     * the script, and wrong once the page was rebuilt with the helper and its
     * callers together inside one IIFE. What actually breaks is a call the
     * definition cannot reach: `const` is not hoisted, so a use before it
     * throws, and a use outside its block does too.
     */
    const before = script.slice(0, escAt);
    const defDepth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;

    for (const m of script.matchAll(/\besc\s*\(/g)) {
        if (m.index <= escAt) {
            assert.fail(`esc() is called at ${m.index}, before it is defined at ${escAt}`);
        }
        const upto = script.slice(0, m.index);
        const depth = (upto.match(/\{/g) ?? []).length - (upto.match(/\}/g) ?? []).length;
        assert.ok(depth >= defDepth,
            'esc() is called from outside the block that defines it, which throws ReferenceError');
    }
});

test('the feature endpoint still accepts the one the app actually sends', () => {
    /*
     * The allow-list that closed a SQL-injection hole dropped duplex_mode,
     * which has its own branch eight lines above it -- so every FULL/HALF
     * toggle in Admin Native answered "Fitur tidak valid". users.php keeps its
     * own list and still accepted it, so the panel worked and panel testing
     * would not have found this.
     */
    const src = code('api_users.php');
    const allowed = src.match(/\$allowed\s*=\s*\[([^\]]*)\]/);
    assert.ok(allowed, 'the feature allow-list is gone');
    for (const feature of ['enable_maps', 'enable_p2p', 'enable_ptt_video', 'duplex_mode']) {
        assert.match(allowed[1], new RegExp(`'${feature}'`),
            `${feature} is not accepted; the app that sends it gets "Fitur tidak valid"`);
    }
    /*
     * Validated before the transaction opens, so the rejection does not exit
     * with one dangling. Measured inside this handler: the file opens several
     * transactions, and comparing against the first one in the file compares
     * against a different action entirely.
     */
    const block = src.slice(src.indexOf("'update_feature'"));
    assert.ok(block.indexOf('$allowed') < block.indexOf('beginTransaction'),
        'the allow-list is checked after the transaction opens');
});
