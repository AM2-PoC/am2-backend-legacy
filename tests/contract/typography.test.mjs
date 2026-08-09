// Typography contract: the canonical font stack and its delivery.
//
// This test is source-only — it reads the tree, not a running server — so it
// runs locally without a staging fixture. It asserts that the body family is
// IBM Plex Sans (without !important, which used to defeat the Tailwind token),
// that the Tailwind tokens are Plex families, and that exactly the six official
// IBM WOFF2 files are declared — no more, no less, and no Inter/JetBrains left.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname with the leading slash stripped: that turned
// /home/.../WebAdmin/ into a relative path and every read was ENOENT unless the
// process happened to be running from /.
const SRC = process.env.CT_SRC_DIR || fileURLToPath(new URL('../../WebAdmin/', import.meta.url));
const readSrc = (file) => fs.readFileSync(SRC + file, 'utf8');

describe('typography contract', () => {
    test('am2-ui.css declares IBM Plex Sans without !important on font-family', () => {
        const css = readSrc('asset/css/am2-ui.css');
        assert.match(css, /font-family:\s*"IBM Plex Sans"/,
            'body must own the canonical IBM Plex Sans stack');
        const bodyRule = css.match(/body\s*\{[^}]*\}/s);
        assert.ok(bodyRule, 'body rule missing');
        const fontLine = bodyRule[0].match(/font-family:[^;]+/);
        assert.ok(fontLine, 'font-family declaration missing in body rule');
        assert.ok(!fontLine[0].includes('!important'),
            'body font-family must not carry !important — it defeats the token');
    });

    test('Tailwind tokens are IBM Plex, not Inter or JetBrains', () => {
        const src = readSrc('asset/css/tailwind.src.css');
        assert.match(src, /font-family:\s*"IBM Plex Sans"/,
            '@font-face must declare IBM Plex Sans');
        assert.match(src, /font-family:\s*"IBM Plex Mono"/,
            '@font-face must declare IBM Plex Mono');
        assert.ok(!src.includes('"Inter"'), 'Inter must be gone');
        assert.ok(!src.includes('"JetBrains Mono"'), 'JetBrains Mono must be gone');
    });

    test('exactly the six IBM WOFF2 files are declared', () => {
        const src = readSrc('asset/css/tailwind.src.css');
        const faces = [...src.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]);
        assert.strictEqual(faces.length, 6, `expected 6 @font-face urls, got ${faces.length}`);
        for (const expected of [
            'IBMPlexSans-Regular.woff2',
            'IBMPlexSans-Medium.woff2',
            'IBMPlexSans-SemiBold.woff2',
            'IBMPlexSans-Bold.woff2',
            'IBMPlexMono-Regular.woff2',
            'IBMPlexMono-Medium.woff2',
        ]) {
            assert.ok(faces.some((u) => u.includes(expected)),
                `missing @font-face for ${expected}`);
        }
        assert.ok(!faces.some((u) => u.includes('Inter.woff2')),
            'Inter.woff2 must not be referenced');
        assert.ok(!faces.some((u) => u.includes('JetBrainsMono.woff2')),
            'JetBrainsMono.woff2 must not be referenced');
    });

    test('compiled CSS carries IBM Plex families, not the old ones', () => {
        const css = readSrc('asset/css/am2-tailwind.css');
        assert.ok(css.includes('IBM Plex Sans'), 'compiled CSS missing IBM Plex Sans');
        assert.ok(css.includes('IBM Plex Mono'), 'compiled CSS missing IBM Plex Mono');
        assert.ok(!css.includes('"Inter"'), 'compiled CSS still contains Inter');
        assert.ok(!css.includes('"JetBrains Mono"'), 'compiled CSS still contains JetBrains Mono');
    });

    test('the font asset directory contains only the expected files', () => {
        const files = fs.readdirSync(SRC + 'asset/font/').filter((f) => f.endsWith('.woff2'));
        const expected = new Set([
            'IBMPlexSans-Regular.woff2',
            'IBMPlexSans-Medium.woff2',
            'IBMPlexSans-SemiBold.woff2',
            'IBMPlexSans-Bold.woff2',
            'IBMPlexMono-Regular.woff2',
            'IBMPlexMono-Medium.woff2',
        ]);
        assert.deepStrictEqual(new Set(files), expected,
            `expected exactly ${expected.size} woff2 files, got ${files.length}`);
    });

    test('controls and table headers keep mono out of their reading path', () => {
        const css = readSrc('asset/css/am2-ui.css');

        for (const selector of [
            'button.font-mono',
            'label.font-mono',
            'thead.font-mono',
            'thead.font-mono th',
            'tr.font-mono > th',
            '[class*="font-mono"][class*="uppercase"][class*="tracking-"]',
        ]) {
            assert.ok(css.includes(selector),
                `${selector} must receive the sans override`);
        }

        assert.match(css, /button\.font-mono,[\s\S]*?font-family:\s*var\(--font-sans\)/,
            'control labels must render in the interface family');
        assert.match(css, /thead\.font-mono,[\s\S]*?font-family:\s*var\(--font-sans\)/,
            'table headers must render in the interface family');
        assert.match(css, /\[class\*="font-mono"\]\[class\*="uppercase"\]\[class\*="tracking-"\]\s*\{[\s\S]*?font-family:\s*var\(--font-sans\)/,
            'uppercase UI labels must render in the interface family');
    });
});
