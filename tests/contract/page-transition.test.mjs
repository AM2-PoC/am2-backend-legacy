/**
 * The page transition, and the blink it used to have.
 *
 * Navigation here is a full PHP page load, so the only moving part is the View
 * Transitions API plus whatever the deferred bundle does after first paint.
 * Both are read as text: there is no browser in this suite, and the failure
 * being guarded against -- content painting, then being hidden, then fading
 * back in -- is a property of when the opacity is set, not of what it renders.
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

// Comments carry no braces, so a selector matched by scanning backwards from a
// declaration block swallows whichever comment precedes it. Stripped once here
// rather than guarded against in four regexes.
const css = read('asset/css/tailwind.src.css').replace(/\/\*[\s\S]*?\*\//g, '');
const ui = read('asset/js/src/am2-ui.js');
const head = read('partials/head.php');
const shell = read('partials/shell.php');

/**
 * The body of the rule carrying this selector.
 *
 * Selector lists are split rather than matched whole: the chrome rules name two
 * groups in one block, and looking for a selector immediately followed by `{`
 * finds only whichever one is written last.
 */
function ruleFor(selector) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const list = m[1].split(',').map((s) => s.trim());
        if (list.includes(selector)) return m[2];
    }
    return null;
}

/** Selectors that name a view transition, mapped to the name they assign. */
function transitionNames() {
    const out = {};
    for (const m of css.matchAll(/([^{}]+)\{([^}]*view-transition-name\s*:\s*([\w-]+)[^}]*)\}/g)) {
        out[m[1].trim()] = m[3];
    }
    return out;
}

test('the bundle never hides content that has already been painted', () => {
    // The bundle is deferred, so anything it sets runs after first paint. An
    // element dropped to opacity 0 there was visible for a frame first, and
    // fading it back in is the blink -- on every page load, for every reveal.
    const offender = ui.match(/\.style\.opacity\s*=\s*['"]0['"]/);
    assert.equal(offender, null,
        'the bundle sets opacity to 0 from script; the initial state must come from CSS, before paint');
});

test('a revealed section starts hidden in CSS, and only when script can bring it back', () => {
    // Hiding it unconditionally means a browser with a broken or blocked
    // bundle renders a permanently invisible page.
    const gated = Object.keys({ ...{} }) && [...css.matchAll(/([^{}]*\[data-reveal\][^{}]*)\{([^}]*)\}/g)]
        .map((m) => ({ selector: m[1].trim(), body: m[2] }));
    assert.notEqual(gated.length, 0, 'nothing in CSS gives [data-reveal] an initial state');

    const hides = gated.filter((r) => /opacity\s*:\s*0\b/.test(r.body));
    assert.notEqual(hides.length, 0, '[data-reveal] is never hidden, so script must hide it after paint');
    for (const r of hides) {
        assert.match(r.selector, /am2-js/,
            `"${r.selector}" hides content without requiring script; without the bundle the page stays blank`);
    }
});

test('the script marker is set before first paint, not by the deferred bundle', () => {
    // A class added by the deferred bundle arrives after paint, which is the
    // same one-frame flash by another route.
    assert.match(head, /am2-js/, 'partials/head.php never marks the document as script-capable');
    const marker = head.match(/<script\b[^>]*>[\s\S]*?am2-js[\s\S]*?<\/script>/);
    assert.ok(marker, 'the am2-js marker is not set by an inline script in the head');
    assert.doesNotMatch(marker[0], /\b(defer|async)\b/,
        'the marker script is deferred, so it runs after paint and the flash remains');
});

test('the app chrome is named for the transition, so it does not cross-fade with itself', () => {
    const names = transitionNames();
    const named = Object.entries(names);
    assert.notEqual(named.length, 0, 'no element carries a view-transition-name');

    // The sidebar and the header are identical across pages. Left in the root
    // snapshot they cross-fade against themselves on every navigation, which
    // is most of what read as a blink.
    for (const sel of ['#am2-sidebar', 'main']) {
        assert.ok(named.some(([s]) => s.split(',').map((x) => x.trim()).includes(sel)),
            `${sel} has no view-transition-name, so it animates as part of root`);
    }
    const unique = new Set(Object.values(names));
    assert.equal(unique.size, Object.keys(names).length,
        'two elements share a view-transition-name, which the browser treats as one morphing element');

    // A name the browser finds on more than one element invalidates the whole
    // transition, so a selector that is merely a tag name is a bug: users.php
    // and admin_panel.php carry several card <header>s each.
    const shellHeaders = (shell.match(/<header\b/g) ?? []).length;
    assert.equal(shellHeaders, 1, 'the shell grew a second <header>; the top bar selector needs re-scoping');
    for (const sel of Object.keys(names)) {
        if (sel === 'main') continue;   // one <main> per document, by definition
        assert.match(sel, /[#.[>]/,
            `"${sel}" names a transition by tag alone; every matching element claims the same name`);
    }
});

test('only the main content animates; the chrome holds still', () => {
    const main = transitionNames()['main'];
    assert.ok(main, 'main has no view-transition-name');

    const enter = ruleFor(`::view-transition-new(${main})`);
    assert.ok(enter, `nothing animates ::view-transition-new(${main})`);
    assert.match(enter, /animation-name\s*:|animation\s*:/,
        'the incoming content has no entrance, so the change reads as a cut');

    for (const [sel, name] of Object.entries(transitionNames())) {
        if (name === main) continue;
        const group = ruleFor(`::view-transition-group(${name})`);
        assert.ok(group && /animation\s*:\s*none|animation-name\s*:\s*none/.test(group),
            `${sel} (${name}) still animates; the chrome must not move when the content does`);
    }
});

test('the content entrance is a short rise, not a full-page fade', () => {
    const main = transitionNames()['main'];
    const keyframes = css.match(/@keyframes\s+am2-page-enter\s*\{([\s\S]*?)\n\}/);
    assert.ok(keyframes, 'no am2-page-enter keyframes; the entrance is unnamed and unreadable');
    assert.match(keyframes[1], /translateY\(\s*(\d+(?:\.\d+)?)px/,
        'the entrance has no travel, so it is the same cross-fade as before');
    const px = Number(keyframes[1].match(/translateY\(\s*(\d+(?:\.\d+)?)px/)[1]);
    assert.ok(px > 0 && px <= 16, `the content travels ${px}px; over about 16px reads as a slide, not a settle`);
    assert.match(ruleFor(`::view-transition-new(${main})`), /am2-page-enter/,
        'the incoming content does not use the named entrance');
});

test('reduced motion silences every transition, named ones included', () => {
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g);
    assert.ok(block, 'no reduced-motion block');
    const all = block.join('\n');
    assert.match(all, /::view-transition-group\(\*\)|::view-transition-old\(\*\)|::view-transition-new\(\*\)/,
        'reduced motion silences root only; the named transitions still animate');
    assert.match(all, /\[data-reveal\]/,
        'reduced motion never restores [data-reveal], so a hidden section stays hidden');
});

test('the shell still carries the landmarks the transition names hang on', () => {
    assert.match(shell, /<main\b/, 'partials/shell.php no longer renders <main>');
    assert.match(shell, /id="am2-sidebar"/, 'the sidebar id the transition targets is gone');
});
