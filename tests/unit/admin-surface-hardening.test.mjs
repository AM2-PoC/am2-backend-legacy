import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two different holes, hardened two different ways.
 *
 * The first was missing authentication: ten /api/admin routes reachable from
 * the internet with no credential. A key now gates them and six that nothing
 * called are gone. What is left is the posture around that key -- and a
 * credential control that fails *open* when nobody configures it is not a
 * control, it is a default waiting to be forgotten.
 *
 * The second is a genuine IDOR, and it is in the panel rather than the relay.
 * `update_location.php` passes `am2_api_auth()` -- which accepts any logged-in
 * panel session -- and then writes latitude, longitude and status='online' for
 * whatever `user_id` the request names. No check that the caller is that unit
 * or owns it. Any branch admin could place any unit, in any branch, anywhere on
 * the live map, and mark an offline one online.
 *
 * Nothing calls it. The handset reports position over the WebSocket, as
 * `update_location` in the protocol, not over this endpoint. It is a dead write
 * path that outlived its purpose -- the same shape as the six relay routes and
 * the APK upload before them.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const server = read('server/server.js');
const config = read('WebAdmin/config.php');

test('the credential control fails closed when nobody configures it', () => {
    /*
     * The mode defaulted to 'log', which records and lets the request through.
     * That was right while the callers were being migrated; it is wrong now
     * that they are migrated, because the safe state must be the one you get by
     * doing nothing.
     */
    const mode = server.slice(server.indexOf('API_AUTH_MODE ='), server.indexOf('API_AUTH_MODE =') + 200);
    assert.doesNotMatch(mode, /\|\|\s*'log'/,
        "an unconfigured relay lets unauthenticated admin calls through");
    assert.match(mode, /'enforce'/);
});

test('the relay does not offer itself beyond the host by default', () => {
    // nginx reaches it on 127.0.0.1 and so does the panel. Listening on every
    // interface put the admin surface one firewall rule away from the internet,
    // and firewall rules are edited by people in a hurry.
    assert.match(server, /AM2_BIND_ADDRESS/,
        'the listen address cannot be constrained');
    // Applied through the argument list, because an address may not be passed
    // at all: unset must keep Node's own default of `::` with dual-stack.
    // Defaulting to '0.0.0.0' instead looked equivalent and bound IPv4 only,
    // which failed the container healthcheck asking for `localhost`.
    assert.match(server, /listenArgs\s*=\s*BIND_ADDRESS\s*\?/,
        'the bind address is not applied to listen()');
    assert.match(server, /server\.listen\(\.\.\.listenArgs/,
        'listen() does not use the configured address');
    assert.doesNotMatch(server, /AM2_BIND_ADDRESS \|\| '0\.0\.0\.0'/,
        "defaulting to 0.0.0.0 drops IPv6 and breaks a localhost healthcheck");
});

test('neither side takes the key from a URL', () => {
    // A query string is copied into proxy access logs, browser history and the
    // Referer of the next request. Node stopped accepting it; PHP had the same
    // two forms.
    assert.doesNotMatch(server, /req\.query\.api_key/);
    const auth = config.slice(config.indexOf('function am2_api_auth('));
    const body = auth.slice(0, auth.indexOf("\n}"));
    assert.doesNotMatch(body, /\$_GET\['api_key'\]/,
        'the panel accepts its shared key in a query string');
    assert.doesNotMatch(body, /\$_POST\['api_key'\]/,
        'the panel accepts its shared key in a form field');
    assert.match(body, /HTTP_X_AM2_API_KEY/);
});

test('the panel fails closed when nobody configures the mode either', () => {
    // Node was not the only side defaulting to 'log'. Two guards in the panel
    // read the same variable and made the same choice.
    assert.doesNotMatch(config, /AM2_API_AUTH_MODE'\)\s*\?:\s*'log'/,
        'an unconfigured panel lets an unauthenticated caller through');
});

test('no panel endpoint writes a location for a unit the caller names', () => {
    /*
     * The IDOR itself. Asserted by absence across the whole panel, so a second
     * copy of this endpoint cannot appear under another name.
     */
    assert.ok(
        !existsSync(join(ROOT, 'WebAdmin/update_location.php')),
        'update_location.php still lets any authenticated caller place any unit',
    );
    const offenders = readdirSync(join(ROOT, 'WebAdmin'))
        .filter((f) => f.endsWith('.php'))
        .filter((f) => {
            const src = read(`WebAdmin/${f}`);
            if (!/UPDATE\s+public\.users[\s\S]{0,400}?(latitude|longitude)/i.test(src)) return false;
            return !/am2_admin_owns_user|admin_id\s*=\s*[:?$]/.test(src);
        });
    assert.deepEqual(offenders, [],
        `these write a unit's position without checking who asked: ${offenders.join(', ')}`);
});
