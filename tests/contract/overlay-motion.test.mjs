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

test('the scrim is hidden from the moment the overlay is shown, not from `opened`', () => {
    /*
     * The pulse was never the panel: the overlay element carries the dark
     * backdrop itself (bg-slate-950/50) and Preline reveals it a frame before
     * it adds `opened`. Measured: at 2ms the scrim was already opacity 1 across
     * the viewport while the panel sat at 0, and stayed that way ~80ms. A dark
     * screen with nothing on it, then a dialogue.
     *
     * So it is the overlay that has to start hidden. Two rules match the
     * selector -- the resting state and its cancellation under reduced motion --
     * so the search is for one that actually hides.
     */
    const hides = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((m) => /\.hs-overlay:not\(\.hidden\)\s*\{/.test(m[0]))
        .filter((m) => /opacity:\s*0\s*[;}]/.test(m[2]));
    assert.notEqual(hides.length, 0,
        'the overlay is painted before it is animated, so the scrim flashes over the page '
        + 'while the dialogue is still invisible');
    assert.match(css, /@keyframes\s+am2-scrim-in/, 'the scrim has no entrance of its own');
});

test('every panel plays an exit, and something holds it open long enough to see', () => {
    // Preline sets `hidden` -- display:none -- in the frame it decides to
    // close, which cancels any animation outright. Nothing left by CSS alone.
    for (const name of ['am2-scrim-out', 'am2-dialog-out', 'am2-sheet-out']) {
        assert.match(css, new RegExp(`@keyframes\\s+${name}`), `no ${name} keyframes`);
    }
    assert.match(css, /\.am2-closing/, 'nothing marks an element as leaving');

    const exit = read('asset/js/src/am2-exit.js');
    assert.match(exit, /getAnimations\(\)/,
        'the helper does not wait on the animation, so the class comes off before it plays');
    assert.match(exit, /classList\.remove\(/, 'the closing class is never released');
});

test('the bulk bar arrives like the sheet it sits beside', () => {
    // It is docked to the same edge and was toggled with `hidden` alone, so it
    // blinked into place while every other panel on the page travelled.
    const rule = ruleContaining('[data-bulk-bar]');
    assert.ok(rule, 'the bulk bar has no motion rule');
    assert.match(rule.body, /animation/, 'the bulk bar still appears instantly');
});

test('the mobile drawer slides, and its scrim leaves with it', () => {
    // The drawer cannot transition: Preline waits on transitionend before
    // destroying the backdrop, and a transition that never fires strands the
    // scrim over the page. An animation is not a transition.
    assert.match(css, /#am2-sidebar\.opened[^{]*\{[^}]*animation/,
        'the drawer appears in a single frame with no travel');
    assert.match(css, /@keyframes\s+am2-drawer-in/, 'no am2-drawer-in keyframes');
    assert.match(css, /#am2-sidebar\s*\{\s*transition-property:\s*none/,
        'the drawer transitions again, which is what strands Preline’s backdrop');
    // Measured: 3ms to hidden, 149ms until the scrim cleared -- a sixth of a
    // second of dimmed page with nothing on it.
    assert.match(css, /\.hs-overlay-backdrop[^{]*\{[^}]*transition-duration/,
        'the backdrop fades on its own schedule, so it outlives the drawer');
});

test('every page with a roster gets the same sheet treatment', () => {
    // users.php was fixed alone the first time. These four carry the same
    // roster, the same sheet and the same chevron.
    for (const page of ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php']) {
        const src = read(page);
        assert.match(src, /data-sheet-row/,
            `${page} still opens its sheet from the chevron alone`);
        assert.match(src, /matchMedia\('\(min-width: 1024px\)'\)/,
            `${page} can strand its sheet backdrop when the window grows past lg`);
    }
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
