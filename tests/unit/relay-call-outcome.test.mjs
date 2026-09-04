import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The panel asks the relay to do things, and never learns whether it did.
 *
 * am2_node_call() returns void, and said so: "these callers never read the
 * body, and never have." Four operations go through it -- channel sync,
 * permission update, force logout, branch permission refresh -- and all four
 * are fire-and-forget with a two second timeout.
 *
 * For force logout that is not a small gap. The panel writes the row, so the
 * database says the unit is offline and its token is revoked; the relay is what
 * actually closes the socket. If that call fails -- relay restarting, 401, a
 * timeout under load -- the unit stays connected and keeps transmitting while
 * the panel reports success and the roster shows it offline. That is the same
 * shape as every other defect this incident turned up: a failure with nobody to
 * see it.
 *
 * Not made blocking. The two second timeout exists because the panel must not
 * wait on the relay, and that judgement stands. What changes is that an
 * unconfirmed call is reported as unconfirmed rather than as success.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const client = read('WebAdmin/node_client.php');

const phpFunction = (source, name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() is not defined`);
    return source.slice(start, source.indexOf('\n}', start));
};

test('a relay call reports whether the relay answered', () => {
    assert.doesNotMatch(phpFunction(client, 'am2_node_call').split('\n')[0], /\)\s*:\s*void/,
        'the outcome is thrown away in the signature');
    assert.match(phpFunction(client, 'am2_node_call'), /return /,
        'am2_node_call() still tells its callers nothing');
});

test('force logout says so when the relay did not confirm', () => {
    // The one where silence means a unit is still on the air.
    assert.match(phpFunction(client, 'notifyForceLogout'), /return /,
        'notifyForceLogout() cannot report a relay that never answered');
});

test('the operator is told, not just the log', () => {
    /*
     * An error_log line is read after somebody already suspects something.
     * The person who pressed the button is the one who needs to know the unit
     * may still be connected, while they are still looking at the screen.
     */
    for (const f of ['WebAdmin/api_user_access.php', 'WebAdmin/user_access.php']) {
        const src = read(f);
        assert.match(src, /=\s*notifyForceLogout\(/,
            `${f} calls notifyForceLogout() and throws the answer away`);
        assert.match(src, /msg\.relay_unconfirmed/,
            `${f} keeps the answer and still tells the operator nothing`);
    }
    // And the sentence has to exist in both catalogues, or the operator reads
    // the key.
    for (const lang of ['id', 'en']) {
        assert.match(read(`WebAdmin/lang/${lang}.php`), /'msg\.relay_unconfirmed'\s*=>/,
            `the ${lang} catalogue has no wording for an unconfirmed relay`);
    }
});

test('the two second timeout is kept', () => {
    // The panel must not block on the relay. Reading the outcome does not
    // require waiting longer for it.
    assert.match(client, /CURLOPT_TIMEOUT[^\n]*2\b|timeout['"]?\s*(=>|:)\s*2\b/,
        'the relay call lost its timeout while gaining a return value');
});
