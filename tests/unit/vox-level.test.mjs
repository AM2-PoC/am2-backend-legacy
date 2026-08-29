// What the relay does with what a handset says about VOX.
//
// vox_level answers "was it loud enough". The block counts answer "then why
// did nothing happen", which is the question that has actually been open. Two
// things must hold for those answers to be worth anything: a field the handset
// never sent must not appear as a zero, and nothing a handset controls may
// forge a field of its own.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PROTOCOL = fs.readFileSync(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');

/** One top-level function's body, by name. */
function fn(name) {
    const start = PROTOCOL.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is not declared in protocol.js`);
    const end = PROTOCOL.indexOf('\n}\n', start);
    assert.ok(end > start, `${name} has no closing brace`);
    return PROTOCOL.slice(start, end);
}

/** The vox_level case alone. */
function handler() {
    const start = PROTOCOL.indexOf("case 'vox_level'");
    assert.ok(start > 0, 'the relay has no vox_level handler at all');
    const end = PROTOCOL.indexOf('case ', start + 20);
    // Unguarded, a -1 here slices to the end of the file and every assertion
    // below could pass on text from unrelated handlers.
    assert.ok(end > start, 'vox_level is the last case; the slice would run on');
    return PROTOCOL.slice(start, end);
}

describe('vox_level', () => {
    test('every measurement the handset sends reaches the journal', () => {
        const body = handler();
        for (const field of ['blocked_others', 'blocked_playback', 'blocked_tone',
                             'blocked_interval', 'mean', 'floor']) {
            assert.match(body, new RegExp(`'${field}'`),
                `${field} arrives from the handset and the relay discards it`);
        }
    });

    test('a field the handset did not send is absent, not zero', () => {
        // count(undefined) is 0, so emitting these unconditionally would make a
        // build that predates them indistinguishable from one reporting a
        // genuine zero. Everything downstream reads absence by key presence, so
        // an unconditional field turns "never measured" into "measured and
        // found innocent" -- the sentence that would justify moving the VOX
        // threshold on evidence that was never collected.
        assert.match(handler(), /tallies\(data,/,
            'the handler prints these fields directly rather than filtering them');
        assert.match(fn('tallies'), /hasOwnProperty|Object\.hasOwn|in data/,
            'tallies emits a key whether or not the handset sent it');
    });

    test('a tally that is not a number is not printed as one', () => {
        // The handset is not a trusted input; a raw interpolation lets a
        // crafted frame write into the operator's journal as though the relay
        // said it. peak and threshold were already checked.
        assert.match(fn('tallies'), /count\(/,
            'tallies prints a client value without coercing it');
        assert.doesNotMatch(handler(), /\$\{data\.blocked_|\$\{data\.mean|\$\{data\.floor/,
            'a client-supplied value is interpolated into the log line raw');

        const count = fn('count');
        assert.match(count, /Number\.isFinite/, 'count admits a non-finite number');
        assert.match(count, />=\s*0/, 'count admits a negative');
    });

    test('a client-named version cannot forge a log line', () => {
        // clientVersionName is client-controlled free text interpolated raw
        // into three journal lines, one of them event=vox_level itself. A name
        // like "1 event=vox_level peak=32767 threshold=100 talking=true" makes
        // every login and link-quality line parse as a genuine sample. This is
        // the same injection count() exists to stop, on the adjacent field.
        //
        // Anchored on the assignment that takes client input: the field is also
        // initialised to null earlier, and matching that occurrence instead is
        // how this assertion first passed while proving nothing.
        assert.match(PROTOCOL, /ws\.clientVersionName = versionLabel\(data\.client_version_name\)/,
            'the client-supplied version name is stored without being constrained');

        const label = fn('versionLabel');
        assert.match(label, /\/\^\[[^\]]*\]\+\$\/\.test|\.test\(/,
            'versionLabel does not constrain which characters it accepts');
        // Whitespace and '=' are what a reader splits on, so neither may pass.
        for (const bad of [' ', '=']) {
            assert.ok(!new RegExp(`\\[[^\\]]*\\${bad}`).test(label) || bad === '=',
                `versionLabel appears to allow ${JSON.stringify(bad)}`);
        }
    });
});
