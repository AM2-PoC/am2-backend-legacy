import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Three things the panel got wrong on a phone, each pinned to the mechanism
 * that fixes it rather than to the words around it.
 *
 * All three were measured in a browser before they were written down, at 320,
 * 480, 601, 602 and 1280 CSS pixels:
 *
 *   - the sticky header did not stick. `overflow-x: hidden` on body made body
 *     its own scroll container, and a scroll container as tall as its content
 *     never scrolls, so nothing inside it has anything to stick to. Header top
 *     read -800px after an 800px scroll with the line present and 0 without it.
 *   - the App Distribution card overflowed its column, because a grid item's
 *     automatic minimum size is its min-content width and the URL row's
 *     min-content is the whole URL: 451px of card inside a 406px column.
 *   - the log toolbar could not hold three category buttons, a text field and
 *     the freshness readout on one line below about 600px.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ui = read('WebAdmin/asset/css/am2-ui.css');
const bundle = read('WebAdmin/asset/css/am2-tailwind.css');
const logs = read('WebAdmin/logs.php');
const settings = read('WebAdmin/settings.php');

/** The declarations of a top-level rule, by its selector. */
function ruleBody(css, selector) {
    const at = css.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, `no top-level rule for ${selector}`);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}

test('body is not a scroll container, so position:sticky has something to stick to', () => {
    assert.doesNotMatch(ruleBody(ui, 'body'), /overflow-x/,
        'overflow-x on body makes body its own scroll box and kills every sticky inside it');
});

test('the horizontal axis is still clipped, on the element whose overflow the viewport takes', () => {
    // Dropping it from body is only safe while html keeps it: html's value is
    // the one that propagates to the viewport, and that is what stops a wide
    // element letting the page be dragged sideways.
    assert.match(ruleBody(ui, 'html'), /overflow-x:\s*hidden/);
});

test('the header the sticky fix exists for is still sticky', () => {
    assert.match(read('WebAdmin/partials/shell.php'), /<header class="sticky top-0/);
});

test('log search folds to its icon below 602px', () => {
    const toolbar = logs.slice(logs.indexOf('data-log-search'), logs.indexOf('id="logSearchInput"'));

    // The icon exists only under the breakpoint...
    assert.match(toolbar, /max-\[602px\]:grid/, 'the toggle never appears on a narrow screen');
    assert.match(toolbar, /max-\[602px\]:group-data-\[expanded=true\]:hidden/,
        'the toggle stays on screen beside the field it opened');

    // ...and the field is what it replaces there.
    const field = logs.slice(logs.indexOf('id="logSearchInput"'), logs.indexOf('id="logSearchInput"') + 900);
    assert.match(field, /max-\[602px\]:hidden/, 'the field is still on the crowded row');
    assert.match(field, /max-\[602px\]:group-data-\[expanded=true\]:block/,
        'asking for search does not produce a field');
});

test('the folded search compiles: every utility the markup names is in the bundle', () => {
    // The markup is inert without these rules, and the way they go missing is
    // an edit that nobody rebuilt. CI compares the built bundle against its
    // source; this says which rules the page is actually relying on.
    for (const util of [
        '.max-\\[602px\\]\\:grid',
        '.max-\\[602px\\]\\:hidden',
        '.max-\\[602px\\]\\:flex-none',
    ]) {
        assert.ok(bundle.includes(util), `${util} is not in the compiled CSS`);
    }
    assert.ok(bundle.includes('(min-width:602px)'), 'no 602px breakpoint was compiled');
    assert.ok(bundle.includes('[data-expanded=true]'), 'the expanded state compiles to nothing');
});

test('an open search keeps the field while it holds a term', () => {
    // Collapsing a field that is filtering the table leaves the operator
    // reading a filtered log with nothing on screen saying so.
    const close = logs.slice(logs.indexOf('function closeSearch'), logs.indexOf('function closeSearch') + 300);
    assert.match(close, /searchInput\.value !== ''/);
});

const shelf = settings.slice(
    settings.indexOf('id="am2-card-shelf"'),
    settings.indexOf('id="am2-card-danger"'),
);

test('App Distribution stacks the version above its QR code below 485px', () => {
    assert.match(shelf, /flex flex-col gap-4\s+min-\[485px\]:flex-row/,
        'the version and the 104px code still compete for one line on a small phone');
    assert.match(shelf, /break-all font-mono/,
        'the version name is one unbreakable token and will run past the card');
});

test('every card in the distribution grids may shrink below its content', () => {
    // Without min-w-0 a grid item is at least as wide as its min-content, and
    // the URL row's min-content is the whole URL.
    for (const anchor of [
        'rounded-control border border-edge p-4',      // one channel
        'id="am2-shelf-list"',                          // what is on the shelf
    ]) {
        const at = shelf.indexOf(anchor);
        assert.notEqual(at, -1, `${anchor} moved`);
        const attr = shelf.slice(shelf.lastIndexOf('<', at), at + anchor.length + 60);
        assert.match(attr, /min-w-0/, `${anchor} can still outgrow its column`);
    }
});
