// A token that nobody has used for long enough stops being one.
//
// Revocation is the security boundary that makes a permanently stored token
// acceptable: a lost handset costs a click, not a password change for the
// person. But revocation is somebody noticing and acting. A radio that quietly
// disappears -- left in a vehicle, in a drawer, sold with the phone -- is never
// reported, and its token stays valid for as long as the table holds it.
//
// So there is a backstop that needs nobody to notice. last_used_at is already
// written on every token login, so a handset in daily use never approaches the
// limit; only one that has stopped being used does.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DB = fs.readFileSync(new URL('../../server/lib/db.js', import.meta.url), 'utf8');

/** userForDeviceToken alone. */
function verifier() {
    const start = DB.indexOf('const userForDeviceToken');
    assert.ok(start > 0, 'nothing verifies a device token any more');
    const end = DB.indexOf('\n};', start);
    assert.ok(end > start, 'the verifier has no end');
    return DB.slice(start, end);
}

describe('device token age', () => {
    test('an unused token stops being accepted', () => {
        assert.match(verifier(), /last_used_at/,
            'the verifier never looks at when the token was last used, so a '
            + 'handset that quietly disappeared keeps a working credential');
    });

    test('the limit is a named constant, not a number in a query', () => {
        assert.match(DB, /TOKEN_(MAX_IDLE|IDLE|AGE)[A-Z_]*\s*=/,
            'the limit is buried in a query where nobody will find it to change it');
    });

    test('the limit is measured in days and is not tiny', () => {
        // A handset kept as a spare must still start. Anything measured in
        // hours would make the backstop the thing that takes radios off air.
        const match = DB.match(/TOKEN_(?:MAX_IDLE|IDLE|AGE)[A-Z_]*\s*=\s*(\d+)/);
        assert.ok(match, 'no limit is declared');
        assert.ok(Number(match[1]) >= 14,
            `the idle limit is ${match[1]}; a spare radio left in a drawer would `
            + 'stop working before anyone picked it up');
    });

    test('using a token keeps it alive', () => {
        assert.match(verifier(), /UPDATE public\.device_tokens SET last_used_at/,
            'nothing refreshes the stamp, so every token expires on a fixed '
            + 'schedule regardless of use');
    });

    test('an expired token is refused rather than repaired', () => {
        const body = verifier();
        const at = body.search(/last_used_at[\s\S]{0,200}?interval/i);
        assert.ok(at >= 0, 'the age is not expressed as an interval the database can compare');
        assert.match(body, /return null/,
            'an expired token does not end in a refusal');
    });
});
