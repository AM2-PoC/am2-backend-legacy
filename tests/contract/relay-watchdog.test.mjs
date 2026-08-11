import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const watchdog = resolve(root, 'infra/scripts/check-relay-health.sh');
const alert = resolve(root, 'infra/scripts/send-relay-alert.sh');

function fixture({ active = 'active', status = '200', body = 'PTT Server VERSION', restarts = '0', previousRestarts = null, cwdMatches = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'am2-watchdog-'));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const current = join(dir, 'current');
  const release = join(dir, 'release');
  const calls = join(dir, 'calls');
  mkdirSync(bin);
  mkdirSync(state);
  if (previousRestarts !== null) writeFileSync(join(state, 'am2-api.restarts'), `${previousRestarts}\n`);
  mkdirSync(join(release, 'server'), { recursive: true });
  spawnSync('ln', ['-s', release, current]);
  const cwd = cwdMatches ? join(release, 'server') : join(dir, 'old-release/server');

  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash
case "$1" in
  is-active) printf '%s\\n' '${active}' ;;
  show)
    case "$*" in
      *MainPID*) printf '4242\\n' ;;
      *NRestarts*) printf '%s\\n' '${restarts}' ;;
    esac ;;
esac
`);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
printf '%s\\n%s' '${body}' '${status}'
`);
  writeFileSync(join(bin, 'readlink'), `#!/usr/bin/env bash
case "$*" in
  *'/proc/4242/cwd'*) printf '%s\\n' '${cwd}' ;;
  *) /usr/bin/readlink "$@" ;;
esac
`);
  writeFileSync(join(bin, 'logger'), `#!/usr/bin/env bash
printf 'logger %s\\n' "$*" >> '${calls}'
`);
  writeFileSync(join(bin, 'webhook'), `#!/usr/bin/env bash
printf 'webhook %s\\n' "$*" >> '${calls}'
`);
  for (const name of ['systemctl', 'curl', 'readlink', 'logger', 'webhook']) chmodSync(join(bin, name), 0o755);

  return {
    dir,
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AM2_WATCHDOG_SERVICE: 'am2-api',
      AM2_WATCHDOG_URL: 'http://127.0.0.1:5000/',
      AM2_WATCHDOG_CURRENT: current,
      AM2_WATCHDOG_STATE_DIR: state,

      AM2_ALERT_COMMAND: join(bin, 'webhook'),
      AM2_ALERT_DEDUP_SECONDS: '600',
    },
  };
}

function run(script, env, args = []) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env });
}

test('watchdog passes only when service, HTTP body, restart count, and PID identity agree', () => {
  const f = fixture();
  try {
    const result = run(watchdog, f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /healthy/i);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const [name, options, reason] of [
  ['inactive unit', { active: 'failed' }, /inactive|service/i],
  ['HTTP failure', { status: '502', body: 'Bad Gateway' }, /HTTP|502/i],
  ['restart growth', { restarts: '1', previousRestarts: '0' }, /restart/i],
  ['hybrid runtime identity', { cwdMatches: false }, /identity|cwd|current/i],
]) {
  test(`watchdog fails on ${name}`, () => {
    const f = fixture(options);
    try {
      const result = run(watchdog, f.env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, reason);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('alert path logs locally, calls configured operator notifier, and deduplicates', () => {
  const f = fixture();
  try {
    const first = run(alert, f.env, ['relay HTTP 502']);
    assert.equal(first.status, 0, first.stderr);
    const second = run(alert, f.env, ['relay HTTP 502']);
    assert.equal(second.status, 0, second.stderr);
    const calls = readFileSync(f.calls, 'utf8');
    assert.equal((calls.match(/^logger /gm) || []).length, 1);
    assert.equal((calls.match(/^webhook /gm) || []).length, 1);
    assert.match(calls, /relay HTTP 502/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('alert path fails closed and does not deduplicate when external delivery is missing', () => {
  const f = fixture();
  try {
    const env = { ...f.env };
    delete env.AM2_ALERT_COMMAND;
    const first = run(alert, env, ['relay down']);
    const second = run(alert, env, ['relay down']);
    assert.notEqual(first.status, 0);
    assert.notEqual(second.status, 0);
    assert.match(first.stderr, /not configured/i);
    assert.doesNotMatch(second.stdout, /deduplicated/i);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('watchdog units execute every minute and route failures to alert service', () => {
  const service = readFileSync(resolve(root, 'infra/systemd/am2-relay-watchdog.service'), 'utf8');
  const timer = readFileSync(resolve(root, 'infra/systemd/am2-relay-watchdog.timer'), 'utf8');
  const alertUnit = readFileSync(resolve(root, 'infra/systemd/am2-relay-alert@.service'), 'utf8');
  assert.match(service, /^OnFailure=am2-relay-alert@%n\.service$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/libexec\/am2\/check-relay-health\.sh$/m);
  assert.match(timer, /^OnUnitActiveSec=60s$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(alertUnit, /send-relay-alert\.sh/);
});
