import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The empty ground beside the sidebar, and the foot of the sidebar itself.
 *
 * The ground is the login panel's geometry at a lower volume, so the screen
 * somebody signs in on and the screen they work in read as one product. The
 * foot is kawung -- one of the oldest Javanese batik patterns, and the one that
 * is purely geometric, four ellipses interlocking around a point, so it
 * survives being drawn as a hairline and sits beside the console grid without
 * fighting it.
 *
 * What is pinned here is what was got wrong first and would be got wrong again.
 *
 * The ground is the body's own background, not a layer over it. As a layer it
 * drew nothing: body paints an opaque background, and z-index -10 paints before
 * that; positive z-index would have shown it and covered the console instead.
 *
 * Light carries far more of the hairline than dark. Measured against the page
 * colour, the same 16% came to a contrast ratio of 1.102 in light and dark's
 * 20% came to 1.364 -- present in both, and below the point of being noticed in
 * one of them.
 *
 * The foot briefly carried a relay dot and a build stamp. The space reads
 * better as pattern, and the readout it duplicated is still under the header.
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
    assert.doesNotMatch(src, /am2-console-geometry|am2-console-grid/, 'the abandoned layer is back');
    assert.doesNotMatch(shell, /am2-console/, 'the shell emits markup nothing styles');
});

test('the legacy sheet defends the colour without erasing the ground', () => {
    // `background: … !important` reset every layer and outranked the image,
    // because that sheet loads first and !important beats source order.
    const body = legacy.slice(legacy.indexOf('\nbody {'), legacy.indexOf('\nbody {') + 900);
    assert.match(body, /background-color: var\(--color-bg\) !important/);
    assert.doesNotMatch(body, /\n\s*background: var\(--color-bg\) !important/,
        'the shorthand is back and the ground is erased again');
});

test('the grid is kept out of the busiest band', () => {
    // Header, status strip and first card. The strip is translucent, so a grid
    // behind it would show through it.
    const body = src.slice(src.indexOf('\nbody {'), src.indexOf('\nbody {') + 900);
    assert.match(body, /linear-gradient\(to bottom,\s*\n?\s*var\(--color-bg\) 0%/,
        'nothing covers the grid where the page is densest');
});

test('light carries enough of the hairline to be seen', () => {
    const alpha = (block) => Number(block.match(/--color-console-line:.*?var\(--color-primary\) (\d+)%/)[1]);
    const light = legacy.slice(legacy.indexOf('[data-theme="light"] {'), legacy.indexOf('[data-theme="dark"],'));
    const dark = legacy.slice(legacy.indexOf('[data-theme="dark"],'), legacy.indexOf('[data-theme="dark"],') + 1600);
    assert.ok(alpha(light) >= 40,
        `light is at ${alpha(light)}%, which measured 1.102 against the page colour and reads as nothing`);
    assert.ok(alpha(light) > alpha(dark),
        'light needs more of it than dark, not less: a hairline lifts further off a near-black ground');
});

test('the foot is pattern, and only pattern', () => {
    const foot = shell.slice(shell.indexOf('<!--\n        The foot.'), shell.indexOf('</aside>'));
    assert.match(foot, /am2-rail-batik/);
    assert.match(foot, /aria-hidden="true"/, 'decoration is announced to a screen reader');
    assert.doesNotMatch(foot, /data-relay-dot|data-relay-text/,
        'the foot repeats a readout the header already carries');
    assert.doesNotMatch(foot, /am2_release_build|nav\.build/);
});

test('the pattern is a mask, so it is themed rather than coloured in', () => {
    const rule = src.slice(src.indexOf('.am2-rail-batik {'), src.indexOf('@media (prefers-contrast: more)'));
    assert.match(rule, /background-color: var\(--color-console-line\)/,
        'the pattern carries its own colour and stops following the theme');
    assert.match(rule, /mask-image: url\("\.\.\/image\/kawung\.svg"\)/);
    /*
     * One composite value per layer, and only the top one intersects.
     *
     * `mask-composite: intersect` alone applies to both layers, and the bottom
     * one has nothing beneath it to intersect with. Chrome answered that by
     * dropping the tile and keeping the fade, so the batik rendered as a solid
     * block of amber -- a mask that composites to nothing looks exactly like no
     * mask at all.
     */
    assert.match(rule, /mask-composite: intersect, add/,
        'the bottom layer intersects an empty backdrop and the pattern becomes a solid block');
    // Safari spells the operators differently and ignores a layer it cannot read.
    assert.match(rule, /-webkit-mask-composite: source-in, source-over/);
});

test('the tile is well-formed XML', () => {
    /*
     * A comment may not contain two hyphens in a row. It named a CSS custom
     * property -- two hyphens -- so the file was malformed, Chrome failed to
     * decode it, and a mask image that will not decode is treated as fully
     * opaque: the pattern silently became a solid block, with nothing in the
     * console to say so.
     */
    const svg = read('WebAdmin/asset/image/kawung.svg');
    for (const comment of svg.match(/<!--[\s\S]*?-->/g) ?? []) {
        assert.doesNotMatch(comment.slice(4, -3), /--/, 'a comment contains two hyphens in a row');
    }
});

test('the tile meets itself on every edge', () => {
    // Rosettes at the centre and at all four corners; anything less seams.
    const svg = read('WebAdmin/asset/image/kawung.svg');
    assert.match(svg, /width="64" height="64"/);
    assert.equal((svg.match(/<ellipse/g) ?? []).length, 20, 'five rosettes of four ellipses');
    // A mask reads alpha, not colour, so the tile may only be black or nothing.
    // Any other value means someone coloured it in and the theme stops reaching
    // it -- and currentColor never resolves inside a mask url() at all.
    const colours = new Set([...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...colours].sort(), ['#000', 'none']);
});

test('scenery goes when contrast is asked for', () => {
    const block = src.slice(src.indexOf('@media (prefers-contrast: more)'),
                            src.indexOf('@media (prefers-contrast: more)') + 260);
    assert.match(block, /body \{ background-image: none; \}/);
    assert.match(block, /\.am2-rail-batik \{ display: none; \}/);
});

test('the relay readout is addressed by attribute', () => {
    // It was two elements sharing one poll. The sidebar's is gone and the
    // header's remains; addressing it by attribute costs nothing and leaves
    // room for a second without a duplicate id.
    assert.match(shellEnd, /document\.querySelectorAll\('\[data-relay-dot\]'\)/);
    assert.doesNotMatch(shellEnd, /\$\('am2-relay-dot'\)/);
    assert.doesNotMatch(shell, /id="am2-relay-dot"/);
});

test('the committed bundle carries all of it', () => {
    assert.ok(bundleCss.includes('56px 56px'), 'am2-tailwind.css was not rebuilt from its source');
    assert.ok(bundleCss.includes('kawung.svg'), 'the batik never reached the bundle');
});
