// Why a handset could not take an update, recorded where it can be read.
//
// A refusal lived in a Toast on a radio in somebody's hand. A handset that
// cannot update is therefore a handset nobody can diagnose, and one spent a
// day being blamed on the build it was refusing while every value checkable
// off the device -- certificate, digest, served bytes, trusted signer -- was
// proven identical to the build already installed.
//
// vox_level is the precedent. Three rounds of argument about VOX ended the
// moment the handset reported its own numbers instead of being asked about
// them. The same rules apply here: a field the handset did not send must not
// appear as a zero, and nothing a handset controls may forge a line.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

function handler() {
    const start = PROTOCOL.indexOf("case 'update_refused'");
    assert.ok(start > 0, 'the relay discards what a refused handset reports');
    const end = PROTOCOL.indexOf('case ', start + 20);
    assert.ok(end > start, 'update_refused is the last case; the slice would run on');
    return PROTOCOL.slice(start, end);
}

describe('update_refused', () => {
    test('it records the reason and the two versions that disagreed', () => {
        const body = handler();
        for (const field of ['reason', 'offered', 'installed']) {
            assert.match(body, new RegExp(`'${field}'|${field}=`),
                `${field} arrives from the handset and the relay drops it`);
        }
    });

    test('the device that refused is identified', () => {
        const body = handler();
        assert.match(body, /sdk_int|device/,
            'nothing says which Android version refused, which is the first '
            + 'question asked of a signing or archive failure');
    });

    test('free text from the handset cannot forge a journal line', () => {
        const body = handler();
        assert.doesNotMatch(body, /\$\{data\.reason\}/,
            'the reason is interpolated raw, so a crafted value writes its own line');
        assert.match(body, /label|sanit|versionLabel|safe/i,
            'nothing constrains the text a handset may put in the journal');
    });

    test('it is not logged for a socket with no identity', () => {
        assert.match(handler(), /ws\.sessionUser/,
            'an unauthenticated socket can write lines naming no one');
    });
});
