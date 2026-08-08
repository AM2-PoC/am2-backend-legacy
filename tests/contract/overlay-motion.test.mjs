/**
 * How a dialogue arrives, and how it leaves.
 *
 * Every overlay in this panel appeared instantly: measured transition-duration
 * 0s and transform none on both the centred modal and the bottom sheet. A
 * dialogue that is simply there gives no sense of where it came from, and at
 * the sheet's size that reads as the page having been replaced.
 *
 * Also here: the sheet is markup that only exists below lg, so widening the
 * window past lg while it is open used to leave its backdrop behind -- the
 * panel hid, the scrim did not, and the page was covered by something with no
 * visible owner.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const read = (p) => readFileSync(join(WEBADMIN, p), 'utf8');
const css = read('asset/css/tailwind.src.css').replace(/\/\*[\s\S]*?\*\//g, '');
const users = read('users.php');

/** Declaration block for a selector, matched inside selector lists. */
function ruleFor(selector) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
    }
    return null;
}

/** Any rule whose selector contains all of these fragments. */
function ruleContaining(...fragments) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const sel = m[1];
        if (fragments.every((f) => sel.includes(f))) return { selector: sel.trim(), body: m[2] };
    }
    return null;
}

/** The declarations of a named @keyframes block. */
function keyframes(name) {
    const m = css.match(new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
    return m ? m[1] : null;
}

test('a centred dialogue arrives rather than appears', () => {
    // An animation rather than a transition, and that is load-bearing: Preline
    // removes `hidden` and adds `opened` inside one frame, so a transition has
    // no earlier state to run from -- measured, the opacity went 0 to 1 between
    // consecutive frames. An animation carries its own `from`.
    const rule = ruleContaining('.hs-overlay.opened', '[data-am2-panel]');
    assert.ok(rule, 'nothing animates the dialogue panel when it opens');
    assert.match(rule.body, /animation/, 'the opened state declares no animation');

    const frames = keyframes('am2-dialog-in');
    assert.ok(frames, 'no am2-dialog-in keyframes');
    assert.match(frames, /opacity:\s*0/, 'the dialogue does not fade in');
    assert.match(frames, /translateY|scale/,
        'the dialogue only fades; with no travel there is nothing to say where it came from');
});

test('the bottom sheet rises from the edge it is attached to', () => {
    // It is docked to the bottom of the screen, so it comes from below.
    const rule = ruleContaining('#am2-unit-sheet.opened', '[data-am2-panel]');
    assert.ok(rule, 'the sheet has no animation of its own');

    const frames = keyframes('am2-sheet-in');
    assert.ok(frames, 'no am2-sheet-in keyframes');
    const from = frames.match(/from\s*\{[^}]*translateY\(\s*(-?[\d.]+)(%|px|rem)/);
    assert.ok(from, 'the sheet does not travel vertically');
    assert.ok(Number(from[1]) > 0,
        `the sheet starts at translateY(${from[1]}${from[2]}); a bottom sheet starts below, not above`);
});

test('motion on a dialogue is dropped under reduced motion', () => {
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map((m) => m[1]).join('\n');
    assert.match(blocks, /data-am2-panel/,
        'the dialogue keeps its travel under reduced motion');
});

test('the mobile sheet cannot leave its backdrop behind when the window grows', () => {
    // lg:hidden takes the panel away; Preline's backdrop is a child of body and
    // knows nothing about the breakpoint, so it stayed -- opacity 1, body still
    // scroll-locked, and nothing on screen to explain it.
    assert.match(users, /matchMedia\(|innerWidth|ResizeObserver/,
        'nothing watches the viewport, so a sheet open at mobile width survives into desktop');
    assert.match(users, /HSOverlay\?\.\s*close|HSOverlay\.close/,
        'nothing closes the sheet through Preline, which is what removes the backdrop');
});

test('the whole row opens the sheet, not just the chevron', () => {
    // The trigger measured 28x36 inside a 356px row: a thumb has to find a
    // 28px target to see a unit's detail.
    const cell = users.match(/data-cell="unit"[\s\S]*?<\/td>/)[0];
    assert.match(cell, /data-open-sheet/, 'the unit cell no longer carries a sheet trigger');
    assert.match(users, /data-sheet-row|data-open-sheet[^>]*class="[^"]*\babsolute\b|::before/,
        'the tap area is still the chevron alone; the row itself has to be the target');
});

test('anything that acts on a click says so with the cursor', () => {
    // Buttons default to cursor:default in every browser. Links do not, which
    // is why the nav read as clickable and none of the controls did.
    const rule = ruleFor('button:not(:disabled)')
        ?? ruleFor('button:not([disabled])')
        ?? ruleContaining('button', 'cursor')?.body;
    const body = typeof rule === 'string' ? rule : rule?.body;
    assert.ok(body, 'nothing sets a pointer cursor on buttons');
    assert.match(body, /cursor\s*:\s*pointer/, 'the rule does not set cursor: pointer');
});

test('a warn chip stays warn on hover', () => {
    // .am2-chip:enabled:hover paints every chip's border with the brand colour.
    // On the yellow chips that turned a warning blue under the pointer, which
    // says the state changed when nothing did.
    const hover = ruleFor('.am2-chip:enabled:hover');
    if (hover) {
        assert.doesNotMatch(hover, /border-color\s*:\s*var\(--color-primary\)\s*;?\s*$/,
            'every enabled chip still hovers to the brand colour regardless of what it means');
    }
    assert.match(css, /am2-chip[^{]*hover[^{]*\{[^}]*currentColor|--am2-chip-hover/,
        'nothing makes the hover border follow the chip’s own colour');
});
