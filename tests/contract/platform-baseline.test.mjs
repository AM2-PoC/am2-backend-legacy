import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/contracts/platform-baseline.json');

test('target platform is explicit and blocks premature Node activation', () => {
  assert.ok(existsSync(contractPath), 'missing target platform contract');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

  assert.equal(contract.schema_version, 1);
  assert.deepEqual(contract.os, { id: 'ubuntu', version: '26.04', codename: 'resolute' });
  assert.deepEqual(contract.php, { major_minor: '8.5', sapi: 'fpm' });
  assert.deepEqual(contract.postgresql, { major: 18 });
  assert.deepEqual(contract.frameworks, {
    laravel_major: 13,
    inertia_major: 3,
    vue_major: 3,
    vite_major: 8,
    fastify_major: 5,
  });
  assert.deepEqual(contract.node, {
    major: 26,
    activation_channel: 'active-lts',
    source: 'official-nodejs-binary',
    versioned_install_root: '/opt/nodejs',
    staging_or_production_activation_not_before: '2026-10-28',
  });
  assert.deepEqual(contract.architectures, ['amd64']);
  assert.equal(contract.build_execution, 'ephemeral-non-production');
  assert.equal(contract.production_upgrade_mode, 'replace-and-restore');
  assert.equal(contract.production_host_build, false);

  assert.doesNotMatch(JSON.stringify(contract), /"latest"/i);
});
