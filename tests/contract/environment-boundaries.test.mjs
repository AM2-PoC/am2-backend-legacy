import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/inventory/environment-contract.json');

test('environment inventory records DEV, staging, and production identities plus explicit shared blockers', () => {
  assert.ok(existsSync(contractPath), 'missing environment contract inventory');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  assert.equal(contract.schema_version, 1);
  assert.deepEqual(Object.keys(contract.environments).sort(), ['dev', 'production', 'staging']);

  for (const [name, environment] of Object.entries(contract.environments)) {
    assert.equal(environment.name, name);
    for (const field of ['domain', 'relay', 'database', 'redis', 'release_root', 'webadmin_env_file', 'writable_paths', 'deploy_identity']) {
      assert.ok(field in environment, `${name} lacks ${field}`);
    }
    assert.ok(Array.isArray(environment.writable_paths));
  }

  const { dev, staging, production } = contract.environments;
  assert.notEqual(staging.domain, production.domain);
  assert.notEqual(staging.relay.unit, production.relay.unit);
  assert.notEqual(staging.relay.port, production.relay.port);
  assert.notEqual(staging.database.name, production.database.name);
  assert.notEqual(staging.release_root, production.release_root);
  assert.notEqual(staging.webadmin_env_file, production.webadmin_env_file);
  assert.notEqual(dev.runtime_kind, production.runtime_kind);

  assert.ok(Array.isArray(contract.shared_blockers));
  for (const blocker of contract.shared_blockers) {
    assert.equal(blocker.status, 'open');
    assert.ok(blocker.field);
    assert.ok(blocker.environments.includes('staging'));
    assert.ok(blocker.environments.includes('production'));
    assert.ok(blocker.remediation);
  }
});
