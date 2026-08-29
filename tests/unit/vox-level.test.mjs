// The relay must carry the block counts, or the handset counted for nothing.
//
// vox_level answers "was it loud enough". The counts answer "then why did
// nothing happen", which is the question that has actually been open. A
// handler that drops them turns a measurement back into a guess.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

/** The vox_level case alone. */
function handler() {
    const start = PROTOCOL.indexOf("case 'vox_level'");
    assert.ok(start > 0, 'the relay has no vox_level handler at all');
    const end = PROTOCOL.indexOf('case ', start + 20);
    return PROTOCOL.slice(start, end);
}

describe('vox_level', () => {
    test('every block count reaches the journal', () => {
        const body = handler();
        for (const field of ['blocked_others', 'blocked_playback', 'blocked_tone', 'blocked_interval']) {
            assert.match(body, new RegExp(field),
                `${field} arrives from the handset and the relay discards it`);
        }
    });

    test('a count that is not a number is not printed as one', () => {
        // The client is not a trusted input. Every other numeric field here is
        // put through Number() and checked; these must be too, or a crafted
        // frame writes arbitrary text into the operator's journal.
        const body = handler();
        assert.doesNotMatch(body, /\$\{data\.blocked_/,
            'a client-supplied value is interpolated into the log line raw');

        // Bound to the block fields specifically. A check that only asks
        // whether the word "Number" appears anywhere in the handler passes on
        // the coercion already there for peak and threshold, which is how an
        // assertion goes green without the code it is meant to be about.
        assert.match(body, /count\(data\.blocked_others\)/,
            'the block counts are printed without being coerced to a number');
    });
});
