// Which login failures are the credential's fault, and which are not.
//
// The relay answers every login refusal with the same message type, so the
// handset had nothing to classify on and treated all of them as a verdict on
// the credential: it deleted the stored token and stopped reconnecting. One of
// those refusals is the catch-all around the whole login block, which fires on
// a database timeout -- a statement about the relay, not about the password.
// A Postgres restart could therefore sign out every handset that happened to
// be re-authenticating, permanently, until each was reached by hand.
//
// So every refusal now carries a machine-readable class, the way RFC 6749
// separates invalid_grant from temporarily_unavailable, and only the classes
// that actually accuse the credential are allowed to destroy it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

/** Codes that say "this credential is not valid" -- the handset may erase it. */
const CREDENTIAL = new Set(['token_revoked', 'credential_rejected']);
/** Codes that say "not right now" -- the credential is untouched. */
const PERMISSION = new Set(['not_permitted']);
/** Codes that say "the relay could not answer" -- retry, keep everything. */
const TRANSIENT = new Set(['server_unavailable']);

/**
 * Every login_error the relay can send, as {code, message}.
 *
 * Anchored on the send itself rather than on a line number, so a refusal added
 * later is picked up by this test instead of quietly escaping it.
 */
function refusals() {
    const found = [];
    const needle = "type: 'login_error'";
    for (let at = PROTOCOL.indexOf(needle); at !== -1; at = PROTOCOL.indexOf(needle, at + 1)) {
        const end = PROTOCOL.indexOf('}))', at);
        assert.ok(end > at, 'a login_error send is never closed');
        const site = PROTOCOL.slice(at, end);
        found.push({
            code: (site.match(/code:\s*'([a-z_]+)'/) || [])[1] ?? null,
            message: (site.match(/message:\s*"([^"]*)"/) || [])[1] ?? '',
            site,
        });
    }
    assert.ok(found.length >= 9, `expected the known refusals, found ${found.length}`);
    return found;
}

describe('login_error classification', () => {
    test('no refusal reaches the handset unclassified', () => {
        for (const refusal of refusals()) {
            assert.ok(
                refusal.code !== null,
                `a refusal carries no code, so the handset must guess: "${refusal.message}"`,
            );
        }
    });

    test('every code is one the handset knows how to act on', () => {
        const known = new Set([...CREDENTIAL, ...PERMISSION, ...TRANSIENT]);
        for (const refusal of refusals()) {
            assert.ok(
                known.has(refusal.code),
                `code '${refusal.code}' belongs to no class, and an unknown class fails closed`,
            );
        }
    });

    test('the catch-all is transient, never a verdict on the credential', () => {
        // This is the whole reason the classes exist. Any exception in the
        // login block -- bcrypt, the pool, a redeployed database -- leaves
        // through here, and it says nothing at all about the password.
        const catchAll = refusals().find((r) => /Database Timeout/.test(r.message));
        assert.ok(catchAll, 'the login catch-all no longer answers with login_error');
        assert.ok(
            TRANSIENT.has(catchAll.code),
            `the catch-all is classified '${catchAll.code}', so a database blip erases credentials`,
        );
    });

    test('only a refused credential is classified as one', () => {
        const accused = refusals().filter((r) => CREDENTIAL.has(r.code)).map((r) => r.message);
        // A wrong password and a revoked token are the credential's fault.
        // An expired subscription is the agency's, and a handset that erases
        // its token over it still needs a manual login after the admin pays.
        for (const innocent of ['inactive', 'expired', 'default channel', 'do not have access',
                                'signed in on another device', 'Database Timeout']) {
            assert.ok(
                !accused.some((m) => m.includes(innocent)),
                `"${innocent}" is treated as a bad credential, and the handset will erase it`,
            );
        }
        assert.ok(
            accused.some((m) => m.includes('Incorrect password')),
            'a wrong password is no longer classified as a credential refusal',
        );
    });
});
