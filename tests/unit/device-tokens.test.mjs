// A credential the operator can take back.
//
// The field app stores the operator's password so it can sign in again after a
// restart. That password is the same one they use everywhere else, it works
// from any device, and losing a handset means changing it for the person
// rather than for the phone. Encrypting it at rest helps on the handsets that
// have a keystore and does nothing on the ones that do not -- minSdk here is
// 16 -- and in neither case does it make the credential revocable.
//
// A token is per device and can be deleted. What is kept here is its SHA-256,
// for the same reason the password column holds a bcrypt hash: a copy of the
// table has to be a copy of nothing usable.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { newToken, hashToken, TOKEN_BYTES } = createRequire(import.meta.url)('../../server/lib/device-tokens.js');

describe('device tokens', () => {
    test('a token is long enough that guessing is not a strategy', () => {
        // 32 bytes. The relay accepts any token that hashes to a stored row, so
        // its only defence against being guessed is how many there are.
        assert.ok(TOKEN_BYTES >= 32, `${TOKEN_BYTES} bytes is not enough entropy`);
        assert.equal(newToken().length, TOKEN_BYTES * 2);
        assert.match(newToken(), /^[0-9a-f]+$/);
    });

    test('two tokens are never the same', () => {
        const seen = new Set(Array.from({ length: 500 }, () => newToken()));
        assert.equal(seen.size, 500, 'the generator repeats itself');
    });

    test('what is stored cannot be presented', () => {
        // The row holds a digest. If the digest were the token, a database
        // copy would be a set of working logins -- which is the whole thing
        // this is meant to stop.
        const token = newToken();
        const stored = hashToken(token);
        assert.notEqual(stored, token);
        assert.match(stored, /^[0-9a-f]{64}$/);
    });

    test('the same token always hashes the same way', () => {
        const token = newToken();
        assert.equal(hashToken(token), hashToken(token));
    });

    test('a different token hashes differently', () => {
        assert.notEqual(hashToken(newToken()), hashToken(newToken()));
    });
});

/*
 * And the login that hands one out.
 *
 * Asserted on the source because app_login needs a database in front of it.
 * What matters is the shape: a password may be exchanged for a token once, a
 * token is accepted afterwards, and neither path lets the other through.
 */
import { readFileSync } from 'node:fs';

const relay = readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');
const login = relay.slice(relay.indexOf("case 'app_login'"), relay.indexOf("case 'update_location'"));

describe('signing in', () => {
    test('a token is accepted in place of a password', () => {
        assert.match(login, /userForDeviceToken\(/,
            'the only way in is still the password itself');
    });

    test('a successful login hands one back', () => {
        assert.match(login, /issueDeviceToken\(/,
            'nothing issues a token, so the handset has nothing to keep but the password');
    });

    test('the password is still checked when a password is what arrived', () => {
        assert.match(login, /bcrypt\.compare\(/,
            'password logins stopped being verified');
    });

    test('a token that is not ours is refused, not ignored', () => {
        // Falling through to "no user" would leave a rejected token looking
        // like an anonymous connection rather than a failed sign-in.
        assert.match(login, /login_error/,
            'a refused credential produces no error for the handset to act on');
    });
});
