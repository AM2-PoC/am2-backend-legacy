import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('host-owned current verifier validates a pre-P0 runnable rollback release', () => {
  const script = resolve(root, 'infra/scripts/verify-current-release.sh');
  const legacy = mkdtempSync(resolve(tmpdir(), 'am2-legacy-release-'));
  try {
    mkdirSync(resolve(legacy, 'server'), { recursive: true });
    cpSync(resolve(root, 'server/package.json'), resolve(legacy, 'server/package.json'));
    cpSync(resolve(root, 'server/package-lock.json'), resolve(legacy, 'server/package-lock.json'));
    cpSync(resolve(root, 'server/server.js'), resolve(legacy, 'server/server.js'));
    const install = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: resolve(legacy, 'server'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    writeFileSync(resolve(legacy, '.release-sha'), `${'a'.repeat(40)}\n`);

    const run = spawnSync('bash', [script, legacy], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /legacy rollback runtime verified/i);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});
