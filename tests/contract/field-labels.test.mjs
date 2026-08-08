/**
 * Every field says what it is, and every filter can be hit with a thumb.
 *
 * A placeholder is not a label: it disappears the moment anyone types, so a
 * screen reader reaching a half-filled search box finds a text field called
 * nothing at all -- and so does anyone who looked away mid-sentence.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

const read = (p) => readFileSync(join(WEBADMIN, p), 'utf8');

function markupFiles() {
    const out = [];
    for (const f of readdirSync(WEBADMIN)) if (f.endsWith('.php')) out.push(f);
    for (const f of readdirSync(join(WEBADMIN, 'partials'))) {
        if (f.endsWith('.php')) out.push(`partials/${f}`);
    }
    return out;
}

/** Every <input>/<select>/<textarea> tag in a file, as raw text. */
function fields(src) {
    // Comments describe markup without being it -- settings.php explains why it
    // keeps a real <input type="file"> -- and a tag whose id is a PHP
    // expression cannot be matched against a <label for>, so it is left to the
    // page that generates both halves together.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
        // PHP echo tags contain ">" of their own -- `<?= $a > $b ?>` and every
        // `?>` -- so a tag matched with [^>]* stops inside the first attribute
        // that holds one, and the attributes after it look absent. Blanked to
        // a placeholder first: what is being checked is which attributes are
        // present, not what they evaluate to.
        .replace(/<\?=[\s\S]*?\?>/g, 'php');
    return (code.match(/<(?:input|select|textarea)\b[^>]*>/g) ?? [])
        // An id built from PHP cannot be matched against a <label for> that is
        // built from the same expression; the page generates both halves in one
        // place, so it is left to the page.
        .filter((tag) => !/\bid="php"/.test(tag));
}

test('every field a person types into has a name of its own', () => {
    /*
     * Measured across the panel: five fields had neither aria-label nor a
     * <label for>. Two of them -- the log search and the live-track search --
     * carried only a placeholder, which is the case this is really about: it is
     * gone as soon as there is anything to read.
     *
     * Hidden inputs and CSRF tokens are excluded: nobody types into them.
     */
    const offenders = [];
    for (const f of markupFiles()) {
        const src = read(f);
        for (const tag of fields(src)) {
            if (/type="hidden"/.test(tag)) continue;
            if (/type="(?:checkbox|radio|submit|button)"/.test(tag)) continue;
            if (/aria-label|aria-labelledby/.test(tag)) continue;

            // A <label for="..."> elsewhere in the same file counts.
            const id = tag.match(/\bid="([^"]+)"/)?.[1];
            if (id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(src)) continue;

            offenders.push(`${f}: ${tag.replace(/\s+/g, ' ').slice(0, 72)}`);
        }
    }
    assert.deepEqual(offenders, [],
        `fields with no accessible name:\n  ${offenders.join('\n  ')}`);
});

test('a placeholder is never the only thing naming a field', () => {
    // Worth pinning separately: a field can acquire a placeholder later and
    // look labelled without being labelled.
    const offenders = [];
    for (const f of markupFiles()) {
        for (const tag of fields(read(f))) {
            if (!/placeholder=/.test(tag)) continue;
            if (/aria-label|aria-labelledby/.test(tag)) continue;
            const id = tag.match(/\bid="([^"]+)"/)?.[1];
            if (id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(read(f))) continue;
            offenders.push(`${f}: ${tag.replace(/\s+/g, ' ').slice(0, 64)}`);
        }
    }
    assert.deepEqual(offenders, [],
        `fields named only by their placeholder:\n  ${offenders.join('\n  ')}`);
});

test('a filter chip is the same size as every other chip on a phone', () => {
    // The roster filters were h-9 -- 36px -- while the chips beside them are
    // 44px since the touch-target pass. Same control, same gesture, and 36px is
    // under the size a thumb can reliably hit.
    const src = read('partials/table_open.php');
    const chips = src.match(/\$chips[\s\S]*?<\/div>/);
    assert.ok(chips, 'the filter chip block changed shape');
    assert.doesNotMatch(chips[0], /\bh-9\b/,
        'the roster filter chips are still 36px tall while the rest are 44');
    assert.match(chips[0], /h-11|min-h-11/,
        'the filter chips have no explicit height, so they collapse to their text');
});

test('the log category buttons and the roster filters agree on size', () => {
    // They are the same control on two pages; one being 44px and the other 36
    // is the kind of difference nobody reports and everybody feels.
    const logs = read('logs.php');
    const cat = logs.match(/class="am2-cat[^"]*"/);
    assert.ok(cat, 'the log category buttons changed shape');
    assert.match(cat[0], /h-11/, 'the log category buttons are not 44px');
});
