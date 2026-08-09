// Language and theme.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { asSuper, BASE, HOST, SRC } from './helpers.mjs';

const page = (path, cookie = '') => fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: { Host: HOST, ...(cookie ? { Cookie: cookie } : {}) },
});

let sup;
before(async () => { sup = await asSuper(); });

describe('locale', () => {
    test('the html element carries the locale and the theme', async () => {
        const id = await (await page('/login.php', 'am2_lang=id')).text();
        assert.match(id, /<html lang="id" data-theme="light">/);
        const en = await (await page('/login.php', 'am2_lang=en;am2_theme=dark')).text();
        assert.match(en, /<html lang="en" data-theme="dark">/);
    });

    test('the theme is resolved server-side, not after paint', async () => {
        // Setting data-theme from JavaScript would render light first and then
        // repaint on every navigation.
        const dark = await (await page('/login.php', 'am2_theme=dark')).text();
        const htmlTag = dark.match(/<html[^>]*>/)[0];
        assert.match(htmlTag, /data-theme="dark"/);
    });

    test('an unknown locale falls back instead of breaking', async () => {
        const res = await page('/login.php', 'am2_lang=klingon');
        assert.equal(res.status, 200);
        assert.match(await res.text(), /<html lang="id"/);
    });

    test('rendered strings actually change', async () => {
        const id = await (await page('/login.php', 'am2_lang=id')).text();
        const en = await (await page('/login.php', 'am2_lang=en')).text();
        // The wordmark line, not a placeholder: the fields are labelled, so a
        // placeholder repeating the label was removed in the redesign.
        assert.match(id, /Pusat Kendali Radio/);
        assert.match(en, /Radio Control Centre/);
        assert.ok(!/Pusat Kendali Radio/.test(en));
    });

    test('the sidebar switches with the session', async () => {
        const id = await (await page('/dashboard.php', `${sup};am2_lang=id`)).text();
        const en = await (await page('/dashboard.php', `${sup};am2_lang=en`)).text();
        // Asserts the translated label, not the markup around it: pages move
        // to the new shell one at a time and the class changes with them.
        assert.match(id, /Manajemen/);
        assert.match(en, /Management/);
        assert.ok(!/Manajemen/.test(en));
    });

    test('?lang= persists the choice in a cookie', async () => {
        const res = await page('/login.php?lang=en');
        const set = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('am2_lang='));
        assert.ok(set, 'no am2_lang cookie issued');
        assert.match(set, /SameSite=Lax/i);
    });

    test('both catalogues carry the same keys', () => {
        const keys = (f) => [...fs.readFileSync(`${SRC}/lang/${f}.php`, 'utf8')
            .matchAll(/'([a-z_]+\.[a-z_]+)'\s*=>/g)].map((m) => m[1]).sort();
        const id = keys('id'), en = keys('en');
        assert.deepEqual(en, id, 'a key present in one catalogue but not the other');
    });

    test('no page hardcodes the language attribute any more', () => {
        for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.php'))) {
            const src = fs.readFileSync(`${SRC}/${f}`, 'utf8');
            assert.ok(!/<html lang="id">/.test(src), `${f} still pins the language`);
        }
    });

    test('the dark theme block the stylesheet already had is what gets used', () => {
        const css = fs.readFileSync(`${SRC}/asset/css/am2-ui.css`, 'utf8');
        assert.match(css, /\[data-theme="dark"\]/,
            'the toggle writes data-theme, so the stylesheet must key off it');
    });
});
