import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The URL the relay hands a device must come from configuration.
 *
 * It was assembled from the request's own Host header and a hardcoded http
 * scheme. The client accepts an update from exactly one URL and nothing else,
 * so a value built this way could never match: the scheme alone was wrong, and
 * the host was whatever the caller put in the header. The update path could not
 * have worked in any environment, and the reason was invisible from the client
 * side — it just refused every offer.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const routes = readFileSync(join(ROOT, 'server', 'lib', 'routes.js'), 'utf8');

const checkUpdate = routes.slice(
    routes.indexOf("app.get('/api/check-update'"),
    routes.indexOf("app.post('/api/admin/set-app-version'"),
);

test('the advertised update URL is not built from the request', () => {
    assert.doesNotMatch(checkUpdate, /req\.headers\.host/,
        'the update URL is taken from a header the caller controls');
    assert.doesNotMatch(checkUpdate, /`http:\/\//,
        'the update URL is advertised over plain http');
});

test('the update URL comes from configuration', () => {
    assert.match(routes, /AM2_UPDATE_BASE_URL/);
    assert.match(checkUpdate, /UPDATE_BASE/);
});

test('an unconfigured base advertises nothing rather than something wrong', () => {
    // Offering a URL the client is certain to refuse looks like a client bug.
    // Saying nothing is the honest answer, and it is visible in the log.
    assert.match(checkUpdate, /UPDATE_BASE\s*\?/);
    assert.match(routes, /console\.(warn|error)[\s\S]{0,200}AM2_UPDATE_BASE_URL/);
});

test('the configured base is required to be https', () => {
    assert.match(routes, /startsWith\('https:\/\/'\)/);
});
