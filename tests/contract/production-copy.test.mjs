import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const internalImplementation = /api_settings\.php|\/api\/check-update|admin_version\.json|app_versions|deployed tree|web process/i;

test('update manifest validation rejects adversarial URLs and paths at runtime', () => {
    const result = spawnSync('php', [join(ROOT, 'tests/contract/update-manifest-runtime.test.php')], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /12\/12 passed/);
});

test('operator-facing settings copy does not expose implementation details', () => {
    for (const locale of ['en', 'id']) {
        const catalogue = read(`WebAdmin/lang/${locale}.php`);
        for (const line of catalogue.split('\n')) {
            if (!/^\s*'set\.(?:channel_admin_note|channel_field_note|no_version_field|no_version|folder_missing|folder_readonly)'\s*=>/.test(line)) continue;
            assert.doesNotMatch(line, internalImplementation,
                `${locale} settings copy exposes an endpoint, storage name, or deployment detail`);
        }
    }
});

test('rendered settings markup does not ship developer commentary', () => {
    const markup = read('WebAdmin/settings.php');
    for (const comment of markup.matchAll(/<!--[\s\S]*?-->/g)) {
        assert.doesNotMatch(comment[0], internalImplementation,
            'an HTML comment exposes an endpoint, storage name, or deployment detail');
    }
});

test('missing APK warning is operator language, not developer narration', () => {
    const en = read('WebAdmin/lang/en.php');
    const id = read('WebAdmin/lang/id.php');
    assert.doesNotMatch(en, /The app is told to download/);
    assert.doesNotMatch(id, /Aplikasi disuruh mengunduh/);
    assert.match(en, /Upload the published APK/i);
    assert.match(id, /Unggah APK yang dipublikasikan/i);
});

test('update endpoint never invents a downloadable release', () => {
    const endpoint = read('WebAdmin/api_settings.php').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(endpoint, /latest_version'\s*=>\s*'1\.0\.0'/,
        'missing metadata still advertises a made-up version');
    assert.doesNotMatch(endpoint, /download_url'\s*=>\s*'https?:\/\//,
        'missing metadata still advertises a hard-coded APK URL');
    assert.match(endpoint, /http_response_code\(404\)/,
        'missing or invalid update state must fail closed');
    assert.match(endpoint, /\$download_file === null/,
        'published metadata is not checked against the exact APK on disk');
    assert.match(endpoint, /AM2_ADMIN_UPDATE_BASE/,
        'download URL is not bound to the current environment');
});

test('production and staging publish only their own update origin', () => {
    const prod = read('infra/apache/am2-webadmin-internal.conf');
    const stage = read('infra/apache/am2-webadmin-staging.conf');
    assert.match(prod, /AM2_ADMIN_UPDATE_BASE_URL https:\/\/webadmin\.am2-poc\.com\/update/);
    assert.doesNotMatch(prod, /staging-webadmin/);
    assert.match(stage, /AM2_ADMIN_UPDATE_BASE_URL https:\/\/staging-webadmin\.am2-poc\.com\/update/);
});
