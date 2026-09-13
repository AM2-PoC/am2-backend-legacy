/**
 * Every asset a page asks for is actually in the release.
 *
 * A release ships less than the checkout. The runtime artifact is packaged from
 * tracked files only, minus the build inputs the packager leaves out. So a file
 * that a page references and that exists on disk can pass every lint that reads
 * the checkout and still 404 on staging and production.
 *
 * That has happened twice, both times to the live map. `WebAdmin/asset/vendor/`
 * was swallowed by a `vendor/` line in .gitignore meant for Composer, and
 * livetrack.php later imported its model from asset/js/src/, which the packager
 * excludes. Neither failure says anything on the server: the page loads, the
 * script never runs, and the map simply never appears.
 *
 * These tests compare what the pages ask for against what git tracks and what
 * the packager keeps. artifact-delivery.test.mjs checks the same references
 * against a real packaged archive.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, pageAssets } from './page-assets.mjs';

/** Every file git would put in a release archive, as a Set of repo paths. */
function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z', 'WebAdmin'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return new Set(out.split('\0').filter(Boolean));
}

test('every local asset a page loads is tracked by git', () => {
    /*
     * Tracked, not merely present. The packager refuses a source tree with
     * untracked files, so an untracked file is a file production will not
     * have -- however healthy the checkout looks.
     */
    const tracked = trackedFiles();
    const missing = pageAssets()
        .filter(({ asset }) => !tracked.has(`WebAdmin/${asset}`))
        .map(({ file, asset }) => `${file} -> ${asset}`);

    assert.deepEqual(missing, [],
        'these assets are referenced but would not be in a release archive, so they '
        + '404 in production while working on any git checkout:\n  ' + missing.join('\n  '));
});

/**
 * WebAdmin/asset paths the runtime packager leaves out, as anchored regexes.
 *
 * Tracked is not enough: the packager also drops build inputs that git still
 * tracks, which is how the live-track model went missing while the test above
 * stayed green.
 *
 * Read from the packager itself, so the exclusions cannot drift from this test.
 */
function artifactAssetExclusions() {
    const packager = readFileSync(join(ROOT, 'infra/scripts/package-runtime-artifact.sh'), 'utf8');
    return [...packager.matchAll(/! -path "\$source_root\/(WebAdmin\/asset\/[^"]+)"/g)]
        .map(([, glob]) => {
            // find's -path `*` also crosses `/`, so it becomes `.*`. Its other
            // wildcards are not translated, so refuse them rather than misread.
            assert.doesNotMatch(glob, /[?[]/,
                `packager exclusion ${glob} uses a wildcard this test does not translate`);
            const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            return new RegExp('^' + escaped + '$');
        });
}

test('every local asset a page loads survives the runtime artifact packager', () => {
    const excluded = artifactAssetExclusions();
    assert.ok(excluded.length > 0,
        'found no asset exclusions in the packager; this test can no longer see what the artifact drops');
    const dropped = pageAssets()
        .filter(({ asset }) => excluded.some((re) => re.test(`WebAdmin/${asset}`)))
        .map(({ file, asset }) => `${file} -> ${asset}`);

    assert.deepEqual(dropped, [],
        'these assets are referenced but the runtime packager excludes them as build inputs, '
        + 'so they 404 on every artifact release:\n  ' + dropped.join('\n  '));
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
