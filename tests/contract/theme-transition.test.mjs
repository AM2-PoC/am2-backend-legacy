/**
 * Changing the theme.
 *
 * It used to be deliberately instant: every transition on the page was
 * suppressed for a frame, because a few hundred controls each easing to a new
 * colour on its own schedule reads as a sweep rather than a switch. That
 * reasoning still holds for per-element transitions -- the answer is not to
 * re-enable them, but to animate the page as one picture.
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
const shellEnd = read('partials/shell_end.php');

test('the theme change is animated as one picture, not per element', () => {
    // startViewTransition snapshots the whole page, swaps the attribute, then
    // animates between two images -- so nothing is left easing on its own.
    // Called, not merely mentioned: the feature check names it too, so looking
    // for the word alone still passes when the call itself is gone.
    assert.match(shellEnd, /document\.startViewTransition\s*\(/,
        'the theme still swaps instantly; nothing animates the change');
    // And the swap has to be what it animates -- the attribute change belongs
    // inside the callback, or the browser photographs a page that has already
    // changed and there is nothing to transition between.
    assert.match(shellEnd, /startViewTransition\(\s*apply\s*\)|startViewTransition\(\s*\(\)\s*=>/,
        'startViewTransition is called without the theme change inside it');
});

test('per-element transitions stay suppressed during the swap', () => {
    // The old reasoning is still right: without this, every bordered control
    // eases to its new colour at once underneath the snapshot.
    assert.match(css, /\.am2-theme-switching\s*\*/,
        'the suppression rule is gone, so the sweep it prevented comes back');
    assert.match(shellEnd, /am2-theme-switching/,
        'nothing applies the suppression class during the swap');
});

test('the ripple starts from the control that was pressed', () => {
    // A circle growing from nowhere in particular is decoration. Growing from
    // the toggle says the theme changed because of that button.
    assert.match(shellEnd, /getBoundingClientRect\(\)/,
        'nothing reads the toggle position, so the ripple cannot start there');
    assert.match(css, /--am2-theme-x|--am2-theme-y/,
        'the ripple origin never reaches CSS');
    assert.match(css, /clip-path/, 'nothing clips the incoming theme into a shape');
});

test('the new theme is what expands, and it draws over the old one', () => {
    // The outgoing snapshot must sit still and stay put: animating both makes
    // the two images slide against each other.
    const newRule = css.match(/::view-transition-new\(am2-theme\)\s*\{([^}]*)\}/);
    assert.ok(newRule, 'the incoming theme has no animation of its own');
    assert.match(newRule[1], /am2-theme-ripple|clip-path/,
        'the incoming theme does not expand');

    const oldRule = css.match(/::view-transition-old\(am2-theme\)\s*\{([^}]*)\}/);
    assert.ok(oldRule, 'the outgoing theme is not pinned');
    assert.match(oldRule[1], /animation:\s*none/,
        'the outgoing snapshot animates too, so the two images move against each other');
});

test('a browser without view transitions still changes theme', () => {
    // The API is the enhancement, never the mechanism. The attribute swap and
    // the cookie have to happen either way.
    assert.match(shellEnd, /document\.startViewTransition\s*\?|typeof document\.startViewTransition|!document\.startViewTransition/,
        'startViewTransition is called unguarded, so an older browser cannot change theme at all');
});

test('reduced motion gets the instant switch it asked for', () => {
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map((m) => m[1]).join('\n');
    assert.match(blocks, /am2-theme/,
        'the theme ripple still plays for someone who asked for no motion');
});
