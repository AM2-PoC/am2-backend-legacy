/**
 * Controls that have to survive a narrow viewport.
 *
 * Three failures live here, all of them invisible at 1440px and all of them
 * reported from real use at 1265px and 1032px: action buttons that overlap
 * because their row cannot wrap, a KPI grid that stays two-up in a band wide
 * enough for four, and status chips that were each styled by hand so no two
 * columns agreed on what a chip is.
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

/** Pages whose rosters carry a right-aligned cluster of row actions. */
const ACTION_PAGES = ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php'];

/** The cluster wrapper that follows each actions cell, per page. */
function actionClusters(src) {
    const out = [];
    for (const m of src.matchAll(/data-cell="actions"[\s\S]{0,400}?<span class="([^"]*)"/g)) {
        out.push(m[1].replace(/\s+/g, ' ').trim());
    }
    return out;
}

for (const page of ACTION_PAGES) {
    test(`${page} lets its row actions wrap instead of overlapping`, () => {
        const clusters = actionClusters(read(page));
        assert.notEqual(clusters.length, 0, `${page} has no actions cell`);
        for (const c of clusters) {
            assert.match(c, /\bflex-wrap\b/,
                `an action cluster in ${page} cannot wrap: "${c}" -- below about 1265px the `
                + 'buttons overflow their cell and sit on top of the column beside them');
            assert.match(c, /\bjustify-end\b/,
                `a wrapped cluster in ${page} must stay right-aligned: "${c}"`);
        }
    });
}

test('the dashboard metric cards use the full width of an intermediate viewport', () => {
    const src = read('dashboard.php');
    const grid = src.match(/<section class="(grid[^"]*)"/);
    assert.ok(grid, 'dashboard.php no longer renders a metric grid');
    const cls = grid[1];

    // Four cards jumping straight from two columns to four at xl leaves the
    // whole 1024-1279px band showing two, on a viewport that fits four.
    assert.doesNotMatch(cls, /\bxl:grid-cols-4\b(?![\s\S]*\blg:grid-cols-)/,
        'the grid still waits for xl to go four-up, so 1024-1279px renders two columns of half-empty cards');
    assert.match(cls, /\blg:grid-cols-4\b/,
        'nothing lays the metric cards out at lg, which is where the content budget first fits four');
});

test('every Users status column is built from the shared chip, not a hand-copied one', () => {
    const src = read('users.php');

    // The chip is a component in tailwind.src.css. A column that reproduces its
    // padding and type scale inline is a fifth definition to keep in sync, and
    // the CHANNEL column had drifted already.
    for (const cell of ['channel', 'features', 'duplex', 'actions']) {
        const m = src.match(new RegExp(`data-cell="${cell}"[\\s\\S]*?\\n(?=\\s*<td|\\s*</tr)`));
        assert.ok(m, `users.php has no ${cell} cell`);
        assert.match(m[0], /\bam2-chip\b/,
            `the ${cell} column does not use am2-chip, so it is a private copy of the chip's styling`);
    }
});

test('the Users chips keep their status readable rather than making everything brand-coloured', () => {
    const src = read('users.php');
    const cell = (name) => src.match(new RegExp(`data-cell="${name}"[\\s\\S]*?\\n(?=\\s*<td|\\s*</tr)`))[0];

    // Same shape, different meaning: a channel fault is a warning, duplex is a
    // mode rather than a permission, and delete must never look like a status.
    assert.match(cell('duplex'), /\baccent\b/, 'duplex lost its own colour and now reads as a permission');
    assert.match(cell('actions'), /\bbad\b/, 'the delete action lost its danger colour');
    assert.doesNotMatch(cell('actions'), /border-brand bg-brand\/10/,
        'an action is dressed as an active status chip');
});

test('the delete action stays red on hover, against the chip rule that would turn it brand', () => {
    const css = read('asset/css/tailwind.src.css');
    const src = read('users.php');

    // .am2-chip:enabled:hover sets border-color to the brand for every enabled
    // chip. Now that delete is a chip, it inherits that -- and a destructive
    // control that turns the same colour as an active status on hover is a
    // control someone clicks by mistake.
    assert.match(css, /\.am2-chip:enabled:hover\s*\{[^}]*border-color/,
        'the chip no longer recolours its border on hover; this guard needs rewriting');

    const del = src.match(/<button type="submit"[^>]*class="([^"]*)"/);
    assert.ok(del, 'users.php has no delete submit button');
    assert.match(del[1], /hover:border-bad\/[0-9]+!/,
        'the delete hover border is not marked important, so the shared chip rule paints it brand');
});

test('a chip that toggles registers its shared class where the repaint can find it', () => {
    const src = read('users.php');
    const table = read('asset/js/src/am2-table.js');

    // paintToggle rewrites className wholesale from data-base-class plus the
    // on/off pair. A class present only in the initial class attribute is gone
    // the first time the toggle is used.
    assert.match(table, /className\s*=\s*`\$\{btn\.dataset\.baseClass/,
        'am2-table.js no longer rebuilds className from data-base-class; this test needs rewriting');

    for (const m of src.matchAll(/<button[^>]*\bdata-toggle\b[^>]*>/g)) {
        const tag = m[0];
        if (!/am2-chip/.test(tag)) continue;
        const base = tag.match(/data-base-class="([^"]*)"/);
        assert.ok(base, 'a toggling chip has no data-base-class, so the repaint erases its styling');
        assert.match(base[1], /\bam2-chip\b/,
            'am2-chip is not in data-base-class; the first toggle strips the chip down to bare text');
    }
});
