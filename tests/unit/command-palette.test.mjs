import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The command palette, exercised rather than read.
 *
 * `compute()` needs nothing but a value, a list and a callback, so it is lifted
 * out of the page verbatim and run here against the real command set. A test
 * that quoted the source back at itself would have agreed with both of the
 * behaviours below, including the broken ones.
 *
 * Two faults, both reported from the field:
 *
 *   - Enter never reached a page. The unit-search row was prepended and the
 *     cursor starts at 0, so the highlighted row was always "find a unit":
 *     typing "dashboard" and pressing Enter opened the user list searching for
 *     the word dashboard, and the Dashboard row directly beneath it could only
 *     be had by arrowing down or clicking.
 *   - Arrowing down did not follow the list. The box is 320px of an up-to-500px
 *     column; measured in a browser, row 7 sat at 316px, row 10 at 448px, and
 *     scrollTop stayed 0 the whole way -- the selection was below the fold with
 *     nothing on screen moving.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shell = readFileSync(join(ROOT, 'WebAdmin/partials/shell_end.php'), 'utf8');

/** The shipped compute(), lifted out of the page and made callable. */
function paletteFrom(commands) {
    const from = shell.indexOf('    function compute() {');
    const to = shell.indexOf('    function render() {');
    assert.ok(from !== -1 && to !== -1 && from < to, 'compute() is no longer where this test looks');

    return new Function('COMMANDS', 'UNITS_LABEL', `
        const input = { value: '' };
        let cursor = 0, results = [];
        const render = () => {};
        ${shell.slice(from, to)}
        return (typed) => {
            input.value = typed;
            compute();
            return { rows: results, selected: results[cursor] };
        };
    `)(commands, 'Cari unit');
}

/** What the shell actually offers, in the locale an operator here reads. */
const COMMANDS = [
    { id: 'p-dash',     group: 'Home',          label: 'Dashboard',     href: 'dashboard.php' },
    { id: 'p-users',    group: 'Manajemen',     label: 'User',          href: 'users.php' },
    { id: 'p-chan',     group: 'Manajemen',     label: 'Channels',      href: 'channels.php' },
    { id: 'p-logs',     group: 'Monitoring',    label: 'Aktivitas Log', href: 'logs.php' },
    { id: 'p-settings', group: 'Sistem',        label: 'Pengaturan',    href: 'settings.php' },
    { id: 'a-out',      group: 'Aksi',          label: 'Logout',        href: 'logout.php' },
];

test('Enter goes to the page that was typed, not to a unit search', () => {
    const ask = paletteFrom(COMMANDS);
    for (const [typed, href] of [
        ['dashboard',  'dashboard.php'],
        ['log',        'logs.php'],
        ['pengaturan', 'settings.php'],
    ]) {
        assert.equal(ask(typed).selected.href, href,
            `"${typed}" still selects something other than the page it names`);
    }
});

test('unit search is what is left when no page matches', () => {
    const ask = paletteFrom(COMMANDS);
    const { selected, rows } = ask('budi');
    assert.equal(selected.id, 's-units');
    assert.equal(selected.href, 'users.php?search=budi');
    assert.equal(rows.length, 1, 'a name that matches no page should offer one thing');
});

test('the unit row is offered on every query, last', () => {
    // It is the fallback, not the answer: a name can look like a page name.
    const { rows } = paletteFrom(COMMANDS)('log');
    assert.equal(rows.at(-1).id, 's-units');
    assert.ok(rows.length > 1);
});

test('an empty box lists everything and offers no unit search', () => {
    const { rows, selected } = paletteFrom(COMMANDS)('');
    assert.equal(rows.length, COMMANDS.length);
    assert.equal(selected.id, 'p-dash');
});

test('a new query starts at the top of its own list', () => {
    // The row under the cursor a keystroke ago has nothing to do with the row
    // at that index now.
    const from = shell.indexOf('    function compute() {');
    const body = shell.slice(from, shell.indexOf('    function render() {'));
    assert.doesNotMatch(body, /if \(cursor >= results\.length\) cursor = 0;/,
        'the cursor is carried across into a list it was never measured against');
    assert.match(body, /cursor = 0;/);
});

test('the highlighted row is scrolled into the box it lives in', () => {
    // No DOM here, so this is the one thing asserted against the source. The
    // behaviour it stands for was measured in a browser: before, scrollTop held
    // at 0 through ten arrow presses; after, it stepped 40, 84, 128, 172 and
    // the selection stayed visible, with the overlay and the page behind it
    // unmoved.
    const from = shell.indexOf('    function render() {');
    const body = shell.slice(from, shell.indexOf('    function run(i) {'));
    assert.match(body, /selected\?\.scrollIntoView\(\{ block: 'nearest' \}\)/,
        'nothing follows the cursor down a list taller than its box');
    assert.match(body, /if \(i === cursor\) selected = li/,
        'the row being revealed is not the row that is selected');
});
