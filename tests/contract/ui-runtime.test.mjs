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

    // The plugin behind each hs-* hook, by the global it assigns on import.
    const PLUGIN = {
        'hs-overlay': 'HSOverlay',
        'hs-dropdown': 'HSDropdown',
        'hs-accordion': 'HSAccordion',
        'hs-collapse': 'HSCollapse',
        'hs-tabs': 'HSTabs',
        'hs-tooltip': 'HSTooltip',
        'hs-combobox': 'HSComboBox',
        'hs-toggle-password': 'HSTogglePassword',
    };

    // Derived from the markup rather than listed by hand: a hand-written list
    // stops covering the next page that starts using a component, which is
    // exactly how a missing import goes unnoticed -- the markup renders and
    // simply does nothing.
    const used = () => {
        const files = [...fs.readdirSync(SRC).filter((f) => f.endsWith('.php')).map((f) => f),
                       ...fs.readdirSync(`${SRC}/partials`).map((f) => `partials/${f}`)]
            .filter((f) => f.endsWith('.php'));
        const hooks = new Set();
        for (const f of files) {
            const src = readSrc(f);
            for (const hook of Object.keys(PLUGIN)) {
                // toggle-password's hook is a data attribute; the rest appear
                // as class names or data attributes with the same stem.
                if (new RegExp(`["'\\s]${hook}[-"'\\s]|data-${hook}`).test(src)) hooks.add(hook);
            }
        }
        return hooks;
    };

    test('every Preline plugin the markup uses is in the bundle', () => {
        // esbuild dropped all eight of these once and exited 0: preline's
        // package.json lists only dist/index.mjs under `sideEffects`, and a
        // plugin module exports nothing. --ignore-annotations is what keeps
        // them, and nothing but this notices if that flag goes away.
        const hooks = used();
        assert.ok(hooks.size > 0, 'no hs-* hooks found at all; the check would pass vacuously');
        for (const hook of hooks) {
            assert.ok(bundle().includes(PLUGIN[hook]),
                `${hook} is in the markup but ${PLUGIN[hook]} is not in the bundle`);
        }
    });

    test('no plugin is bundled for markup that does not exist', () => {
        // Four were imported for pages that had not been built yet, and every
        // page paid for them on first load.
        const hooks = used();
        for (const [hook, global] of Object.entries(PLUGIN)) {
            if (hooks.has(hook)) continue;
            assert.ok(!bundle().includes(global),
                `${global} is bundled but nothing uses ${hook}; drop the import`);
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
        // The restore action posts by XHR and replaces these three nodes with
        // the server's own re-render, so the ids are a contract between the
        // page and its own response. The APK upload used the same regions and
        // is gone; the ids stay because restore still lands in them.
        for (const id of ['am2-page-alert', 'am2-shelf-version', 'am2-shelf-list']) {
            assert.ok(src.includes(`id="${id}"`), `#${id} is gone; the upload lands nowhere`);
        }
    });

    test('the drop zones still point at real inputs', () => {
        const src = readSrc('settings.php');
        // am2-apk-zone/apk_file was the second pair. The APK upload path was
        // removed outright -- the panel no longer writes an uploaded file to
        // disk anywhere -- and update-channel-surface.test.mjs asserts it stays
        // gone by absence. Restore is the only upload left.
        for (const [zone, input] of [['am2-sql-zone', 'am2-restore-file']]) {
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
        // One, not two: the APK upload and its input went with the upload
        // path. Restore is the only file the panel still accepts.
        assert.equal((code.match(/type="file"/g) ?? []).length, 1,
            'a file input was replaced by a drop zone');
    });
});

/*
 * Alpine is gone.
 *
 * It came out one page at a time, and each page that landed left the runtime
 * loading for the ones that had not -- so "no Alpine on this page" was true
 * long before "no Alpine" was. This is the assertion that the last of it left:
 * no directive in any template, no gate in the shell, no file to load.
 */
describe('no Alpine residue', () => {
    const pages = fs.readdirSync(SRC)
        .filter((f) => f.endsWith('.php'))
        .concat(fs.readdirSync(`${SRC}/partials`).map((f) => `partials/${f}`)
            .filter((f) => f.endsWith('.php')));

    test('no template carries an Alpine directive', () => {
        // Comments stripped first: a note about why Alpine left is not Alpine,
        // and a guard that trips on its own explanation is one people learn to
        // route around.
        const bad = [];
        for (const page of pages) {
            const code = readSrc(page)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/<!--[\s\S]*?-->/g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            if (/\sx-(data|show|model|text|cloak|transition)[=\s>]|\s@click[=.]|\s:class=/.test(code)) {
                bad.push(page);
            }
        }
        assert.deepEqual(bad, [], `Alpine markup came back in: ${bad.join(', ')}`);
    });

    test('the shell no longer gates on $pageUsesAlpine', () => {
        assert.ok(!readSrc('partials/shell_end.php').includes('pageUsesAlpine'),
            'the gate is back, so some page is asking for the runtime again');
    });

    test('the runtime is not shipped', () => {
        assert.ok(!fs.existsSync(`${SRC}/asset/js/alpine.min.js`),
            'alpine.min.js is being served again');
    });
});

/*
 * Nothing is fetched from a third party.
 *
 * Bootstrap and Font Awesome came from jsdelivr and cloudflare on the pages
 * that had not been rebuilt yet. A police dispatch panel that cannot paint its
 * own buttons without two other companies being reachable is a panel that goes
 * down when they do -- and every one of those requests told them who was
 * looking at it.
 *
 * Cloudflare's own beacon is injected at the edge on the proxied domain, so it
 * appears in a browser and not here. This reads the source, which is the part
 * this repository decides.
 */
describe('no third-party assets', () => {
    const pages = fs.readdirSync(SRC)
        .filter((f) => f.endsWith('.php'))
        .concat(fs.readdirSync(`${SRC}/partials`)
            .filter((f) => f.endsWith('.php'))
            .map((f) => `partials/${f}`));

    test('no page loads a stylesheet or script from another host', () => {
        const bad = [];
        for (const page of pages) {
            // Only what the page *loads*: a <link> or a <script>. An <a> to
            // openstreetmap.org is an attribution notice the map licence
            // requires, and matching every href made the guard demand its
            // removal.
            const m = readSrc(page)
                .match(/<(?:link|script)\b[^>]*(?:href|src)=["']https?:\/\/[^"']+/gi) ?? [];
            for (const hit of m) bad.push(`${page}: ${hit.slice(0, 80)}`);
        }
        assert.deepEqual(bad, [], `an off-site asset came back:\n${bad.join('\n')}`);
    });

    test('Bootstrap and Font Awesome are gone by name', () => {
        for (const page of pages) {
            const src = readSrc(page);
            assert.ok(!/bootstrap(\.bundle)?\.min|font-awesome|fa-[a-z-]+"/.test(src),
                `${page} still speaks Bootstrap or Font Awesome`);
        }
    });
});
