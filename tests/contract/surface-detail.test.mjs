/**
 * The visual detail on a card, and the palette's search field.
 *
 * The panel is amber -- --color-primary is #f59e0b -- and a card carrying that
 * colour on all four sides across the twenty-nine surfaces of this console
 * leaves nothing able to stand out when something is actually wrong. So the
 * accent is a hairline at the top edge, which the codebase already had a
 * component for and used on two surfaces out of twenty-nine.
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
const css = read('asset/css/tailwind.src.css').replace(/\/\*[\s\S]*?\*\//g, '');
const shellEnd = read('partials/shell_end.php');

/** Declaration block for an exact selector, searching selector lists. */
function ruleFor(selector) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
    }
    return null;
}

test('the palette search field cannot draw its focus ring outside the card', () => {
    /*
     * The baseline :focus-visible rule is 2px with a 2px offset. The palette
     * input is full-bleed inside a card with a 20px radius and overflow hidden,
     * so the ring was clipped by the corners at both ends and ran into the top
     * edge -- a rectangle of amber with its ends cut off.
     */
    const panel = shellEnd.match(/id="am2-palette"[\s\S]*?<ul/);
    assert.ok(panel, 'the palette markup changed shape');
    assert.match(panel[0], /focus-visible:outline-none|focus:outline-none/,
        'the palette input still takes the global focus ring, which its card clips');
    assert.match(panel[0], /am2-palette-field|focus-within/,
        'nothing shows keyboard focus on the palette in place of the ring it suppresses');
});

test('focus is still visible on the palette, just not as a clipped rectangle', () => {
    // Suppressing the ring without replacing it would leave a keyboard user
    // with no idea where they are.
    const field = ruleFor('.am2-palette-field:focus-within') ?? ruleFor('.am2-palette-field');
    assert.ok(field, 'no rule styles the palette field');
    const all = [...css.matchAll(/\.am2-palette-field[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    assert.match(all, /border-color|box-shadow|background/,
        'the palette field shows nothing at all when it holds focus');
});

test('a card can carry the accent without the accent being everywhere', () => {
    // The component already existed and was used twice. What it needed was
    // applying, not inventing.
    assert.match(css, /\.am2-surface-accent/, 'the accent component is gone');
    const before = css.match(/\.am2-surface-accent::before\s*\{([^}]*)\}/);
    assert.ok(before, 'the accent no longer draws anything');
    assert.match(before[1], /--color-primary/, 'the accent is not the brand colour');
});

test('the accent marks the cards it belongs to, not every surface', () => {
    // On dashboard and settings the metric cards are the subject of the page.
    for (const page of ['dashboard.php', 'settings.php']) {
        assert.match(read(page), /am2-surface-accent/,
            `${page} has no accented surface`);
    }
    // A dialogue sits above the page: accenting it too makes the accent noise.
    const dialogs = read('users.php').match(/hs-overlay fixed inset-0[^"']*/g) ?? [];
    for (const d of dialogs) {
        assert.doesNotMatch(d, /am2-surface-accent/,
            'a dialogue carries the card accent, which leaves nothing for it to distinguish');
    }
});

test('a card that can be clicked deepens rather than merely lifting', () => {
    // Every dashboard metric card is a link. The accent is what marks them, so
    // it is what should respond.
    const hover = [...css.matchAll(/([^{}]*am2-surface-accent[^{}]*hover[^{}]*)\{([^}]*)\}/g)];
    assert.notEqual(hover.length, 0,
        'an accented card that links somewhere gives no feedback on hover');
    const body = hover.map((m) => m[2]).join('\n');
    assert.match(body, /box-shadow|height|opacity/,
        'the hover state changes nothing that can be seen');
});

test('the shadow is layered rather than one flat drop', () => {
    // A single large blur reads as a sticker; two shadows -- a tight contact
    // shadow and a wider ambient one -- read as a surface above a surface.
    const surface = ruleFor('.am2-surface');
    assert.ok(surface, '.am2-surface is gone');
    const shadow = surface.match(/box-shadow:\s*([^;]+)/);
    assert.ok(shadow, '.am2-surface has no shadow');
    assert.match(shadow[1], /,/,
        'the card still uses a single flat shadow; a layered one reads as depth rather than a sticker');
});

test('reduced motion keeps the accent but drops the movement', () => {
    // The accent is colour, not motion, so it stays. Anything that travels on
    // hover does not.
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
        .map((m) => m[1]).join('\n');
    assert.match(blocks, /am2-clickable/,
        'the lift on a clickable card still plays under reduced motion');
});
