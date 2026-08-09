/**
 * Every asset a page asks for is actually in the release.
 *
 * Production is built with `git archive`, which ships only tracked files.
 * Staging is a git checkout, where untracked files are simply present on disk.
 * So a file that is referenced by markup, exists locally, and is not tracked
 * works perfectly on staging and 404s in production -- and nothing in the
 * pipeline notices, because every test and every lint reads the checkout.
 *
 * That is not hypothetical. `WebAdmin/asset/vendor/leaflet/` was swallowed by a
 * `vendor/` line in .gitignore meant for Composer: a bare directory name in
 * gitignore matches at any depth. livetrack.php loads leaflet with a plain
 * <script src>, so on production the map never rendered at all, while staging
 * had been showing it correctly for days.
 *
 * This test compares what the pages ask for against what git would ship, which
 * is the only comparison that would have caught it.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

/** Every file git would put in a release archive, as a Set of repo paths. */
function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z', 'WebAdmin'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return new Set(out.split('\0').filter(Boolean));
}

/** Every .php file that renders markup. */
function markupFiles() {
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
 * Covers both spellings the panel uses: the am2_asset() helper, which appends a
 * cache-busting query, and plain src=/href= attributes. Absolute URLs are
 * somebody else's server and are not this test's subject.
 */
function referencedAssets(src) {
    const code = src.replace(/<!--[\s\S]*?-->/g, '');
    const hits = new Set();
    for (const re of [/am2_asset\(\s*'([^']+)'/g, /(?:src|href)="([^"]+)"/g]) {
        for (const m of code.matchAll(re)) {
            const raw = m[1];
            if (/^(?:https?:)?\/\//.test(raw) || raw.startsWith('data:')) continue;
            if (!raw.startsWith('asset/')) continue;
            hits.add(raw.split('?')[0]);
        }
    }
    return hits;
}

test('every local asset a page loads is tracked by git', () => {
    /*
     * Tracked, not merely present. `git archive` is what builds a release, so
     * an untracked file is a file production will not have -- however healthy
     * the checkout looks.
     */
    const tracked = trackedFiles();
    const missing = [];

    for (const file of markupFiles()) {
        for (const asset of referencedAssets(readFileSync(join(WEBADMIN, file), 'utf8'))) {
            const repoPath = `WebAdmin/${asset}`;
            if (!tracked.has(repoPath)) missing.push(`${file} -> ${asset}`);
        }
    }

    assert.deepEqual(missing, [],
        'these assets are referenced but would not be in a release archive, so they '
        + '404 in production while working on any git checkout:\n  ' + missing.join('\n  '));
});

test('the vendored map library is shipped, not assumed', () => {
    // Named specifically because this is the one that broke, and because a
    // <script src> failure here is silent: the page loads, L is undefined, and
    // the map simply never appears.
    const tracked = trackedFiles();
    for (const f of ['WebAdmin/asset/vendor/leaflet/leaflet.js',
                     'WebAdmin/asset/vendor/leaflet/leaflet.css']) {
        assert.ok(tracked.has(f), `${f} is not tracked; the live map will not render in production`);
    }
});

test('each WebAdmin vhost sends assets to its own Apache upstream', () => {
    const cases = [
        ['infra/nginx/am2-webadmin.conf', 'am2_apache_webadmin'],
        ['infra/nginx/am2-webadmin-staging.conf', 'am2_apache_staging'],
    ];

    for (const [vhost, upstream] of cases) {
        const source = readFileSync(join(ROOT, vhost), 'utf8');
        assert.match(source, new RegExp(`set\\s+\\$am2_asset_upstream\\s+${upstream};`),
            `${vhost} does not select its own Apache upstream for shared asset routes`);
    }
});

test('gitignore does not swallow directories by bare name', () => {
    /*
     * `vendor/` was meant for Composer and matched WebAdmin/asset/vendor as
     * well, because a pattern with no slash before it applies at every depth.
     * The same trap waits for node_modules, dist, build and cache: any of them
     * could one day name a real asset directory.
     *
     * Only the genuinely-anywhere ones are allowed to stay unanchored.
     */
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8')
        .split('\n').map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

    /*
     * Dot-directories are editor and tool state -- .vscode, .idea, .gradle and
     * the assistant ones. No page will ever reference `asset/.claude/...`, so
     * matching them at any depth costs nothing.
     *
     * What is dangerous is a pattern that reads like a plausible asset folder.
     * `vendor/` was exactly that, and `dist/`, `build/` and `cache/` are the
     * same shape: the day someone vendors a library into one of them, it
     * disappears from the release and only production notices.
     */
    const risky = lines.filter((l) => {
        if (!l.endsWith('/')) return false;              // not a directory pattern
        if (l.startsWith('/')) return false;             // already anchored to the root
        if (l.slice(0, -1).includes('/')) return false;  // has a path, so already scoped
        if (l.startsWith('.')) return false;             // tool state, never an asset path
        return !['node_modules/', 'coverage/'].includes(l);
    });

    assert.deepEqual(risky, [],
        'these .gitignore entries match a directory of that name at any depth, which is '
        + 'how asset/vendor was lost; anchor them with a leading slash:\n  ' + risky.join('\n  '));
});
