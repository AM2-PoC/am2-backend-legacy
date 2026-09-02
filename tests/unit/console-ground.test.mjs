import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The empty ground beside the sidebar, and the foot of the sidebar itself.
 *
 * Both are the login panel's geometry at a lower volume, so the two screens
 * read as one product. What is pinned here is the part that was got wrong
 * first and would be got wrong again.
 *
 * The ground is the body's own background, not a layer over it. As a layer it
 * drew nothing: body paints an opaque background, and z-index -10 paints
 * before that. Positive z-index would have shown it and covered the console
 * instead. As a background there is no painting order to argue with.
 *
 * The foot takes the sweep rather than the grid. The grid was tried and read as
 * a table someone had left behind, running straight through the build stamp,
 * and a second grid under the console's own is a pattern rather than a
 * signature.
 *
 * Measured in a browser: over a card the topmost element is the card, over the
 * ground it is the body, and the page does not scroll sideways. In the rail the
 * relay dot stays and the words go.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const src = read('WebAdmin/asset/css/tailwind.src.css');
const legacy = read('WebAdmin/asset/css/am2-ui.css');
const shell = read('WebAdmin/partials/shell.php');
const shellEnd = read('WebAdmin/partials/shell_end.php');
const bundleCss = read('WebAdmin/asset/css/am2-tailwind.css');

test('the ground is the body background, not a layer over it', () => {
    const body = src.slice(src.indexOf('\nbody {'), src.indexOf('\nbody {') + 900);
    assert.match(body, /background-size:\s*auto, 56px 56px, 56px 56px/,
        'the grid is not on the body, so it is a layer with a painting order to lose to');
    assert.match(body, /background-attachment: fixed/, 'the ground scrolls with the document');
    assert.doesNotMatch(src, /am2-console-geometry|am2-console-grid/,
        'the abandoned layer is back');
    assert.doesNotMatch(shell, /am2-console/, 'the shell still emits markup nothing styles');
});

test('the legacy sheet defends the colour without erasing the ground', () => {
    // `background: … !important` reset every layer and outranked the image,
    // because that sheet loads first and !important beats source order.
    const body = legacy.slice(legacy.indexOf('\nbody {'), legacy.indexOf('\nbody {') + 700);
    assert.match(body, /background-color: var\(--color-bg\) !important/);
    assert.doesNotMatch(body, /\n\s*background: var\(--color-bg\) !important/,
        'the shorthand is back and the ground is erased again');
});

test('the grid is kept out of the busiest band', () => {
    // The top of every page is a header, a status strip and the first card.
    // The status strip is translucent, so a grid behind it would show through.
    const body = src.slice(src.indexOf('\nbody {'), src.indexOf('\nbody {') + 900);
    assert.match(body, /linear-gradient\(to bottom,\s*\n?\s*var\(--color-bg\) 0%/,
        'nothing covers the grid where the page is densest');
});

test('the sidebar foot is one line, not a second grid', () => {
    const foot = src.slice(src.indexOf('.am2-rail-geometry {'), src.indexOf('@media (prefers-contrast: more)'));
    assert.match(foot, /rotate\(-34deg\)/, 'the sweep no longer matches the login mark');
    assert.doesNotMatch(foot, /background-size: 28px/, 'the grid that read as a stray table is back');
});

test('the hairline is a token, in both themes', () => {
    for (const theme of ['light', 'dark']) {
        const at = legacy.indexOf(theme === 'light' ? '[data-theme="light"] {' : '[data-theme="dark"],');
        const block = legacy.slice(at, at + 1600);
        assert.match(block, /--color-console-line: color-mix/, `${theme} has no console line token`);
    }
});

test('scenery goes when contrast is asked for', () => {
    const block = src.slice(src.indexOf('@media (prefers-contrast: more)'),
                            src.indexOf('@media (prefers-contrast: more)') + 260);
    assert.match(block, /body \{ background-image: none; \}/);
    assert.match(block, /\.am2-rail-geometry \{ display: none; \}/);
});

test('the foot says whether the relay answers, and which build this is', () => {
    const foot = shell.slice(shell.indexOf('<!--\n        The foot.'), shell.indexOf('</aside>'));
    assert.match(foot, /data-relay-dot/);
    assert.match(foot, /am2_release_build\(\)/);
    assert.match(foot, /e\('nav\.build'\)/);
    // In the rail the words go and the dot stays.
    assert.match(foot, /data-relay-text class="am2-rail-hide/);
    assert.doesNotMatch(foot, /data-relay-dot class="am2-rail-hide/,
        'the rail stops being able to say whether the network is up');
});

test('one poll paints both readouts, and neither owns an id', () => {
    // Two elements cannot share an id, and the two must never disagree.
    assert.match(shellEnd, /document\.querySelectorAll\('\[data-relay-dot\]'\)/);
    assert.match(shellEnd, /document\.querySelectorAll\('\[data-relay-text\]'\)/);
    assert.doesNotMatch(shellEnd, /\$\('am2-relay-dot'\)/, 'the poll still addresses one of them by id');
    assert.doesNotMatch(shell, /id="am2-relay-dot"/);
});

test('a working copy names no build', () => {
    // .release-sha is written by the builder. A checkout has none, and gets
    // nothing rather than a guess.
    const fn = read('WebAdmin/i18n.php');
    const body = fn.slice(fn.indexOf('function am2_release_build'), fn.indexOf('function am2_release_build') + 700);
    assert.match(body, /preg_match\('\/\^\[0-9a-f\]\{7,40\}\$\/'/, 'anything in that file is printed as a build');
    assert.match(body, /substr\(\$sha, 0, 8\)/);
});

test('the committed bundle carries the ground', () => {
    assert.ok(bundleCss.includes('56px 56px'), 'am2-tailwind.css was not rebuilt from its source');
    assert.ok(bundleCss.includes('--color-console-line') || bundleCss.includes('console-line'),
        'the token never reached the bundle');
});
