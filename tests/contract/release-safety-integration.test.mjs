import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('CI executes every restart-safety contract and builds a production artifact', () => {
  const workflow = read('.github/workflows/source-checks.yml');
  for (const file of [
    'needrestart-policy.test.mjs',
    'release-runtime.test.mjs',
    'release-smoke.test.mjs',
    'relay-watchdog.test.mjs',
    'systemd-relay-safety.test.mjs',
  ]) {
    assert.match(workflow, new RegExp(file.replaceAll('.', '\\.')));
  }
  assert.match(workflow, /build-release\.sh/);
  assert.match(workflow, /verify-release-runtime\.sh/);
});

test('deploy runbook permits promotion only through exact-SHA safety scripts', () => {
  const runbook = read('docs/how-to/deploy-and-roll-back.md');
  assert.match(runbook, /build-release\.sh/);
  assert.match(runbook, /verify-release-runtime\.sh/);
  assert.match(runbook, /smoke-release\.sh/);
  assert.match(runbook, /check-relay-health\.sh/);
  assert.match(runbook, /exec 9<\/var\/lib\/am2-relay-watchdog\/deploy\.lock/,
    'deployment lock is opened for writing even though the deploy user cannot write it');
  assert.match(runbook, /sites-enabled\/am2-webadmin\.conf/,
    'production nginx vhost is installed but never enabled');
  assert.match(runbook, /sites-enabled\/am2-webadmin-staging\.conf/,
    'staging nginx vhost is installed but never enabled');
  assert.match(runbook, /needrestart\/conf\.d\/am2-realtime\.conf/);
  assert.match(runbook, /session|quiet window/i);
  assert.match(runbook, /rollback/i);
  assert.doesNotMatch(runbook, /git -C \/home\/am2deploy\/am2-main archive main \| tar/);
});

test('CI serializes and caches npm-backed contract fixtures', () => {
  const workflow = read('.github/workflows/source-checks.yml');
  const serial = /node --test --test-concurrency=1/g;
  assert.equal((workflow.match(serial) || []).length, 2,
    'offline and restart-safety contract runners may race isolated npm-ci fixtures');
  const offline = workflow.match(/  tests:[\s\S]*?\n  restart-safety:/)?.[0] || '';
  assert.match(offline, /cache: npm/,
    'offline fixture runner does not restore the server npm cache');
  assert.match(offline, /cache-dependency-path: server\/package-lock\.json/,
    'offline fixture runner cache is not bound to the production lockfile');
  assert.match(offline, /NPM_CONFIG_PREFER_OFFLINE: ['"]true['"]/,
    'offline fixture runner may refetch cached production packages');
  assert.match(offline, /NPM_CONFIG_AUDIT: ['"]false['"]/,
    'offline fixture runner spends test time on npm audit');
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/,
    'feature pushes duplicate the same source-check matrix as pull requests');
  for (const file of [
    'tests/contract/artifact-delivery.test.mjs',
    'tests/contract/release-runtime.test.mjs',
    'tests/contract/systemd-relay-safety.test.mjs',
  ]) {
    assert.match(read(file), /--no-audit[\s\S]*--no-fund|--no-fund[\s\S]*--no-audit/,
      `${file} fixture npm ci still permits audit or funding network work`);
    assert.match(read(file), /timeout:\s*(300_000|300000)/,
      `${file} fixture npm ci timeout can strand competing installs`);
  }
});

test('offline selector declares every restart-safety contract', () => {
  const selector = read('tests/offline-tests.sh');
  for (const file of [
    'needrestart-policy.test.mjs',
    'release-runtime.test.mjs',
    'release-smoke.test.mjs',
    'relay-watchdog.test.mjs',
    'systemd-relay-safety.test.mjs',
  ]) {
    assert.match(selector, new RegExp(file.replaceAll('.', '\\.')));
  }
});
