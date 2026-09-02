import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two things: the panel answering in one language, and two long lists you can
 * search.
 *
 * Nineteen messages across four pages were written straight into the PHP in
 * Indonesian and never went through t(), so an English interface answered an
 * action in Indonesian. It was always wrong; the banner made it easy to miss
 * and the toast does not.
 *
 * The Configure and Manage Access dialogues are the whole channel list and the
 * whole unit roster, read by looking for one name. Both have a filter now, and
 * the row that filter hides is hidden rather than removed -- a channel ticked
 * before the filter was typed is still ticked and still saved.
 *
 * A legacy rule stacked each Configure row into a single column below 576px,
 * written for Bootstrap markup this page no longer has. Measured at 360px with
 * it gone: a row is 39px on one line rather than 121px in four, and six rows
 * are 279px rather than 774px.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php'];
const id = read('WebAdmin/lang/id.php');
const en = read('WebAdmin/lang/en.php');
const channels = read('WebAdmin/channels.php');
const access = read('WebAdmin/user_access.php');
const ui = read('WebAdmin/asset/css/am2-ui.css');

const keysIn = (catalogue) => new Set([...catalogue.matchAll(/'([a-z0-9_]+\.[a-z0-9_]+)'\s*=>/g)].map((m) => m[1]));

test('no page writes a message in one language', () => {
    for (const page of PAGES) {
        const body = read(`WebAdmin/${page}`);
        const hardcoded = [...body.matchAll(/\$(?:success|error)_msg = "([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(hardcoded, [], `${page} still answers in whatever language it was typed in`);
    }
});

test('every message key a page asks for exists in both catalogues', () => {
    const inId = keysIn(id);
    const inEn = keysIn(en);
    for (const page of PAGES) {
        for (const [, key] of read(`WebAdmin/${page}`).matchAll(/\bt\('(msg\.[a-z_]+)'/g)) {
            assert.ok(inId.has(key), `lang/id.php has no ${key} (${page})`);
            assert.ok(inEn.has(key), `lang/en.php has no ${key} (${page})`);
        }
    }
});

test('the two catalogues hold the same message keys', () => {
    // One language gaining a key and the other not is how a page ends up
    // printing 'msg.something' at an operator.
    const only = (a, b) => [...a].filter((k) => k.startsWith('msg.') && !b.has(k));
    const inId = keysIn(id);
    const inEn = keysIn(en);
    assert.deepEqual(only(inId, inEn), [], 'keys in Indonesian only');
    assert.deepEqual(only(inEn, inId), [], 'keys in English only');
});

test('a message says the same things in both languages', () => {
    // Placeholders, not concatenation: the pieces of a sentence do not sit in
    // the same order in both languages. A placeholder present in one and
    // missing in the other drops a channel name or an error detail.
    const placeholders = (catalogue, key) => {
        const m = catalogue.match(new RegExp(`'${key}'\\s*=>\\s*'([^']*)'`));
        return new Set([...(m?.[1] ?? '').matchAll(/:([a-z]+)/g)].map((x) => x[1]));
    };
    for (const key of [...keysIn(id)].filter((k) => k.startsWith('msg.'))) {
        assert.deepEqual([...placeholders(id, key)].sort(), [...placeholders(en, key)].sort(),
            `${key} carries different values in the two languages`);
    }
});

test('an error detail arrives as a value, not as a joined string', () => {
    for (const page of PAGES) {
        assert.doesNotMatch(read(`WebAdmin/${page}`), /" \. am2_safe_error\(/,
            `${page} glues a translated prefix onto a detail, which fixes the word order`);
    }
});

test('both dialogues can be searched', () => {
    assert.match(channels, /data-unit-filter/, 'Manage Access has no search');
    assert.match(channels, /e\('ch\.search_units'\)/);
    assert.match(access, /data-channel-filter/, 'Configure has no search');
    assert.match(access, /e\('acc\.search_channels'\)/);
    for (const key of ['ch.search_units', 'ch.no_match', 'acc.search_channels', 'acc.no_match']) {
        assert.ok(keysIn(id).has(key) && keysIn(en).has(key), `${key} is missing from a catalogue`);
    }
});

test('a filtered-out row is hidden, not forgotten', () => {
    // Removing it would drop it from the form, so a channel ticked before the
    // filter was typed would silently not be saved.
    assert.match(access, /item\.hidden = !on/);
    assert.doesNotMatch(access, /item\.remove\(\)/);
    assert.match(channels, /li\.hidden = !on/);
});

test('select-all means the rows in front of the operator', () => {
    // It ticked every box in the roster, filtered or not: filtering to "Alpha"
    // and pressing it granted access to units nobody could see.
    const handler = channels.slice(channels.indexOf("document.querySelector('[data-access-all]')?.addEventListener"),
                                   channels.indexOf("[data-unit-pick]')) recount()"));
    assert.match(handler, /shownPicks\(\)\.forEach/);
    assert.doesNotMatch(handler, /picks\(\)\.forEach/);
});

test('the count is every unit ticked, not every unit visible', () => {
    // Hiding a row does not un-choose it, and the number the save acts on is
    // the number to show.
    const recount = channels.slice(channels.indexOf('const recount = () =>'),
                                   channels.indexOf('const recount = () =>') + 900);
    assert.match(recount, /const n = picks\(\)\.filter\(\(c\) => c\.checked\)\.length/);
    assert.match(recount, /const shown = shownPicks\(\)/, 'the box no longer describes what pressing it would do');
});

test('a dialogue opens showing everything', () => {
    for (const [name, body, sel] of [['Manage Access', channels, 'am2-channel-access'],
                                     ['Configure', access, 'am2-access-edit']]) {
        assert.match(body, new RegExp(`${sel}'\\)\\?\\.addEventListener\\('open\\.hs\\.overlay'`),
            `${name} keeps the last filter, hiding rows the next subject holds`);
    }
});

test('a Configure row is one line again on a phone', () => {
    // The rule was written for Bootstrap markup this page no longer has, and
    // display:grid !important beat the flex classes that replaced it.
    assert.doesNotMatch(ui, /\.channel-item \{[^}]*display: grid/,
        'each row stacks into a column again below 576px');
    assert.match(ui, /\.channel-item,\s*\n\s*\.channel-item > \* \{\s*\n\s*min-width: 0;/,
        'a long channel name can push RX and DEFAULT off the edge');
});
