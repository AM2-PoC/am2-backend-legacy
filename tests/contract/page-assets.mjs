/**
 * The local assets the WebAdmin pages load, for the tests that check a release
 * actually ships them.
 *
 * Shared by release-assets.test.mjs, which compares the references against git
 * and the packager's exclusions, and artifact-delivery.test.mjs, which compares
 * them against a real packaged archive. One definition, so the two cannot
 * disagree about what a page asks for.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEBADMIN = join(ROOT, 'WebAdmin');

/** Every .php file that renders markup, relative to WebAdmin/. */
export function markupFiles() {
    const out = [];
    for (const f of readdirSync(WEBADMIN)) if (f.endsWith('.php')) out.push(f);
    for (const f of readdirSync(join(WEBADMIN, 'partials'))) {
        if (f.endsWith('.php')) out.push(`partials/${f}`);
    }
    return out;
}

/**
 * Local asset paths a file references.
 *
 * Covers every spelling the panel uses: the am2_asset() helper, which appends a
 * cache-busting query, am2_asset_url() for module imports (whose leading ./ a
 * browser needs and the disk does not), and plain src=/href= attributes, in
 * either quote style and with or without a leading slash. Absolute URLs are
 * somebody else's server and are not this module's subject.
 */
export function referencedAssets(src) {
    const code = src.replace(/<!--[\s\S]*?-->/g, '');
    const hits = new Set();
    for (const re of [/am2_asset(?:_url)?\(\s*(['"])(.+?)\1/g, /(?:src|href)=(['"])(.+?)\1/g]) {
        for (const m of code.matchAll(re)) {
            const raw = m[2];
            if (/^(?:https?:)?\/\//.test(raw) || raw.startsWith('data:')) continue;
            const path = raw.replace(/^\.?\//, '');
            if (!path.startsWith('asset/')) continue;
            hits.add(path.split('?')[0]);
        }
    }
    return hits;
}

/** Every page-to-asset reference, as `{ file, asset }`. */
export function pageAssets() {
    const out = [];
    for (const file of markupFiles()) {
        for (const asset of referencedAssets(readFileSync(join(WEBADMIN, file), 'utf8'))) {
            out.push({ file, asset });
        }
    }
    return out;
}
