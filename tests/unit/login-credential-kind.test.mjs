// Which credential a handset actually presented.
//
// "The session is not being kept after an update" cannot be answered from the
// server, and that is the whole problem. event=client_login records the
// version and nothing about the credential, and commitLoginSession issues a
// fresh token on every login -- including one that arrived by token, which it
// rotates -- so device_tokens.issued_at resets either way and the table cannot
// tell the two apart either.
//
// The relay already knows: sourceTokenHash is set exactly when the login came
// from a stored token. Recording it turns a question that was being answered
// by guesswork into one line of evidence.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

/** The client_login line and the statement that builds it. */
function loginLog() {
    const at = PROTOCOL.indexOf('event=client_login');
    assert.ok(at > 0, 'the relay no longer records a successful login');
    const start = PROTOCOL.lastIndexOf('console.log', at);
    const end = PROTOCOL.indexOf(');', at);
    assert.ok(end > start, 'the login log line is not a single statement any more');
    return PROTOCOL.slice(start, end);
}

describe('client_login', () => {
    test('it says which credential the handset presented', () => {
        assert.match(loginLog(), /auth=/,
            'a login by stored token and a login by typed password are recorded '
            + 'identically, so "the session was not kept" cannot be told from '
            + '"the session was kept and refused"');
    });

    test('the answer comes from what was presented, not from what was issued', () => {
        // A token is issued on every login, so anything derived from the issue
        // would answer "token" always.
        assert.match(loginLog(), /presentedToken|sourceTokenHash/,
            'the credential kind is derived from something other than the '
            + 'credential that was presented');
    });

    test('both kinds are distinguishable', () => {
        const line = loginLog();
        assert.match(line, /'token'|"token"/, 'a token login is not named');
        assert.match(line, /'password'|"password"/, 'a password login is not named');
    });
});
