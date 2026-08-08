/**
 * How small the smallest type is allowed to be.
 *
 * Measured on users.php: 190 elements rendering at 9px and 78 at 10px. Most of
 * them are uppercase mono with 0.1em of tracking, which is the combination that
 * reads as blurred rather than merely small -- the letterforms are thin, the
 * spacing pulls them apart, and there is no x-height left to resolve.
 *
 * This is a dispatch console read for a whole shift, often on a laptop panel at
 * arm's length. The floor is set here rather than left to each page.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const read = (p) => readFileSync(join(WEBADMIN, p), 'utf8');

/** Every page and partial that renders markup. */
function markupFiles() {
    const out = [];
    for (const f of readdirSync(WEBADMIN)) {
        if (f.endsWith('.php')) out.push(f);
    }
    for (const f of readdirSync(join(WEBADMIN, 'partials'))) {
        if (f.endsWith('.php')) out.push(`partials/${f}`);
    }
    return out;
}

test('nothing is set below 10px', () => {
    // 9px was the chip and badge size. At that size the uppercase mono this
    // console uses for identifiers stops being legible and starts being a
    // texture -- and identifiers are the one thing that must never be misread.
    const offenders = [];
    for (const f of markupFiles()) {
        const hits = (read(f).match(/text-\[9px\]|text-\[8px\]|text-\[7px\]/g) ?? []).length;
        if (hits) offenders.push(`${f} (${hits})`);
    }
    assert.deepEqual(offenders, [],
        `type below 10px still in use: ${offenders.join(', ')}`);
});

test('the chip component sets its own size, above the old floor', () => {
    const css = read('asset/css/tailwind.src.css');
    const chip = css.match(/\.am2-chip\s*\{([^}]*)\}/);
    assert.ok(chip, '.am2-chip is gone');
    const size = chip[1].match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    assert.ok(size, 'the chip has no font-size of its own');
    assert.ok(Number(size[1]) >= 10,
        `the chip renders at ${size[1]}px; below 10 the uppercase mono blurs`);
});

test('the smallest text keeps enough weight to hold its shape', () => {
    // Thin strokes at small sizes are what actually reads as blur on a laptop
    // panel. The mono face has a medium; the label sizes use it.
    const css = read('asset/css/tailwind.src.css');
    assert.match(css, /IBMPlexMono-Medium/,
        'the medium weight is not loaded, so small mono text has only the regular to use');
});

test('body text is not smaller than the browser default suggests', () => {
    // 14px is the working size for a table this dense; anything under it in a
    // data cell is a value someone has to lean in for.
    const users = read('users.php');
    const cells = users.match(/<td[^>]*class="[^"]*text-\[1[0-3]px\][^"]*"/g) ?? [];
    assert.deepEqual(cells, [],
        `a data cell renders below 14px: ${cells.join(', ')}`);
});

test('the header controls answer a pointer the way the chips do', () => {
    /*
     * The language pair, the theme toggle and the account button only changed
     * their border to a neutral on hover, while every chip in a roster takes
     * the brand colour. Same kind of control, two different answers to the same
     * gesture.
     */
    const shell = read('partials/shell.php');
    const controls = shell.match(/class="[^"]*(?:grid h-11 w-11|hs-dropdown-toggle)[^"]*"/g) ?? [];
    assert.notEqual(controls.length, 0, 'the header controls changed shape');

    for (const c of controls) {
        if (/border-brand/.test(c)) continue;          // already the active state
        // Bare icon buttons -- the drawer's close and the rail's open -- have
        // no border to colour, and answer with a background instead. The
        // contract here is about the bordered controls that sit beside the
        // chips and were answering differently from them.
        if (!/border-edge/.test(c)) continue;
        assert.match(c, /hover:border-brand|hover:text-brand/,
            `a header control hovers to a neutral while the chips hover to brand: ${c.slice(0, 70)}`);
    }
});
