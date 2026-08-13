import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../../config/android-environments.json', import.meta.url);
const expectedPackages = {
  client: {
    dev: ['com.am2.tik.dev', 16],
    staging: ['com.am2.tik.staging', 16],
    production: ['com.am2.tik', 16],
  },
  admin: {
    dev: ['com.am2.admin.dev', 24],
    staging: ['com.am2.admin.staging', 24],
    production: ['com.am2.admin', 24],
  },
};

async function loadContract() {
  return JSON.parse(await readFile(contractUrl, 'utf8'));
}

function assertHttpsOrigin(value, field) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${field} must use https`);
  assert.equal(url.username, '', `${field} must not contain userinfo`);
  assert.equal(url.password, '', `${field} must not contain userinfo`);
  assert.equal(url.search, '', `${field} must not contain a query`);
  assert.equal(url.hash, '', `${field} must not contain a fragment`);
}

function assertWssOrigin(value, field) {
  const url = new URL(value);
  assert.equal(url.protocol, 'wss:', `${field} must use wss`);
  assert.equal(url.username, '', `${field} must not contain userinfo`);
  assert.equal(url.password, '', `${field} must not contain userinfo`);
  assert.equal(url.search, '', `${field} must not contain a query`);
  assert.equal(url.hash, '', `${field} must not contain a fragment`);
}

test('defines exact Android package and minimum API identities', async () => {
  const contract = await loadContract();
  assert.deepEqual(Object.keys(contract.apps).sort(), ['admin', 'client']);

  for (const [app, environments] of Object.entries(expectedPackages)) {
    assert.deepEqual(Object.keys(contract.apps[app]).sort(), ['dev', 'production', 'staging']);
    for (const [environment, [applicationId, minApi]] of Object.entries(environments)) {
      const record = contract.apps[app][environment];
      assert.equal(record.application_id, applicationId);
      assert.equal(record.min_api, minApi);
      assert.equal(record.label_suffix, environment === 'production' ? '' : ` ${environment.toUpperCase()}`);
    }
  }
});

test('uses distinct secure endpoint sets and keeps non-production away from production hosts', async () => {
  const { apps } = await loadContract();

  for (const [app, environments] of Object.entries(apps)) {
    const serialized = new Set();
    for (const [environment, record] of Object.entries(environments)) {
      const endpoints = record.endpoints;
      assert.ok(endpoints && typeof endpoints === 'object', `${app}/${environment} endpoints missing`);
      for (const [field, value] of Object.entries(endpoints)) {
        if (field === 'websocket_url') assertWssOrigin(value, `${app}/${environment}/${field}`);
        else assertHttpsOrigin(value, `${app}/${environment}/${field}`);

        if (environment !== 'production') {
          assert.match(new URL(value).hostname, new RegExp(`^${environment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`));
          assert.doesNotMatch(new URL(value).hostname, /^(apiapi|webadmin)\.am2-poc\.com$/);
        }
      }
      const identity = JSON.stringify(endpoints);
      assert.equal(serialized.has(identity), false, `${app} endpoint set reused across environments`);
      serialized.add(identity);
    }
  }
});

test('keeps production promotion disabled pending signer, approval, and physical gates', async () => {
  const { production_promotion } = await loadContract();
  assert.equal(production_promotion.enabled, false);
  assert.deepEqual(production_promotion.required_gates, [
    'protected_production_signer',
    'independent_production_approval',
    'same_digest_staging_acceptance',
    'physical_device_acceptance',
    'rollback_rehearsal',
  ]);
});
