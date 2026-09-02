import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every write says what happened, once, where it can be read.
 *
 * Three things were silent or as good as silent:
 *
 *   - the bulk actions raised a toast and reloaded 900ms later. A toast stands
 *     for 4000ms, so the confirmation for the commonest write in the console
 *     was a flash lasting under a quarter of its life, and the page that
 *     replaced it carried no trace of it.
 *   - exporting the database answered with Content-Disposition and exit(), so
 *     the page never re-rendered: no banner, nothing on screen, and a dump of
 *     any size looked like a click that had been ignored.
 *   - the copy-address fallback selected the text in silence when the clipboard
 *     was unavailable, which reads as a button that does nothing.
 *
 * The page banner is a toast now as well, on every page. Measured in a browser
 * against the real bundle: a success stands at 3.8s and is gone by 4.5s; a
 * failure is still there at 6s and goes when dismissed; a message handed across
 * a reload and a server-rendered one both arrive as toasts by DOMContentLoaded,
 * and the banner is out of the document by then.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ui = read('WebAdmin/asset/js/src/am2-ui.js');
const bundle = read('WebAdmin/asset/js/am2-ui.min.js');
const css = read('WebAdmin/asset/css/tailwind.src.css');
const notice = read('WebAdmin/partials/notice.php');
const settings = read('WebAdmin/settings.php');

const BULK_PAGES = ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php'];
const BANNER_PAGES = [...BULK_PAGES, 'settings.php'];

test('a failure waits to be dismissed; a success does not', () => {
    const toast = ui.slice(ui.indexOf('function toast('), ui.indexOf('/** Fade a toast out'));
    assert.match(toast, /if \(ok\) dismissAfter\(el, 4000\)/,
        'a success either never expires or expires on a different clock');
    assert.match(toast, /if \(!ok\) \{[\s\S]*?close\.addEventListener\('click', \(\) => dismiss\(el\)\)/,
        'a failure has no way to be dismissed, so it either expires or never leaves');
    assert.match(toast, /if \(reduced\) \{\s*if \(ok\) setTimeout/,
        'under reduced motion a failure still expires on a timer');
});

test('a message survives the reload that follows the action', () => {
    for (const page of BULK_PAGES) {
        const body = read(`WebAdmin/${page}`);
        assert.match(body, /window\.AM2\?\.handoff\(/, `${page} still toasts into a page that is leaving`);
        assert.doesNotMatch(body, /setTimeout\(\(\) => window\.location\.reload\(\), failed\.length/,
            `${page} still delays the reload to make room for a toast it will destroy anyway`);
    }
    assert.match(ui, /sessionStorage\.setItem\(HANDOFF/);
    assert.match(ui, /sessionStorage\.removeItem\(HANDOFF\)/, 'a handed-over message would be shown again on every later page');
});

test('what the server said is shown once, and taken out of the page', () => {
    const drain = ui.slice(ui.indexOf('function drainNotices('), ui.indexOf('function drainNotices(') + 900);
    assert.match(drain, /querySelectorAll\('\[data-notice\]'\)/);
    assert.match(drain, /el\.remove\(\)/, 'the banner stays behind the toast that repeats it');
});

test('a browser that never runs the bundle still sees the message', () => {
    // The whole trade -- banner for toast -- is only safe while this holds.
    assert.match(css, /\.am2-js \.am2-notice \{ display: none; \}/,
        'the banner is hidden unconditionally, so no script means no feedback at all');
    assert.match(notice, /data-notice="/);
    assert.match(notice, /class="am2-notice/);
    assert.match(notice, /htmlspecialchars\(\$noticeText\)/,
        'the message is written into the page unescaped');
});

test('every page that reported a result goes through the one partial', () => {
    for (const page of BANNER_PAGES) {
        const body = read(`WebAdmin/${page}`);
        assert.match(body, /include 'partials\/notice\.php';/, `${page} does not use the shared notice`);
        assert.doesNotMatch(body, /<p role="status"/, `${page} still renders a banner of its own`);
    }
});

test('no message carries markup into a page that escapes it', () => {
    // One did -- a channel name interpolated into <strong> and echoed raw --
    // which was an injection as well as a rendering problem.
    const channels = read('WebAdmin/channels.php');
    const messages = channels.match(/\$success_msg = "[^"]*"/g) ?? [];
    for (const m of messages) assert.doesNotMatch(m, /</, `a message still carries markup: ${m}`);
});

test('exporting says what it knows, and refuses a second press', () => {
    assert.match(settings, /data-export/);
    assert.match(settings, /window\.AM2\?\.toast\(T\.exporting\)/,
        'the export is still silent, and a slow dump still looks like an ignored click');
    assert.match(settings, /btn\.disabled = true/);
    // It must not claim to know the download finished; a native attachment
    // submit gives the page no completion event.
    assert.doesNotMatch(settings, /T\.exported|download_complete|unduhan selesai/i,
        'the page claims to know a download it never fetched has finished');
});

test('the copy fallback says the address is selected', () => {
    const copy = settings.slice(settings.indexOf('[data-copy-url]'), settings.indexOf('[data-export]'));
    assert.match(copy, /window\.AM2\?\.toast\(T\.selected, false\)/,
        'the fallback still selects the text in silence');
});

test('both languages carry the new strings', () => {
    for (const lang of ['id', 'en']) {
        const strings = read(`WebAdmin/lang/${lang}.php`);
        for (const key of ['set.exporting', 'set.copy_selected']) {
            assert.match(strings, new RegExp(`'${key.replace('.', '\\.')}'`), `${lang}.php has no ${key}`);
        }
    }
});

test('the shipped bundle carries all of it', () => {
    // Deploys copy the committed bundle; source alone proves nothing about
    // what a browser runs.
    assert.ok(bundle.includes('am2:notice'), 'am2-ui.min.js was not rebuilt from its source');
    assert.ok(bundle.includes('[data-notice]'), 'the drain is not in the bundle');
});
