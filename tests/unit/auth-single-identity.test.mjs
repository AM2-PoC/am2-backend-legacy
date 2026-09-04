import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One identity, decided by the server, and no switch that can turn it off.
 *
 * The panel and the relay both read an environment variable named
 * AM2_API_AUTH_MODE. One name, two systems, two meanings of "safe": setting it
 * for the panel silently said nothing about the relay, and production ran the
 * panel on `log` -- which recorded a rejection and then served the request
 * anyway. On top of that, am2_api_identity() accepted `admin_id` and `role`
 * straight off the query string whenever no session was present, so the
 * combination let anyone who could reach api_*.php write as a superadmin.
 *
 * The fix is not a better default. A control with an off position is a control
 * someone will find in a hurry at 2am, so the off position is removed: there is
 * no mode, identity comes only from the session, and the guard runs from the
 * one bootstrap every endpoint already includes.
 *
 * These assertions are deliberately made by *absence*. Naming the value that
 * was wrong ("must not be 'log'") only ever forbids the spelling that already
 * hurt; forbidding the whole mechanism is what stops the next spelling.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const config = read('WebAdmin/config.php');
const guard = read('WebAdmin/auth_guard.php');
const prepend = read('infra/php/webadmin-prepend.php');
const server = read('server/server.js');

/** The body of a PHP function, from its signature to the closing brace. */
const phpFunction = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() is not defined`);
    const end = source.indexOf('\n}', start);
    assert.notEqual(end, -1, `${name}() has no closing brace`);
    return source.slice(start, end);
};

test('no auth mode survives anywhere in the tree', () => {
    /*
     * Across the repository, not just the two files that read it today. A
     * helper that re-derives the same switch under a new name is the same
     * defect, and grepping the tree is the only assertion that catches it.
     */
    const offenders = [];
    const walk = (dir) => {
        for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${entry.name}`;
            if (/^(node_modules|\.git|releases|vendor)$/.test(entry.name)) continue;
            if (entry.isDirectory()) { walk(rel); continue; }
            if (!/\.(php|js|mjs|sh|json|md|conf)$/.test(entry.name)) continue;
            // This file names the thing it forbids; so does the plan that
            // records why it was removed.
            if (rel.endsWith('auth-single-identity.test.mjs')) continue;
            if (readFileSync(join(ROOT, rel), 'utf8').includes('AUTH_MODE')) offenders.push(rel);
        }
    };
    walk('WebAdmin');
    walk('server');
    walk('infra');
    walk('tests');
    assert.deepEqual(offenders, [],
        `an auth mode is back in: ${offenders.join(', ')}`);
});

test('the word enforce is gone from both auth paths', () => {
    /*
     * The switch is deleted but its vocabulary outlives it in log lines, and a
     * log line that says "enforce" sends the next reader looking for the knob
     * that turns it off. There is no knob; the message must not imply one.
     */
    assert.doesNotMatch(server.slice(server.indexOf("app.use('/api/admin'")), /enforce/i,
        'the relay still speaks of enforcing, which implies a mode');
    assert.doesNotMatch(phpFunction(config, 'am2_api_auth'), /enforce/i,
        'the panel still speaks of enforcing, which implies a mode');
});

test('identity is never taken from the request', () => {
    /*
     * The hole itself. am2_api_identity() returned request-supplied admin_id
     * and role whenever there was no session, which is precisely the case an
     * unauthenticated caller is in.
     */
    const identity = phpFunction(config, 'am2_api_identity');
    assert.doesNotMatch(identity, /\$_GET\['admin_id'\]/,
        'the caller can still name itself in the query string');
    assert.doesNotMatch(identity, /\$_POST\['admin_id'\]/,
        'the caller can still name itself in a form field');
    assert.doesNotMatch(identity, /\$_(GET|POST)\['role'\]/,
        'the caller can still name its own role');
    assert.match(identity, /\$_SESSION\['admin_id'\]/,
        'identity no longer comes from the session either');
});

