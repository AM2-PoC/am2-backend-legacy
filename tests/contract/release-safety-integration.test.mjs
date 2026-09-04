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

test('CI serializes contract fixtures that run isolated npm installs', () => {
  const workflow = read('.github/workflows/source-checks.yml');
  const serial = /node --test --test-concurrency=1/g;
  assert.equal((workflow.match(serial) || []).length, 2,
    'offline and restart-safety contract runners may race isolated npm-ci fixtures');
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
