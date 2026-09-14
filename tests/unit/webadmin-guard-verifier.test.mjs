import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../infra/scripts/verify-webadmin-guard.sh', import.meta.url));
const webadmin = fileURLToPath(new URL('../../WebAdmin', import.meta.url));
const source = readFileSync(scriptPath, 'utf8');

/*
 * Every server-side gate was green while the live map was broken: the page
 * imported a module the artifact did not carry, and a failed import is visible
 * only in a browser. The guard verifier already runs against the lane at
 * promotion, so it also asks the origin for every asset the pages load.
 */
test('the verifier lists every local asset the pages load', () => {
    const run = spawnSync('bash', [scriptPath, '--list-assets', webadmin], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const assets = run.stdout.split('\n').filter(Boolean);
    for (const expected of ['asset/vendor/leaflet/leaflet.js', 'asset/js/livetrack-model.js',
                            'asset/js/am2-ui.min.js', 'asset/css/am2-tailwind.css']) {
        assert.ok(assets.includes(expected), `asset discovery misses ${expected}`);
    }
    for (const asset of assets) {
        assert.match(asset, /^asset\/[A-Za-z0-9._/-]+$/, `not a clean local asset path: ${asset}`);
        assert.ok(existsSync(`${webadmin}/${asset}`), `listed asset does not exist: ${asset}`);
    }
});

test('every request the verifier makes is bounded in time', () => {
    // It runs after the production cutover, under the gate's rollback trap. A
    // request to a stalled origin with no deadline hangs the gate and holds the
    // rollback back for as long as the origin stays stalled.
    const calls = [...source.matchAll(/\$\(curl\s[^)]*\)/g)].map(([call]) => call);
    assert.ok(calls.length > 0, 'found no curl calls; this test no longer sees the requests');
    for (const call of calls) {
        assert.match(call, /--max-time\s+\d+/, `unbounded request: ${call.replace(/\s+/g, ' ')}`);
    }
});

test('the verifier waits out the PHP realpath cache before its first request', () => {
    // It runs right after a release symlink swap -- in the production gate, with
    // no relay restart, well under a second after it. mod_php keeps a switched
    // path for realpath_cache_ttl (2s in the sealed ini) plus the rest of the
    // current second, so without a wait the PHP half can test the previous
    // release and pass. The wait is longer than that window.
    const afterDocroot = source.slice(source.search(/\[\[ -d \$docroot \]\]/));
    const firstRequest = afterDocroot.search(/\$\(curl\s/);
    const wait = afterDocroot.slice(0, firstRequest).match(/^\s*sleep\s+(\d+)\s*$/m);
    assert.ok(wait, 'the verifier sends its first request without waiting out the realpath cache');
    assert.ok(Number(wait[1]) >= 3, 'the verifier waits less than the realpath cache window');
});

test('the lane sweep requires every page asset to answer 200', () => {
    assert.match(source, /--list-assets/);
    assert.match(source, /for asset in[\s\S]{0,400}\$status != 200/,
        'the verifier does not fail when a page asset is missing from the lane');
});

test('direct-request libraries accept only their intentional opaque 404', () => {
    assert.match(source, /auth_guard\.php\|session_boot\.php\)/);
    assert.match(source, /\$api == 404 && \$nav == 404/);
});
