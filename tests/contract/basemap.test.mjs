// The tracking map has to draw without anybody holding an API key.
//
// It was CARTO's Positron and Dark Matter, chosen because the two share a
// structure so the theme toggle changes the palette and nothing else. CARTO
// has since put its free basemaps behind a key, and the way it enforces that
// is not an error: the tile still returns 200 with a valid PNG, and the words
// "API KEY REQUIRED" are painted diagonally across the image.
//
// So nothing in the stack could notice. No status code, no content type and no
// byte count distinguishes a served tile from a refused one -- an operator
// looking at the panel is the entire detection mechanism, and what they saw was
// a map of Indonesia with a watermark stamped over Jakarta.
//
// That is why the assertions below are about *provenance* rather than about
// what came back: which host is being asked, whether one host answers for both
// themes, and whether the zoom the panel offers is a zoom that host actually
// has. A test cannot see a watermark. It can refuse a host known to draw one.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC } from './helpers.mjs';

/**
 * Hosts that answer 200 with a tile that demands a key, and the date each was
 * found doing it. Adding one here is how this failure gets caught next time.
 */
const REFUSES_WITHOUT_A_KEY = [
    ['basemaps.cartocdn.com', '2026-08-27: tiles return 200, stamped "API KEY REQUIRED"'],
];

const source = fs.readFileSync(path.join(SRC, 'livetrack.php'), 'utf8');

/** The tile templates the page actually configures. */
function basemaps() {
    const block = source.slice(source.indexOf('const BASEMAP'), source.indexOf('const ATTR'));
    const found = Object.fromEntries(
        [...block.matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map(([, theme, url]) => [theme, url]),
    );
    assert.deepEqual(Object.keys(found).sort(), ['dark', 'light'],
        'the basemap is no longer declared as one light and one dark template');
    return found;
}

/** A real tile over Jakarta, for a template using {z}/{x}/{y} in any order. */
function tileUrl(template, z, x, y) {
    return template
        .replace('{s}', 'a').replace('{r}', '')
        .replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

describe('the tracking basemap', () => {
    test('is not served by a host that demands a key', () => {
        for (const [host, why] of REFUSES_WITHOUT_A_KEY) {
            assert.ok(!source.includes(host), `livetrack.php still asks ${host} — ${why}`);
        }
    });

    test('answers for both themes from one host', () => {
        const maps = basemaps();
        const host = (url) => new URL(url.replace('{s}.', '')).host;
        assert.equal(host(maps.light), host(maps.dark),
            'the two themes come from different providers, so one can fail alone');
    });

    test('offers no zoom the provider does not have', () => {
        // Past a provider's deepest level the tiles stop existing. Leaflet will
        // upscale the last real level instead of drawing nothing, but only when
        // told where that level is -- otherwise zooming in far enough empties
        // the map, which is what an operator does to find one unit.
        const block = source.slice(source.indexOf('const BASEMAP'), source.indexOf('MutationObserver'));
        const set = block.match(/maxNativeZoom:\s*([A-Za-z_$][\w$]*|\d+)/);
        assert.ok(set, 'no maxNativeZoom, so zooming past the provider blanks the map');

        // A named constant is fine; a name that resolves to nothing is not.
        const [, value] = set;
        if (!/^\d+$/.test(value)) {
            assert.match(
                block, new RegExp(`const\\s+${value}\\s*=\\s*\\d+`),
                `maxNativeZoom is ${value}, which is never given a number`,
            );
        }
    });

    test('every configured tile actually draws', { timeout: 30_000 }, async () => {
        // Jakarta at street level, which is the zoom this map is used at.
        for (const [theme, template] of Object.entries(basemaps())) {
            const res = await fetch(tileUrl(template, 16, 52218, 33900));
            assert.equal(res.status, 200, `${theme} tiles are not being served`);
            assert.match(res.headers.get('content-type') ?? '', /^image\//,
                `${theme} tiles came back as something other than an image`);
        }
    });
});