test('the guard runs from the bootstrap every endpoint already includes', () => {
    /*
     * Layer one, and the one that survives the planned Apache retirement: it
     * travels with the code rather than with a vhost directive. Every endpoint
     * requires config.php, so nothing has to be remembered per endpoint.
     */
    const bootstrap = config.slice(config.indexOf('$pdo = new PDO('));
    assert.match(bootstrap, /am2_require_identity\(\)/,
        'the bootstrap does not authenticate, so a new endpoint is born open');
});

test('the public entry list is a constant, not a setting', () => {
    /*
     * login.php must answer without a session, so the list cannot be abolished
     * -- only its ability to act as a switch. Held in code, it can only grow
     * through a commit somebody reads; held in an env file or a vhost, it grows
     * by one line on a host at 2am and nobody sees it again.
     */
    // define() rather than const: it is declared conditionally so the file can
    // be loaded by both layers, and PHP does not allow a conditional const.
    assert.match(guard, /define\('AM2_PUBLIC_ENTRY'/,
        'the public entry points are not a code constant');
    const list = guard.slice(guard.indexOf("define('AM2_PUBLIC_ENTRY'"));
    const entries = list.slice(0, list.indexOf(';')).match(/'[^']+\.php'/g) || [];
    // Exactly the two ways to obtain a session, and nothing else. Signing out
    // is not on the list: with no session there is nothing to sign out of, and
    // the refusal tells the caller precisely that.
    assert.deepEqual(entries.sort(), ["'api_login.php'", "'login.php'"],
        'the set of endpoints reachable without a session has changed');
});

test('no guard decides anything from the environment', () => {
    /*
     * The general form of the defect, rather than the one variable that caused
     * it. If no guard reads the environment at all, no new variable can be
     * introduced later that turns authentication off.
     */
    for (const name of ['am2_api_auth', 'am2_api_identity',
                        'am2_api_authz_denied', 'am2_csrf_require']) {
        assert.doesNotMatch(phpFunction(config, name), /getenv\s*\(/,
            `${name}() reads the environment, so its decision can be configured away`);
    }
    assert.doesNotMatch(phpFunction(guard, 'am2_require_identity'), /getenv\s*\(/,
        'am2_require_identity() reads the environment');
});

test('an unauthenticated caller is refused, not merely recorded', () => {
    /*
     * `log` mode wrote a REJECT-CANDIDATE line and then fell through to the
     * endpoint. The distinguishing feature of the old behaviour was a code path
     * that logged and did not exit; assert that refusing is unconditional.
     */
    const auth = phpFunction(config, 'am2_api_auth');
    assert.match(auth, /http_response_code\(401\)/, 'the panel never answers 401');
    // Nothing may stand between recording the rejection and acting on it. The
    // old shape was error_log(...) followed by `if (mode === 'enforce')`, which
    // is exactly one `if` too many.
    const between = auth.slice(auth.lastIndexOf('error_log('), auth.indexOf('http_response_code(401)'));
    assert.doesNotMatch(between, /\bif\s*\(/,
        'answering 401 is still conditional on something');
});

test('CSRF is skipped only where a token cannot exist yet', () => {
    /*
     * The old exemption was "no session, no check", which is the condition an
     * unauthenticated attacker is in -- it exempted precisely the wrong caller.
     * It cannot simply be deleted either: a POST to api_login.php has no
     * session and therefore no token to send, so deleting it outright makes the
     * first sign-in impossible.
     *
     * The exemption is therefore rewritten as the same two-name constant the
     * guard uses. Login is protected by the credential it carries; everything
     * else is protected by the token.
     */
    const csrf = phpFunction(config, 'am2_csrf_require');
    assert.doesNotMatch(csrf, /empty\(\$_SESSION\['admin_logged_in'\]\)\s*\)\s*\{\s*\n\s*return;/,
        'a request without a panel session still skips the CSRF check');
    assert.match(csrf, /AM2_PUBLIC_ENTRY/,
        'the CSRF exemption is not tied to the public entry constant');
});

test('the endpoints that rolled their own check use the shared one', () => {
    // get-users-ajax.php and fetch_logs.php each grew a private
    // admin_logged_in test, which is how they came to disagree with the other
    // eleven about what authentication means.
    for (const file of ['WebAdmin/get-users-ajax.php', 'WebAdmin/fetch_logs.php']) {
        assert.doesNotMatch(read(file), /\$_SESSION\['admin_logged_in'\]/,
            `${file} still decides for itself who is allowed in`);
    }
});

test('the guard is defined once and used by both layers', () => {
    /*
     * Layer one is config.php, which every endpoint already requires. Layer two
     * is auto_prepend_file, which catches a file that forgets to require it at
     * all. Two callers, one definition -- a second copy of the entry list is a
     * second thing to keep in step, and the pair would disagree exactly once,
     * silently, in the direction of open.
     */
    assert.match(config, /require_once __DIR__ \. '\/auth_guard\.php'/,
        'config.php does not load the shared guard');
    assert.doesNotMatch(config, /AM2_PUBLIC_ENTRY'?\s*,\s*\[/,
        'config.php keeps a second copy of the entry list');
    assert.match(prepend, /am2_require_identity\(\)/,
        'the prepended guard does not authenticate');
});

test('the prepended guard finds the panel through the running document root', () => {
    /*
     * Not a path baked into /etc. Releases are immutable directories under
     * /var/www/am2/releases and `current` is a symlink that moves; a prepend
     * pointing at one release keeps loading the old one after a deploy, or
     * loads nothing at all once it is pruned -- and a guard that fails to load
     * is a guard that is not there.
     */
    assert.match(prepend, /DOCUMENT_ROOT/,
        'the prepend does not resolve the panel from the request');
    assert.doesNotMatch(prepend, /\/var\/www\/am2\/(current|releases)/,
        'the prepend hard-codes a release path');
});

test('the prepended guard still filters server commentary out of HTML', () => {
    // It replaces a file that was doing this already. Losing it would leak
    // implementation comments into every rendered page.
    assert.match(prepend, /ob_start/, 'the output filter is gone');
    assert.match(prepend, /AM2_OUTPUT_FILTER_ACTIVE/, 'the filter guard constant is gone');
});

test('a session id the caller invented is not adopted', () => {
    /*
     * session.use_strict_mode is 0 on this host, and the panel never said
     * otherwise -- so PHP accepts whatever id a request presents and creates a
     * session under it. That is session fixation: set the cookie first, get the
     * operator to sign in, and the id you chose is now a signed-in session.
     *
     * It mattered less while identity could simply be claimed in a query
     * string; there were easier ways in. Now that the session is the only
     * authority, this is the way in, so it is set in code rather than left to a
     * php.ini that is not deployed with the application.
     */
    const boot = readFileSync(join(ROOT, 'WebAdmin/session_boot.php'), 'utf8');
    assert.match(boot, /ini_set\('session\.use_strict_mode', '1'\)/,
        'the panel adopts session ids chosen by the caller');
    // Before the session actually starts, or it is read too late to mean
    // anything. Matched on the call, not on the name: the file's own doc
    // comment mentions session_start() thirty lines earlier.
    assert.ok(boot.indexOf('use_strict_mode') < boot.indexOf('        session_start();'),
        'strict mode is set after the session has already started');
});

test('the page guard delegates rather than keeping a third copy', () => {
    /*
     * auth.php carried its own refusal: the same 401-or-redirect decision,
     * written out a second time, for the eight pages that include it. Two
     * copies of a rule are two chances to fix one of them, and the one that
     * does not get fixed is the one nobody remembers exists.
     *
     * config.php now refuses before auth.php runs at all, so this file keeps
     * only what is genuinely its own: the superadmin helpers the pages call.
     */
    const auth = readFileSync(join(ROOT, 'WebAdmin/auth.php'), 'utf8');
    assert.doesNotMatch(auth, /http_response_code\(401\)/,
        'auth.php still writes its own refusal');
    assert.doesNotMatch(auth, /header\('Location: login\.php/,
        'auth.php still writes its own redirect');
    assert.match(auth, /is_superadmin|require_superadmin/,
        'auth.php lost the helpers the pages actually call');
    // Every page happens to require config.php directly as well, so today this
    // is belt and braces. It is asserted anyway: including auth.php alone must
    // be enough, or a future page that does exactly that is born unguarded.
    assert.match(auth, /require_once __DIR__ \. '\/config\.php'/,
        'auth.php no longer pulls in the guard, so including it alone protects nothing');
});
