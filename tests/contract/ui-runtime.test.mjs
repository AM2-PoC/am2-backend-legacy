// The built front-end bundle, and how pages are allowed to reach into it.
//
// Two failures this file exists for, both of which passed every other test:
//
//   1. esbuild dropped every Preline plugin from the bundle and exited 0.
//      preline's package.json lists only dist/index.mjs under `sideEffects`,
//      so the per-plugin imports -- which export nothing and only assign a
//      global -- were treated as dead. --ignore-annotations is what keeps them,
//      and nothing but this file notices if that flag goes away.
//
//   2. settings.php called window.AM2 from an inline script. The bundle is
//      deferred, so it had not run yet; every call site guards with `?.`, so
//      the page rendered correctly and simply had no motion and no QR code.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SRC, readSrc } from './helpers.mjs';

const BUNDLE = `${SRC}/asset/js/am2-ui.min.js`;

describe('the built bundle carries what the pages assume', () => {
    const bundle = () => fs.readFileSync(BUNDLE, 'utf8');

    test('every Preline plugin the shell uses survived the build', () => {
        // Each of these is a global the plugin assigns on import. If the import
        // is dropped, the markup still renders and simply does nothing.
        for (const global of ['HSOverlay', 'HSDropdown', 'HSAccordion', 'HSCollapse',
                              'HSTabs', 'HSTooltip', 'HSComboBox', 'HSTogglePassword']) {
            assert.ok(bundle().includes(global),
                `${global} is not in the bundle -- esbuild dropped the plugin import`);
        }
    });

    test('the QR encoder survived the build', () => {
        assert.ok(bundle().includes('getModuleCount'),
            'the release shelf draws its QR from this; without it the card is empty');
    });

    test('AM2 exposes what the pages call', () => {
        const src = readSrc('asset/js/src/am2-ui.js');
        for (const fn of ['enterOnce', 'countTo', 'revealOnScroll', 'filtered',
                          'toast', 'emit', 'qr']) {
            assert.match(src, new RegExp(`\\b${fn}\\b`), `AM2.${fn} is gone`);
        }
    });
});

describe('pages wait for the deferred bundle', () => {
    // The bundle is loaded with defer, which runs after the document is parsed
    // -- that is, after every inline script on the page. Reaching for window.AM2
    // at parse time finds nothing, silently.
    const pages = fs.readdirSync(SRC)
        .filter((f) => f.endsWith('.php'))
        .filter((f) => /include\s+'partials\/shell\.php'/.test(readSrc(f)));

    test('the bundle is still deferred, which is what makes this matter', () => {
        // The src is a PHP echo, so `>` appears between the filename and the
        // attribute -- [^>]* cannot cross it.
        assert.match(readSrc('partials/shell_end.php'),
            /am2-ui\.min\.js[\s\S]{0,60}?\bdefer\b/,
            'if the bundle is no longer deferred, this whole rule can go');
    });

    for (const page of pages) {
        test(`${page} does not use AM2 before it exists`, () => {
            const src = readSrc(page);
            // Entrance animations are the calls that run once at load, so they
            // are the ones that can be too early. Calls inside a fetch handler
            // or an event listener happen long after the bundle has run.
            const early = /AM2\??\.(enterOnce|revealOnScroll|qr)\(/.exec(src);
            if (!early) return;

            const before = src.slice(0, early.index);
            assert.match(before, /DOMContentLoaded|addEventListener\('load'|ready\(/,
                `${page} calls AM2.${early[1]}() with nothing waiting for the bundle`);
        });
    }
});

describe('settings.php keeps the ids its script writes into', () => {
    test('the regions the upload swaps in are all present', () => {
        const src = readSrc('settings.php');
        // The APK upload posts by XHR and replaces these three nodes with the
        // server's own re-render, so the ids are a contract between the page
        // and its own response.
        for (const id of ['am2-page-alert', 'am2-shelf-version', 'am2-shelf-list']) {
            assert.ok(src.includes(`id="${id}"`), `#${id} is gone; the upload lands nowhere`);
        }
    });

    test('the drop zones still point at real inputs', () => {
        const src = readSrc('settings.php');
        for (const [zone, input] of [['am2-apk-zone', 'apk_file'],
                                     ['am2-sql-zone', 'am2-restore-file']]) {
            assert.ok(src.includes(`id="${zone}" data-input="${input}"`),
                `${zone} no longer names its input`);
            assert.ok(src.includes(`id="${input}" type="file"`),
                `${input} is not a file input; the drop zone has nothing to fill`);
        }
    });

    test('the file inputs are still there for keyboard and screen readers', () => {
        // A drop zone is a second way in, never a replacement: it is not
        // reachable by keyboard and announces nothing.
        // Comments stripped first: the note explaining that the input must
        // stay is not an input, and a guard that trips on its own explanation
        // is one people learn to route around.
        const code = readSrc('settings.php')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        assert.equal((code.match(/type="file"/g) ?? []).length, 2,
            'a file input was replaced by a drop zone');
    });
});
