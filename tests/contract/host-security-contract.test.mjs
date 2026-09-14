import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/contracts/host-security-contract.json');

const expectedFileIds = [
  'apache-production-webadmin',
  'apache-staging-webadmin',
  'nginx-api',
  'nginx-api-staging',
  'nginx-cloudflare-realip',
  'nginx-proxy-common',
  'nginx-webadmin-assets',
  'nginx-webadmin-dev-deny',
  'nginx-webadmin-production',
  'nginx-webadmin-security',
  'nginx-webadmin-staging',
  'php-auto-prepend-ini',
  'php-webadmin-prepend',
].sort();

test('host-security contract closes every tracked WebAdmin and real-IP input outside runtime artifacts', () => {
  assert.ok(existsSync(contractPath), 'missing immutable host-security contract');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

  assert.equal(contract.schema_version, 1);
  assert.equal(contract.application, 'am2-host-security');
  assert.equal(contract.source_binding, 'exact-source-sha');
  assert.deepEqual(contract.files.map((file) => file.id).sort(), expectedFileIds);

  for (const file of contract.files) {
    const origin = file.source;
    assert.match(origin, /^(infra\/php|infra\/apache|infra\/nginx|infra\/scripts)\/.+/);
    assert.ok(existsSync(resolve(ROOT, origin)), `missing tracked host-security origin: ${origin}`);
    assert.equal(file.mode, '0644');
    assert.ok(['apache2', 'nginx', 'php-sapi'].includes(file.consumer));
  }

  const prepend = contract.files.find((file) => file.id === 'php-webadmin-prepend');
  assert.equal(prepend.target, '/etc/am2/php/webadmin-prepend.php');

  const ini = contract.files.find((file) => file.id === 'php-auto-prepend-ini');
  assert.equal(ini.consumer, 'php-sapi');
  assert.equal(ini.source, 'infra/php/99-am2-webadmin-guard.ini');
  assert.equal(ini.target_kind, 'php-sapi-conf.d');
  assert.equal(ini.filename, '99-am2-webadmin-guard.ini');
  assert.deepEqual(ini.sapis, ['apache2', 'fpm']);
  assert.match(readFileSync(resolve(ROOT, ini.source), 'utf8'),
    /^auto_prepend_file = \/etc\/am2\/php\/webadmin-prepend\.php$/m,
    'the sealed PHP configuration template does not name the bounded prepend');
  // After a release symlink switch, mod_php keeps resolving the old release's
  // paths for realpath_cache_ttl (120s by default), so the lane guard run right
  // after activation could check the previous release's PHP. The guard waits
  // longer than this TTL before its first request.
  const iniText = readFileSync(resolve(ROOT, ini.source), 'utf8');
  const ttls = [...iniText.matchAll(/^\s*realpath_cache_ttl\s*=\s*(\d+)\s*$/gm)];
  assert.ok(ttls.length > 0,
    'the PHP guard ini leaves realpath_cache_ttl at its default, so a switched release can serve old PHP paths');
  // PHP applies the last directive, so a second line could silently undo it.
  assert.equal(ttls.length, 1, 'the PHP guard ini sets realpath_cache_ttl more than once');
  assert.ok(Number(ttls[0][1]) <= 2, 'the PHP guard ini keeps switched release paths for more than two seconds');
  // opcache looks scripts up by the unresolved path unless told otherwise; with
  // a cacheable mtime it would keep serving the previous release's bytecode
  // however short the realpath cache is.
  assert.match(iniText, /^\s*opcache\.revalidate_path\s*=\s*1\s*$/m,
    'opcache may serve a switched release by its old unresolved path');

  for (const id of ['apache-production-webadmin', 'apache-staging-webadmin']) {
    assert.match(contract.files.find((file) => file.id === id).target, /^\/etc\/apache2\/sites-available\//);
  }
  for (const file of contract.files.filter((file) => file.consumer === 'nginx')) {
    assert.match(file.target, /^\/etc\/nginx\/(snippets|sites-available)\//);
  }

  assert.deepEqual(contract.activation, {
    config_tests: ['apache2ctl configtest', 'nginx -t'],
    services: ['apache2', 'nginx'],
    receipt_owner: 'root',
    receipt_mode: '0644',
  });
});
