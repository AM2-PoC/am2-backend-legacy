/**
 * The responsive roster contract.
 *
 * Credential-free by construction: it renders partials/table_open.php in a PHP
 * subprocess and reads the CSS and the log page as text. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 *
 * What each test catches is named on the test, because a responsive regression
 * has no stack trace -- it is a column that quietly became 40px wide.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const css = readFileSync(join(WEBADMIN, 'asset/css/tailwind.src.css'), 'utf8');
const logsPhp = readFileSync(join(WEBADMIN, 'logs.php'), 'utf8');

/**
 * Renders a partial with the two helpers it calls stubbed out. The panel's own
 * bootstrap needs a session and a database; the partial needs neither, so the
 * markup it emits can be checked as markup.
 */
function renderPartial(relPath, setup = '') {
    const dir = mkdtempSync(join(tmpdir(), 'am2-partial-'));
    const harness = join(dir, 'render.php');
    writeFileSync(harness, `<?php
function t(string $k, array $r = []): string { return $k; }
function e(string $k, array $r = []): string { return htmlspecialchars($k, ENT_QUOTES, 'UTF-8'); }
function am2_icon(string $n, string $extra = ''): string { return '<svg data-icon="' . $n . '"></svg>'; }
$_GET = [];
${setup}
include ${JSON.stringify(join(WEBADMIN, relPath))};
`);
    try {
        return execFileSync('php', [harness], { encoding: 'utf8' });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** CSS specificity as (ids, classes+attributes+pseudo-classes, types). */
function specificity(selector) {
    let s = selector.trim();
    // ::before and friends count as types; :has(...) contributes its own weight
    // but never below the class column, so the inner text is dropped after the
    // outer :has is counted.
    s = s.replace(/:has\([^)]*\)/g, ':has');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+/g) || []).length
        + (s.match(/\[[^\]]+\]/g) || []).length
        + (s.match(/(?<!:):(?!:)[\w-]+/g) || []).length;
    const types = (s.replace(/\[[^\]]+\]/g, '').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length
        + (s.match(/::[\w-]+/g) || []).length;
    return [ids, classes, types];
}

function beats(a, b) {
    const x = specificity(a), y = specificity(b);
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) return x[i] > y[i];
    }
    return false;
}

/** Every selector in the file's mobile roster block. */
function rosterSelectors() {
    const start = css.indexOf('@media (max-width: 1023px)');
    assert.notEqual(start, -1, 'the mobile roster media query is gone');
    const block = css.slice(start, css.indexOf('\n}\n', start));
    return [...block.matchAll(/^\s*([^@{}\n][^{}\n]*?)\s*\{/gm)].map((m) => m[1].trim());
}

test('the shared roster table has a desktop minimum width, so a squeezed viewport scrolls instead of crushing columns', () => {
    const html = renderPartial('partials/table_open.php', "$columns = [['key' => 'usr.unit']];");
    const table = html.match(/<table[^>]*class="([^"]*)"/);
    assert.ok(table, 'partials/table_open.php no longer renders a <table>');

    const classes = table[1].split(/\s+/);
    const minWidth = classes.filter((c) => /(^|:)min-w-/.test(c));
    assert.notEqual(minWidth.length, 0,
        'the table has no min-width, so overflow-auto never scrolls and columns compress instead');
    assert.ok(minWidth.every((c) => c.startsWith('lg:')),
        `min-width must be desktop-only or the card list inherits it: ${minWidth.join(' ')}`);
});

test('the modern roster rules outrank the legacy .data-table card rules they replace', () => {
    const selectors = rosterSelectors();
    const legacy = ['.data-table tbody tr', '.data-table tbody td'];

    for (const loser of legacy) {
        const kind = loser.endsWith('tr') ? 'tr' : 'td';
        const winners = selectors.filter((s) => new RegExp(`am2-roster[^,]*\\b${kind}\\s*$`).test(s));
        assert.notEqual(winners.length, 0, `no roster rule targets a bare ${kind}`);
        for (const w of winners) {
            assert.ok(beats(w, loser),
                `"${w}" (${specificity(w)}) does not beat "${loser}" (${specificity(loser)}), `
                + 'so the legacy card rules win and mobile rows render tall and empty');
        }
    }
});

test('the activity log opts into the modern roster instead of the legacy card transform', () => {
    const table = logsPhp.match(/<table[^>]*class="([^"]*)"/);
    assert.ok(table, 'logs.php no longer renders a <table>');
    assert.match(table[1], /\bam2-roster\b/,
        'logs.php still uses only .data-table, so 768-1023px falls between both card systems');
});

test('activity log rows carry data-cell metadata, the contract the roster CSS reads', () => {
    assert.match(logsPhp, /setAttribute\('data-cell'/,
        'log cells are still built with data-label, which the modern roster ignores');
});

test('a narrow activity log row shows time, event, detail and actor in one visible summary cell', () => {
    const summary = logsPhp.match(/data-cell'?,?\s*'unit'|data-cell="unit"/);
    assert.ok(summary, 'no data-cell="unit" summary, so every log cell is hidden below lg');

    for (const field of ['jam', 'tanggal', 'target', 'pelaksana', 'pelaksana_id']) {
        assert.ok(new RegExp(`summary[\\s\\S]{0,900}r\\.${field}\\b`).test(logsPhp)
            || new RegExp(`r\\.${field}\\b[\\s\\S]{0,900}summary`).test(logsPhp),
            `the mobile summary never reads r.${field}, so that field is invisible on a phone`);
    }
});

test('the activity log still builds every row without innerHTML', () => {
    assert.doesNotMatch(logsPhp, /\binnerHTML\b/,
        'log rows render admin-typed free text; innerHTML makes that an injection point');
});

test('the mobile summary lets long detail and actor text wrap instead of clipping', () => {
    const selectors = rosterSelectors();
    assert.ok(selectors.some((s) => /am2-roster[^,]*data-cell="unit"[^,]*\*/.test(s)),
        'nothing relaxes white-space inside the unit summary, so long targets clip');
});
