import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The screen that goes dead with nothing on it.
 *
 * Preline builds one backdrop per open under a fixed id -- `<overlay>-backdrop`
 * -- and removes it on close by looking that id up. It also defers the callback
 * that marks an overlay open by 50ms. A close landing inside that window is
 * overtaken by it: the element is hidden and then re-marked `opened`, and the
 * backdrop the reopen built is left in the document with nothing owning it. It
 * is `fixed inset-0` and it ends its fade at opacity 0 -- nothing to see, every
 * click swallowed, and the trigger toggling the wrong way because the element
 * claims to be open.
 *
 * Measured in a browser driving the real bundle, closing at the same moment as
 * a reopen, 28 runs each way:
 *
 *   without the reconcile: 8 runs left a backdrop over the page for good, the
 *                          same 8 left the overlay marked opened
 *   with it:               0 and 0, the scroll lock released, and the overlay
 *                          opening normally afterwards
 *
 * CI has no browser, so what is pinned here is the mechanism those numbers
 * belong to. The numbers themselves are in the commit.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exit = readFileSync(join(ROOT, 'WebAdmin/asset/js/src/am2-exit.js'), 'utf8');
const shell = readFileSync(join(ROOT, 'WebAdmin/partials/shell_end.php'), 'utf8');
const bundle = readFileSync(join(ROOT, 'WebAdmin/asset/js/am2-ui.min.js'), 'utf8');

test('every close is checked once the close has had time to finish', () => {
    const watch = exit.slice(exit.indexOf('export function watchOverlays'));
    assert.match(watch, /playExit\(el\)\.then\(\(\) => setTimeout\(\(\) => reconcile\(el\), SETTLE\)\)/,
        'nothing looks at what a close left behind');
});

test('the check waits past the 50ms Preline defers its open callback by', () => {
    const settle = exit.match(/const SETTLE = (\d+);/);
    assert.ok(settle, 'the settling delay is no longer a named constant');
    assert.ok(Number(settle[1]) > 50, 'the check runs before the callback it exists to catch');
});

test('a closed overlay stops claiming to be open, and loses its backdrop', () => {
    const fn = exit.slice(exit.indexOf('function reconcile('), exit.indexOf('export function watchOverlays'));
    assert.match(fn, /classList\.remove\('open', 'opened'\)/,
        'an element that is hidden still says opened, so its trigger toggles the wrong way');
    assert.match(fn, /\[id="\$\{CSS\.escape\(el\.id\)\}-backdrop"\]/,
        'the leftover backdrop stays over the page');
    assert.match(fn, /document\.body\.style\.removeProperty\('overflow'\)/,
        'the scroll lock is never handed back');
});

test('an overlay that reopened inside the window is left alone', () => {
    // Reopened, it is a live overlay: stripping its classes or removing its
    // backdrop would break the overlay this exists to protect.
    const fn = exit.slice(exit.indexOf('function reconcile('), exit.indexOf('export function watchOverlays'));
    assert.match(fn, /if \(!el\?\.classList\.contains\('hidden'\)\) return;/);
});

test('the palette asks Preline for no backdrop at all', () => {
    // It is a full-screen scrim in its own right, so Preline's was a second
    // sheet drawing nothing new -- and it was the one that got left behind.
    const open = shell.slice(shell.indexOf('<div id="am2-palette"'), shell.indexOf('<div data-am2-panel'));
    assert.match(open, /\[--overlay-backdrop:false\]/);
    assert.match(open, /bg-slate-950\/70/,
        'the scrim did not absorb the alpha of the backdrop it replaced');
});

test('the shipped bundle carries the guard', () => {
    // The bundle is committed and deploys copy it; source alone proves nothing
    // about what a browser runs.
    assert.match(bundle, /removeProperty\("overflow"\)|removeProperty\('overflow'\)/,
        'am2-ui.min.js was not rebuilt from its source');
    assert.ok(bundle.includes('-backdrop"'), 'the backdrop sweep is not in the bundle');
});
