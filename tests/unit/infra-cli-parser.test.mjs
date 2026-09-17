import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const scripts = new Map([
  ['activate-host-security.sh', 64], ['apply-migrations.sh', 2],
  ['audit-host-security-drift.sh', 64], ['audit-runtime-boundary.sh', 64],
  ['install-webadmin-guard.sh', 64], ['materialize-host-security.sh', 64],
  ['materialize-runtime-release.sh', 64], ['package-host-security-bundle.sh', 64],
  ['promote-to-production.sh', 64], ['publish-field-update.sh', 64],
  ['rehearse-staging-artifact.sh', 64], ['rollback-host-security.sh', 64],
  ['verify-host-security-bundle.sh', 64], ['verify-host-security-installed.sh', 64],
  ['verify-materialized-artifact.sh', 64], ['verify-webadmin-guard.sh', 64],
]);

test('deployment scripts reject unknown options without hanging', () => {
  for (const [name, expectedStatus] of scripts) {
    const result = spawnSync('bash', [resolve(ROOT, 'infra/scripts', name), '--definitely-invalid'], {
      encoding: 'utf8', timeout: 500,
    });
    assert.notEqual(result.error?.code, 'ETIMEDOUT', `${name} hung on an unknown option`);
    assert.equal(result.status, expectedStatus, `${name} returned the wrong unknown-option status`);
  }
});

test('webadmin guard rejects an unknown lane', () => {
  const result = spawnSync('bash', [resolve(ROOT, 'infra/scripts/verify-webadmin-guard.sh'), '--lane', 'invalid'], {
    encoding: 'utf8', timeout: 500,
  });
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'verify-webadmin-guard.sh hung on an unknown lane');
  assert.equal(result.status, 64, 'verify-webadmin-guard.sh accepted an unknown lane');
  assert.match(result.stderr, /unknown lane: invalid/);
});

test('migration script names an unknown option', () => {
  const result = spawnSync('bash', [resolve(ROOT, 'infra/scripts/apply-migrations.sh'), '--definitely-invalid'], {
    encoding: 'utf8', timeout: 500,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --definitely-invalid/);
});
