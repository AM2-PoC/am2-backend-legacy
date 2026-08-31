// Which handset, on which Android, signed in.
//
// The staging acceptance plan asks for evidence on API 16, 19, 25, 26 and 34
// with one APK digest. Nothing on the login record could say which API had
// actually signed in: client_login carried the version and the credential and
// stopped there. "It passed on KitKat" was a sentence somebody had to be
// believed about, which is not what an acceptance document is for.
//
// update_refused already carries sdk_int and device, because a refusal without
// them is unactionable. A successful login without them is unprovable, which
// is the same problem wearing better clothes.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

function loginLog() {
    const at = PROTOCOL.indexOf('event=client_login');
    assert.ok(at > 0, 'the relay no longer records a successful login');
    const start = PROTOCOL.lastIndexOf('console.log', at);
    const end = PROTOCOL.indexOf(');', at);
    assert.ok(end > start, 'the login log line is not a single statement any more');
    return PROTOCOL.slice(start, end);
}

describe('client_login', () => {
    test('it records which Android signed in', () => {
        assert.match(loginLog(), /client_sdk_int/,
            'nothing says which API level signed in, so acceptance across five '
            + 'of them cannot be evidenced from the record');
    });

    test('it records which handset signed in', () => {
        assert.match(loginLog(), /device=/,
            'nothing distinguishes one handset from another in a fleet');
    });

    test('free text from the handset cannot forge a journal line', () => {
        const body = loginLog();
        assert.doesNotMatch(body, /\$\{data\.client_device\}/,
            'the device name is interpolated raw, so a crafted value writes its own line');
        assert.match(body, /versionLabel|label|sanit/i,
            'nothing constrains the text a handset may put in the journal');
    });

    test('an absent field is not reported as a value', () => {
        // A build that predates this sends neither. Printing 0 or "unknown"
        // as though measured is what count(undefined) did to the VOX numbers.
        assert.match(loginLog(), /tallies|hasOwnProperty|=== undefined|\?\?/,
            'a handset that never sent these appears to have reported them');
    });
});
