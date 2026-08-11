import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

for (const [name, unitPath, runtimeRoot] of [
  ['production', 'infra/systemd/am2-api.service', '/var/www/am2/current'],
  ['staging', 'infra/systemd/am2-api-staging.service', '/var/www/am2/staging/current'],
]) {
  test(`${name} relay unit bounds restart failures`, () => {
    const unit = read(unitPath);
    assert.match(unit, /^StartLimitIntervalSec=300$/m);
    assert.match(unit, /^StartLimitBurst=3$/m);
    assert.match(unit, /^Restart=on-failure$/m);
  });

  test(`${name} relay unit validates its exact runtime before start`, () => {
    const unit = read(unitPath);
    assert.match(
      unit,
      new RegExp(`^ExecStartPre=\\/usr\\/local\\/libexec\\/am2\\/verify-current-release\\.sh ${runtimeRoot.replaceAll('/', '\\/')}$`, 'm'),
    );
  });
}

test('current-release verifier fails closed for a missing runtime root', () => {
  const script = resolve(root, 'infra/scripts/verify-current-release.sh');
  const run = spawnSync('bash', [script, '/definitely/missing/am2-release'], {
    encoding: 'utf8',
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /release|missing|directory/i);
});

test('current-release verifier accepts only one absolute runtime root argument', () => {
  const script = resolve(root, 'infra/scripts/verify-current-release.sh');

  const relative = spawnSync('bash', [script, 'relative/release'], { encoding: 'utf8' });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute/i);

  const extra = spawnSync('bash', [script, '/tmp/release', 'extra'], { encoding: 'utf8' });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /usage/i);
});
