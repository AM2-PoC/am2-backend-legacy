import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The admin channel has two lanes and only one had a publisher.
 *
 * This script pinned the production package and the production URL as
 * constants, so a staging build could not go through it at all -- and the
 * staging channel was therefore fed by copying files into place by hand. That
 * is how it came to advertise a manifest whose version_name was empty, and how
 * a stale APK once sat behind a fresh manifest with nothing to catch it.
 *
 * The package and the URL are one decision, not two. Naming them as a pair per
 * lane is what makes crossing lanes impossible: a staging APK cannot satisfy
 * the production URL and a production APK cannot satisfy the staging one, so
 * neither can reach the other's channel even if the wrong --update-dir is
 * passed. Verified against the real script: publishing the staging artifact
 * with --lane production is refused on the package before anything is written.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = readFileSync(join(ROOT, 'infra/scripts/publish-admin-update.sh'), 'utf8');

/**
 * The lane table only. Slicing to the first `esac` in the file lands in the
 * argument parser's own case block, which sits above it.
 */
function laneTable() {
    const from = script.indexOf('case "$lane" in');
    assert.notEqual(from, -1, 'the lane table moved');
    const to = script.indexOf('\nesac', from);
    assert.notEqual(to, -1, 'the lane table has no end');
    return script.slice(from, to);
}

test('each lane names its package and its URL together', () => {
    const lanes = laneTable();
    for (const [lane, pkg, url] of [
        ['production', 'com.am2.admin', 'https://webadmin.am2-poc.com/update/admin.apk'],
        ['staging', 'com.am2.admin.staging', 'https://staging-webadmin.am2-poc.com/update/admin.apk'],
    ]) {
        const block = lanes.slice(lanes.indexOf(`${lane})`), lanes.indexOf(`${lane})`) + 220);
        assert.match(block, new RegExp(`expect_package=${pkg.replace(/\./g, '\\.')}$`, 'm'), `${lane} package`);
        assert.match(block, new RegExp(`expect_url=${url.replace(/[./]/g, (c) => '\\' + c)}`), `${lane} url`);
    }
});

test('the lane decides both checks, so neither can be satisfied alone', () => {
    assert.match(script, /\[\[ \$package == "\$expect_package" \]\]/);
    assert.match(script, /\[\[ \$update_url == "\$expect_url" \]\]/);
    // The constants must not survive anywhere outside the lane table, or one
    // of the two checks silently stops depending on the lane.
    const afterTable = script.slice(script.indexOf('\nesac', script.indexOf('case "$lane" in')));
    assert.doesNotMatch(afterTable, /== com\.am2\.admin \]\]/, 'the package is pinned again');
    assert.doesNotMatch(afterTable, /== https:\/\/webadmin\.am2-poc\.com/, 'the URL is pinned again');
});

test('production stays the default, so an unqualified publish cannot reach staging', () => {
    assert.match(script, /^lane=production$/m);
});

test('an unknown lane is refused rather than guessed', () => {
    const lanes = laneTable();
    assert.match(lanes, /unknown lane: \$lane/);
    assert.match(lanes, /exit 64/);
});
