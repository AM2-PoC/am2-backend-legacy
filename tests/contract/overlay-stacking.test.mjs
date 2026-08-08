/**
 * Dialogues have to stay clickable.
 *
 * A regression this file exists for: `view-transition-name` on <main> makes
 * <main> a stacking context. Every overlay in this panel is markup inside
 * <main>, while Preline builds its backdrop as a child of <body> -- so once
 * <main> was named, the overlay's z-80 stopped being comparable to the
 * backdrop's z-79 and the backdrop covered the dialogue. The dialogue rendered,
 * looked right, and swallowed every click on it.
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
// Comments carry no braces; stripping them keeps selector matching honest.
const css = read('asset/css/tailwind.src.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block that assigns a property to a selector, if any. */
function ruleFor(selector, property) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const list = m[1].split(',').map((s) => s.trim());
        if (list.includes(selector) && new RegExp(`\\b${property}\\s*:`).test(m[2])) return m[2];
    }
    return null;
}

test('<main> is not a permanent stacking context, so overlays inside it still stack against the page', () => {
    // The property is what creates the context. Left on unconditionally it
    // traps every dialogue in the panel underneath Preline's backdrop.
    const always = ruleFor('main', 'view-transition-name');
    assert.equal(always, null,
        'main carries view-transition-name at all times, which makes it a stacking context '
        + 'and puts every overlay inside it below the body-level backdrop');
});

test('the page transition still names the three regions it animates', () => {
    // The fix must not simply delete the transition: naming is what keeps the
    // sidebar and top bar out of the root snapshot.
    for (const name of ['am2-rail', 'am2-topbar', 'am2-page']) {
        assert.match(css, new RegExp(`view-transition-name:\\s*${name}\\b`),
            `${name} is gone; the chrome would cross-fade with itself again`);
    }
});

test('the names are applied only while a navigation is in flight', () => {
    // A class the document carries for the duration of the transition, rather
    // than a permanent property, is what lets both things be true at once.
    const scoped = [...css.matchAll(/([^{}]*view-transition-name[^{}]*)/g)];
    assert.notEqual(scoped.length, 0, 'nothing assigns a view-transition-name');

    for (const m of css.matchAll(/([^{}]+)\{([^}]*view-transition-name\s*:\s*am2-[\w-]+[^}]*)\}/g)) {
        const selector = m[1].trim();
        assert.match(selector, /am2-navigating/,
            `"${selector}" names a transition unconditionally; it must be gated on the `
            + 'navigating state or it makes a permanent stacking context');
    }
});

test('something removes the navigating state, so it cannot get stuck on', () => {
    const ui = read('asset/js/src/am2-ui.js');
    assert.match(ui, /am2-navigating/,
        'no script manages the navigating class, so the names are never applied');
    assert.match(ui, /pageswap|pagereveal|popstate|pagehide/,
        'the navigating state is not tied to a navigation event');
});

test('every overlay still declares the z-index it was designed with', () => {
    // Cheap guard against "fixing" this by lowering the overlay instead.
    for (const page of ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php']) {
        const src = read(page);
        assert.match(src, /hs-overlay fixed inset-0 z-80/,
            `${page} changed its overlay z-index; the backdrop sits at 79`);
    }
});
