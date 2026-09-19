import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/contracts/platform-baseline.json');

test('WebAdmin build toolchain is exact and its dependency locks exist', () => {
  assert.ok(existsSync(contractPath), 'missing target platform contract');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

  assert.equal(contract.schema_version, 2);
  assert.deepEqual(contract.os, { id: 'ubuntu', version: '26.04', codename: 'resolute' });
  assert.deepEqual(contract.php, {
    version: '8.5.10', sapi: 'cli', source: 'shivammathur/setup-php',
    extensions: ['ctype', 'curl', 'dom', 'fileinfo', 'filter', 'hash', 'mbstring', 'openssl', 'pcre', 'pdo', 'pdo_pgsql', 'pgsql', 'session', 'tokenizer', 'xml', 'zip'],
  });
  assert.deepEqual(contract.postgresql, { major: 18 });
  assert.deepEqual(contract.frameworks, {
    laravel_major: 13, filament_major: 5, vite_major: 8, fastify_major: 5,
  });
  assert.deepEqual(contract.toolchain, {
    container: 'ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78',
    composer: { version: '2.10.3', sha256: '7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6' },
    theme_node: { version: '24.21.0', channel: 'lts', source: 'actions/setup-node', use: 'build-only' },
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

  for (const path of ['laravel/composer.json', 'laravel/composer.lock', 'laravel/package.json', 'laravel/package-lock.json']) {
    assert.ok(existsSync(resolve(ROOT, path)), `missing required dependency lock: ${path}`);
  }

  const composer = JSON.parse(readFileSync(resolve(ROOT, 'laravel/composer.json'), 'utf8'));
  assert.equal(composer.require?.php, '^8.5');
  assert.equal(composer.config?.platform?.php, '8.5.10');
  assert.equal(composer.require?.['laravel/framework'], '^13.0');
  assert.equal(composer.require?.['filament/filament'], '^5.0');
  const npm = JSON.parse(readFileSync(resolve(ROOT, 'laravel/package.json'), 'utf8'));
  assert.equal(npm.private, true);
  assert.equal(npm.engines?.node, '24.21.0');
  assert.deepEqual(npm.devDependencies, {
    '@tailwindcss/vite': '4.3.3',
    'laravel-vite-plugin': '3.2.0',
    tailwindcss: '4.3.3',
    vite: '8.3.0',
  });
  assert.equal(npm.scripts?.build, 'vite build');
  assert.doesNotMatch(JSON.stringify(npm), /(?:inertia|vue|preline|flux)/i);
  assert.doesNotMatch(JSON.stringify(contract), /"latest"/i);
});
