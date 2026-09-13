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

test('the lane sweep requires every page asset to answer 200', () => {
    assert.match(source, /--list-assets/);
    assert.match(source, /for asset in[\s\S]{0,400}\$status != 200/,
        'the verifier does not fail when a page asset is missing from the lane');
});

test('direct-request libraries accept only their intentional opaque 404', () => {
    assert.match(source, /auth_guard\.php\|session_boot\.php\)/);
    assert.match(source, /\$api == 404 && \$nav == 404/);
});
