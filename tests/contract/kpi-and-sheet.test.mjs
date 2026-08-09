/**
 * The metric cards, and the actions at the foot of a mobile sheet.
 *
 * Both are about a card being readable at a glance: a KPI that states a number
 * and nothing about where it came from, and three buttons huddled at one end of
 * a 390px sheet.
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
const dashboard = read('dashboard.php');

test('a card with history says which way it is going', () => {
    // The series are already fetched -- seven cumulative daily counts -- so the
    // change against the start of the window is arithmetic on data in hand
    // rather than another query.
    assert.match(dashboard, /function am2_delta/,
        'nothing derives a change from the series the cards already carry');
});

test('the delta is read from the series rather than fetched again', () => {
    const fn = dashboard.match(/function am2_delta[\s\S]*?\n\}/);
    assert.ok(fn, 'am2_delta is gone');
    assert.doesNotMatch(fn[0], /\$pdo|query\(|prepare\(/,
        'the delta runs its own query; the seven-day series is already in memory');
});

test('a flat or missing series shows no delta at all', () => {
    // A card that says "0%" every day is noise, and one that invents a
    // direction from a single data point is a lie.
    const fn = dashboard.match(/function am2_delta[\s\S]*?\n\}/)[0];
    assert.match(fn, /count\(\$\w+\)\s*<\s*2|count\(\$\w+\)\s*<=\s*1/,
        'a series too short to compare still produces a delta');
    assert.match(fn, /return\s+(null|'')/,
        'there is no way for the delta to be absent');
});

test('the number a delta is measured against is the one on the card', () => {
    // Comparing today's total to the start of the window only means something
    // if the series ends at today's total. These are cumulative counts, so it
    // does -- and that is worth pinning, because a series of daily *new* rows
    // would make the same arithmetic wrong.
    assert.match(dashboard, /created_at::date <= d\.day/,
        'the series is no longer cumulative, so comparing its ends is not a delta of the card value');
});

test('the sheet actions share the width of the sheet', () => {
    // Measured at 390px: the three buttons occupied 191px at one end, so two
    // thirds of the footer was empty and every button was a small target in a
    // corner.
    for (const page of ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php']) {
        const src = read(page);
        // Matched to the closing quote of the class attribute, not to the first
        // ">" -- Tailwind's arbitrary variants contain one ([&>form]:contents),
        // so stopping at it cuts the attribute in half.
        const footer = src.match(/<footer data-slot="actions"\s*\n?\s*class="([^"]*)"/);
        assert.ok(footer, `${page} has no sheet action footer`);
        assert.match(footer[1], /\[&_button\]:flex-1|grid-cols/,
            `${page}: the sheet actions do not divide the footer between them`);
        assert.match(footer[1], /min-h-11|h-11/,
            `${page}: the sheet actions are not a full-sized touch target`);
    }
});

test('the destructive action in a sheet is the one that looks destructive', () => {
    // In a row the delete button sits among other chips and is read in context.
    // Alone at the foot of a sheet, at the size of its neighbours, it is a
    // button someone taps by reflex.
    const src = read('users.php');
    const sheet = src.match(/<footer data-slot="actions"[\s\S]*?<\/footer>/);
    assert.ok(sheet, 'the sheet footer is gone');
    // The buttons are moved in from the row, so the styling that marks delete
    // has to survive the move -- which means it lives on the button itself.
    assert.match(src, /text-bad/, 'nothing marks the delete action as destructive');
});
