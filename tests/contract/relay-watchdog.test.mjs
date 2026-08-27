import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
  const deployLock = join(dir, 'deploy.lock');
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
      AM2_DEPLOY_LOCK: deployLock,

      AM2_ALERT_COMMAND: join(bin, 'webhook'),
      AM2_ALERT_DEDUP_SECONDS: '600',
    },
  };
}

function run(script, env, args = []) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env });
}

test('watchdog is silent when service, HTTP body, restart count, and PID identity agree', () => {
  const f = fixture();
  try {
    const result = run(watchdog, f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('watchdog skips checks silently while the deployment lock is held', () => {
  const f = fixture({ active: 'failed', status: '502', body: 'Bad Gateway', cwdMatches: false });
  const ready = join(f.dir, 'lock-ready');
  const lockProc = spawn('bash', ['-c', 'exec 9>"$1"; flock -x 9; : >"$2"; sleep 3', 'bash', f.env.AM2_DEPLOY_LOCK, ready], {
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !existsSync(ready)) {}
    assert.ok(existsSync(ready), 'deployment lock holder did not become ready');
    const result = run(watchdog, f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    lockProc.kill('SIGTERM');
    rmSync(f.dir, { recursive: true, force: true });
  }
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
  assert.match(service, /^StandardOutput=null$/m);
  assert.match(service, /^StandardError=journal$/m);
  assert.match(service, /^SyslogLevel=err$/m);
  assert.match(service, /^LogLevelMax=warning$/m);
  assert.match(timer, /^OnUnitActiveSec=60s$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(alertUnit, /send-relay-alert\.sh/);
});

/*
 * An alarm that never stops is not an alarm.
 *
 * The watchdog was installed on 11 August into a hybrid runtime state and has
 * been failing every minute since -- 891 consecutive failures over sixteen
 * days. It was right every single time: the relay really was running from a
 * different release than /current pointed at. Nobody acted, and the alert kept
 * arriving, hourly, by `wall` -- broadcast to every terminal logged into the
 * production VPS -- and as a new comment on one GitHub issue, twenty-six of
 * them, on a thread titled "configure external relay alert delivery".
 *
 * What is missing is not detection. It is the two edges: something broke, and
 * something is fixed again. A fault that persists is one fact, not one fact per
 * hour, and a fault that clears is a fact nothing ever reported at all.
 */

test('a persisting fault is announced once, and its recovery closes the episode', () => {
    const f = fixture();
    try {
        const first = run(alert, f.env, ['relay HTTP 502']);
        assert.equal(first.status, 0, first.stderr);

        const again = run(alert, f.env, ['relay HTTP 502']);
        assert.equal(again.status, 0, again.stderr);
        assert.equal(
            (readFileSync(f.calls, 'utf8').match(/^webhook /gm) || []).length, 1,
            'the same fault was announced twice',
        );

        // The relay comes back. The watchdog passes, and that is the edge that
        // was never reported: the issue thread only ever said something broke.
        const healthy = run(watchdog, f.env);
        assert.equal(healthy.status, 0, healthy.stderr);

        const calls = readFileSync(f.calls, 'utf8');
        const delivered = calls.match(/^webhook .*/gm) || [];
        assert.equal(delivered.length, 2, 'recovery was not announced');
        assert.match(delivered[1], /recover|healthy|clear/i);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a fault that returns after recovery is announced again immediately', () => {
    const f = fixture();
    try {
        run(alert, f.env, ['relay HTTP 502']);
        run(watchdog, f.env);                       // recovers, closing the episode
        run(alert, f.env, ['relay HTTP 502']);      // the same fault, a new episode

        const delivered = (readFileSync(f.calls, 'utf8').match(/^webhook /gm) || []).length;
        assert.equal(delivered, 3,
            'a fault that came back was suppressed by the previous episode');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a healthy watchdog with nothing outstanding says nothing at all', () => {
    const f = fixture();
    try {
        const result = run(watchdog, f.env);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!existsSync(f.calls), 'a healthy check announced something');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the operator notifier does not broadcast to every terminal on the host', () => {
    // `wall` writes to every logged-in TTY on the box. On the production VPS
    // that is whoever happens to be working, interrupted once an hour, about a
    // fault they cannot fix from a broadcast. The journal and the issue thread
    // both reach the person who can.
    const notifier = resolve(root, 'infra/scripts/notify-relay-operator');
    assert.ok(existsSync(notifier),
        'the notifier lives only on the host, so nothing reviews or deploys it');
    // A command at the start of a line, not the word anywhere -- the comment
    // explaining why it was removed says "wall" too.
    const source = readFileSync(notifier, 'utf8');
    assert.doesNotMatch(source, /^\s*(\/usr\/bin\/)?wall\b/m,
        'the notifier still broadcasts to every terminal');
    assert.match(source, /gh issue comment/, 'the notifier no longer delivers anywhere');
});
