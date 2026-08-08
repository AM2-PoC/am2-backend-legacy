/**
 * Controls have to be reachable: by a thumb, by a keyboard, and by a screen
 * reader.
 *
 * Three faults recorded during the responsive audit and deferred out of that
 * work: row actions below the size a finger can reliably hit, focus that is
 * visible on some controls and not others, and a collapsed navigation rail
 * whose links lose their only label to `display: none`.
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

/** The declaration block for an exact selector, searching selector lists. */
function ruleFor(selector) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
    }
    return null;
}

test('a chip that is a control is big enough to hit with a thumb', () => {
    // 32px was the shipped height. WCAG 2.5.8 sets 24px as the floor and 2.5.5
    // asks for 44px; a dispatch console is used one-handed in a vehicle, so the
    // larger figure is the one that matters here. The chip is also used as a
    // static badge, so the size belongs on the interactive case only.
    // Matched by shape rather than by an exact string: :is(), :where() and a
    // plain selector list all express the same thing, and pinning the test to
    // one spelling makes it fail on a rewrite that changed nothing.
    let interactive = null;
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const sel = m[1].trim();
        if (/\.am2-chip/.test(sel) && /\bbutton\b/.test(sel) && /min-height/.test(m[2])) {
            interactive = m[2];
            break;
        }
    }
    assert.ok(interactive,
        'nothing gives an interactive .am2-chip its own minimum size; a 32px row action '
        + 'is below the 44px target a thumb needs');
    const min = interactive.match(/min-height\s*:\s*(\d+(?:\.\d+)?)(px|rem)/);
    assert.ok(min, 'the interactive chip has no min-height');
    const px = min[2] === 'rem' ? Number(min[1]) * 16 : Number(min[1]);
    assert.ok(px >= 44, `interactive chips are ${px}px tall; a touch target needs at least 44px`);
});

test('the row action buttons no longer pin themselves to 32px', () => {
    // h-8 is 2rem. Left on the element it wins over the component's min-height
    // by being a utility on the same element, so the fix has to remove it.
    const src = read('users.php');
    const cell = src.match(/data-cell="actions"[\s\S]*?\n(?=\s*<\/tr)/)[0];
    assert.doesNotMatch(cell, /\bh-8\b/,
        'a row action still sets h-8 (32px), which overrides the chip minimum');
});

test('every control shows where the keyboard is', () => {
    // Focus was styled on a few components and left to the browser default on
    // the rest -- and the default is invisible against this palette on several
    // of them. One rule for anything focusable is the only version of this that
    // stays true as pages are added.
    const focus = ruleFor(':focus-visible')
        ?? ruleFor('a:focus-visible, button:focus-visible, input:focus-visible')
        ?? ruleFor('*:focus-visible');
    assert.ok(focus, 'there is no baseline :focus-visible rule');
    assert.match(focus, /outline\s*:/, 'the focus rule does not set an outline');
    assert.doesNotMatch(focus, /outline\s*:\s*(none|0)\b/,
        'the baseline focus rule removes the outline rather than drawing one');
    assert.match(focus, /outline-offset\s*:/,
        'no outline-offset, so the ring sits on the control edge and is hard to see');
});

test('focus is never removed without something drawn in its place', () => {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*outline\s*:\s*(?:none|0)\b[^}]*)\}/g)) {
        const selector = m[1].trim();
        const body = m[2];
        if (!/:focus/.test(selector)) continue;      // not a focus rule at all
        assert.match(body, /box-shadow|border-color|background/,
            `"${selector}" removes the focus outline and draws nothing instead`);
    }
});

test('a collapsed rail link still says what it is', () => {
    // In rail mode the label is display:none, which takes it out of the
    // accessibility tree as well as off the screen -- so the link announces as
    // its icon and nothing else.
    const shell = read('partials/shell.php');
    const link = shell.match(/<a href="<\?= \$href \?>"[\s\S]*?<\/a>/);
    assert.ok(link, 'the nav item markup changed shape');
    assert.match(link[0], /aria-label|title=/,
        'a rail link has no accessible name of its own; when .am2-rail-hide is '
        + 'display:none the label is gone from the accessibility tree too');
});
