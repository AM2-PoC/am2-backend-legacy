import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const packager = resolve(ROOT, 'infra/scripts/package-host-security-bundle.sh');
const materializer = resolve(ROOT, 'infra/scripts/materialize-host-security.sh');
const activator = resolve(ROOT, 'infra/scripts/activate-host-security.sh');
const rollback = resolve(ROOT, 'infra/scripts/rollback-host-security.sh');
const installedVerifier = resolve(ROOT, 'infra/scripts/verify-host-security-installed.sh');
const lifecycle = resolve(ROOT, 'infra/contracts/cloudflare-realip-lifecycle.json');

function discard(base) {
  spawnSync('chmod', ['-R', 'u+w', base]);
  rmSync(base, { recursive: true, force: true });
}

function candidate(base) {
  const source = join(base, 'source');
  const clone = spawnSync('git', ['clone', '--shared', ROOT, source], { encoding: 'utf8' });
  assert.equal(clone.status, 0, `${clone.stdout}\n${clone.stderr}`);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const bundle = join(base, 'bundle');
  const packaged = spawnSync('bash', [packager, '--source-root', source, '--sha', sha,
    '--output-dir', bundle], { encoding: 'utf8' });
  assert.equal(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);
  const expected = join(base, 'trusted.json');
  writeFileSync(expected, readFileSync(join(bundle, 'host-security-manifest.json')));
  chmodSync(expected, 0o644);
  const receipt = join(base, 'materialization.json');
  const materialized = spawnSync('bash', [materializer,
    '--archive', join(bundle, 'am2-host-security.tar.gz'),
    '--manifest', join(bundle, 'host-security-manifest.json'),
    '--checksums', join(bundle, 'SHA256SUMS'),
    '--expected-manifest', expected,
    '--store-root', join(base, 'store'),
    '--receipt', receipt,
    '--unprivileged-store'], { encoding: 'utf8' });
  assert.equal(materialized.status, 0, `${materialized.stdout}\n${materialized.stderr}`);
  return { expected, receipt, data: JSON.parse(readFileSync(receipt, 'utf8')) };
}

function stubScript(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test('activation installs only from the private payload snapshot it authenticated', () => {
  const source = readFileSync(activator, 'utf8');
  assert.match(source, /authenticated_payload=\$work\/authenticated-payload/,
    'activation has no private payload snapshot');
  assert.match(source, /contract = json\.load\(open\(normalised \/ 'infra\/contracts\/host-security-contract\.json'/,
    'activation reads its contract from the mutable materialization store');
  assert.match(source, /source = normalised \/ entry\['origin'\]/,
    'activation installs source bytes from outside its authenticated snapshot');
  assert.doesNotMatch(source, /source = store \/ entry\['origin'\]/,
    'activation reopens mutable materialization paths after authentication');
});

test('activation is serialized and refuses mutable trust inputs', () => {
  const source = readFileSync(activator, 'utf8');
  assert.match(source, /flock\s+-x/, 'host-security activation is not serialized');
  assert.match(source, /expected manifest.*root-protected|trusted expected manifest.*writable/is,
    'activation does not protect its independent trust anchor');
  assert.match(source, /materialization receipt.*writable|receipt.*root-protected/is,
    'activation does not protect its materialization receipt');
});

test('activation rolls back every target when configuration validation fails', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-activate-rollback-'));
  try {
    const { expected, receipt, data } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) {
      mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    }
    const existing = join(root, '/etc/am2/php/webadmin-prepend.php');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'previous-host-bytes\n');
    chmodSync(existing, 0o600);
    const existingSession = join(root, '/var/lib/php/sessions/am2');
    mkdirSync(existingSession, { recursive: true });
    chmodSync(existingSession, 0o750);
    const introducedSession = join(root, '/var/lib/php/sessions/am2-staging');
    const evidence = join(base, 'activation.json');
    const reloadCalls = join(base, 'reload-calls');
    const apache = stubScript(join(base, 'apache-configtest'), 'exit 0');
    const nginx = stubScript(join(base, 'nginx-configtest'), 'exit 9');
    const reload = stubScript(join(base, 'reload'), `printf '%s %s\\n' "$1" "$2" >> ${reloadCalls}`);

    const run = spawnSync('bash', [activator,
      '--receipt', receipt, '--expected-manifest', expected,
      '--root', root, '--unprivileged-root',
      '--activation-receipt', evidence, '--backup-root', join(base, 'backups'),
      '--apache-configtest', apache, '--nginx-configtest', nginx,
      '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'], { encoding: 'utf8' });

    assert.notEqual(run.status, 0, 'activation succeeded despite failed nginx configuration validation');
    assert.equal(readFileSync(existing, 'utf8'), 'previous-host-bytes\n');
    assert.equal(statSync(existing).mode & 0o777, 0o600);
    assert.equal(statSync(existingSession).mode & 0o7777, 0o750,
      'failed activation did not restore the existing session-store mode');
    assert.ok(!existsSync(introducedSession),
      'failed activation retained a session store introduced by that activation');
    assert.ok(!existsSync(evidence), 'failed activation wrote verified evidence');
    assert.ok(!existsSync(reloadCalls), 'failed pre-reload validation still reloaded services');

    const newlyIntroduced = data.files.find((file) => file.id === 'nginx-webadmin-security');
    assert.ok(!existsSync(join(root, newlyIntroduced.target)), 'rollback retained a newly introduced target');
  } finally {
    discard(base);
  }
});

test('rollback rejects a backup changed after activation', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-backup-integrity-'));
  try {
    const { expected, receipt } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const existing = join(root, '/etc/am2/php/webadmin-prepend.php');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'trusted-old-bytes\n');
    chmodSync(existing, 0o600);
    const evidence = join(base, 'activation.json');
    const ok = stubScript(join(base, 'ok'), 'exit 0');
    const reload = stubScript(join(base, 'reload'), 'exit 0');
    const common = [activator,
      '--receipt', receipt, '--expected-manifest', expected,
      '--root', root, '--unprivileged-root', '--activation-receipt', evidence,
      '--backup-root', join(base, 'backups'), '--apache-configtest', ok,
      '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock')];
    const applied = spawnSync('bash', [...common, '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    const activation = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.match(activation.backup_manifest_sha256, /^[0-9a-f]{64}$/);
    const records = JSON.parse(readFileSync(join(activation.backup_path, 'previous.json'), 'utf8'));
    const saved = records.find((item) => item.target === '/etc/am2/php/webadmin-prepend.php').backup;
    writeFileSync(saved, 'attacker-controlled-rollback-bytes\n');

    const rolledBack = spawnSync('bash', [rollback,
      '--activation-receipt', evidence, '--root', root, '--unprivileged-root',
      '--apache-configtest', ok, '--nginx-configtest', ok,
      '--reload-command', reload, '--lock', join(base, 'activation.lock'),
      '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.notEqual(rolledBack.status, 0, 'rollback accepted a modified backup');
    assert.notEqual(readFileSync(existing, 'utf8'), 'attacker-controlled-rollback-bytes\n');
    assert.ok(existsSync(evidence), 'failed rollback removed the active activation receipt');
  } finally {
    discard(base);
  }
});

test('activation refuses to replace an existing rollback receipt', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-existing-receipt-'));
  try {
    const { expected, receipt } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const existing = join(root, '/etc/am2/php/webadmin-prepend.php');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'original-before-activation\n');
    chmodSync(existing, 0o600);
    const evidence = join(base, 'activation.json');
    const ok = stubScript(join(base, 'ok'), 'exit 0');
    const reload = stubScript(join(base, 'reload'), 'exit 0');
    const common = [activator,
      '--receipt', receipt, '--expected-manifest', expected,
      '--root', root, '--unprivileged-root', '--activation-receipt', evidence,
      '--backup-root', join(base, 'backups'), '--apache-configtest', ok,
      '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'];
    const first = spawnSync('bash', common, { encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstReceipt = readFileSync(evidence, 'utf8');
    const firstBackup = JSON.parse(firstReceipt).backup_path;
    const firstManifest = readFileSync(join(firstBackup, 'previous.json'), 'utf8');

    const retried = spawnSync('bash', common, { encoding: 'utf8' });
    assert.notEqual(retried.status, 0, 'activation replaced an active rollback receipt');
    assert.equal(readFileSync(evidence, 'utf8'), firstReceipt,
      'retry replaced the receipt that anchors the original rollback');
    assert.equal(readFileSync(join(firstBackup, 'previous.json'), 'utf8'), firstManifest,
      'retry modified the original rollback manifest');
  } finally {
    discard(base);
  }
});

/*
 * Replacing an active activation.
 *
 * Activation refuses while a receipt is active, and the only other route was a
 * rollback to the files from before the first activation followed by a fresh
 * activation: a window on pre-hardening configuration and two reloads. With
 * --supersede the new activation backs up the configuration that is live now,
 * so rolling it back returns to the activation it replaced, not to the host as
 * it was before any activation.
 */
function supersedeFixture(base) {
  const { expected, receipt, data } = candidate(base);
  const root = join(base, 'root');
  for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
  const prepend = join(root, '/etc/am2/php/webadmin-prepend.php');
  mkdirSync(dirname(prepend), { recursive: true });
  writeFileSync(prepend, 'pre-hardening-bytes\n');
  chmodSync(prepend, 0o600);
  const calls = join(base, 'calls');
  const ok = stubScript(join(base, 'ok'), 'exit 0');
  const reload = stubScript(join(base, 'reload'), `printf '%s %s\\n' "$1" "$2" >> ${calls}`);
  const evidence = join(base, 'activation.json');
  const activate = (...extra) => spawnSync('bash', [activator,
    '--receipt', receipt, '--expected-manifest', expected,
    '--root', root, '--unprivileged-root', '--activation-receipt', evidence,
    '--backup-root', join(base, 'backups'), '--apache-configtest', ok,
    '--nginx-configtest', ok, '--reload-command', reload,
    '--lock', join(base, 'activation.lock'), ...extra, '--apply', '--allow-reload'], { encoding: 'utf8' });
  const rollBack = () => spawnSync('bash', [rollback,
    '--activation-receipt', evidence, '--root', root, '--unprivileged-root',
    '--apache-configtest', ok, '--nginx-configtest', ok, '--reload-command', reload,
    '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'], { encoding: 'utf8' });
  const payloadPrepend = readFileSync(join(data.store_path, 'payload/infra/php/webadmin-prepend.php'));
  return { root, prepend, calls, evidence, activate, rollBack, payloadPrepend };
}

test('supersede replaces an active activation without passing through pre-hardening files', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-supersede-'));
  try {
    const f = supersedeFixture(base);
    const first = f.activate();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstReceipt = readFileSync(f.evidence, 'utf8');
    const firstBackup = JSON.parse(firstReceipt).backup_path;
    const firstManifest = readFileSync(join(firstBackup, 'previous.json'), 'utf8');
    rmSync(f.calls, { force: true });

    const second = f.activate('--supersede');
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.deepEqual(readFileSync(f.prepend), f.payloadPrepend, 'supersede did not leave the candidate installed');
    assert.equal(readFileSync(f.calls, 'utf8'), 'reload apache2\nreload nginx\n',
      'supersede did not reload each service exactly once');

    const secondData = JSON.parse(readFileSync(f.evidence, 'utf8'));
    assert.notEqual(secondData.backup_path, firstBackup, 'supersede reused the replaced rollback namespace');
    assert.equal(readFileSync(join(secondData.backup_path, 'superseded-activation.json'), 'utf8'), firstReceipt,
      'the replaced activation receipt was not archived with the new rollback anchor');
    assert.equal(readFileSync(join(firstBackup, 'previous.json'), 'utf8'), firstManifest,
      'supersede modified the replaced activation backup');

    const back = f.rollBack();
    assert.equal(back.status, 0, `${back.stdout}\n${back.stderr}`);
    assert.deepEqual(readFileSync(f.prepend), f.payloadPrepend,
      'rolling back a superseding activation returned to pre-hardening bytes');
  } finally {
    discard(base);
  }
});

test('supersede refuses when there is no active activation to replace', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-supersede-none-'));
  try {
    const f = supersedeFixture(base);
    const run = f.activate('--supersede');
    assert.notEqual(run.status, 0, 'supersede ran with no active activation');
    assert.equal(readFileSync(f.prepend, 'utf8'), 'pre-hardening-bytes\n');
    assert.ok(!existsSync(f.evidence), 'supersede without an active activation wrote a receipt');
  } finally {
    discard(base);
  }
});

test('supersede refuses an active activation whose rollback anchor was changed', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-supersede-tampered-'));
  try {
    const f = supersedeFixture(base);
    const first = f.activate();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstReceipt = readFileSync(f.evidence, 'utf8');
    const manifest = join(JSON.parse(firstReceipt).backup_path, 'previous.json');
    chmodSync(manifest, 0o600);
    writeFileSync(manifest, '[]\n');
    rmSync(f.calls, { force: true });

    const run = f.activate('--supersede');
    assert.notEqual(run.status, 0, 'supersede accepted an activation with a changed rollback manifest');
    assert.equal(readFileSync(f.evidence, 'utf8'), firstReceipt, 'refused supersede replaced the active receipt');
    assert.ok(!existsSync(f.calls), 'refused supersede reloaded services');
  } finally {
    discard(base);
  }
});

test('each distinct activation receipt gets a unique rollback namespace', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-unique-backup-'));
  try {
    const { expected, receipt } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const existing = join(root, '/etc/am2/php/webadmin-prepend.php');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'first-original\n');
    chmodSync(existing, 0o600);
    const ok = stubScript(join(base, 'ok'), 'exit 0');
    const reload = stubScript(join(base, 'reload'), 'exit 0');
    const fakeDate = stubScript(join(base, 'date'), "printf '20260907T000000Z\\n'");
    const backupRoot = join(base, 'backups');
    const common = [activator,
      '--receipt', receipt, '--expected-manifest', expected,
      '--root', root, '--unprivileged-root', '--backup-root', backupRoot,
      '--apache-configtest', ok, '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'];
    const env = { ...process.env, PATH: `${base}:${process.env.PATH}` };
    const firstReceipt = join(base, 'first-activation.json');
    const first = spawnSync('bash', [...common, '--activation-receipt', firstReceipt], { encoding: 'utf8', env });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const firstData = JSON.parse(readFileSync(firstReceipt, 'utf8'));
    const firstManifest = readFileSync(join(firstData.backup_path, 'previous.json'), 'utf8');

    writeFileSync(existing, 'second-original\n');
    const secondReceipt = join(base, 'second-activation.json');
    const second = spawnSync('bash', [...common, '--activation-receipt', secondReceipt], { encoding: 'utf8', env });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const secondData = JSON.parse(readFileSync(secondReceipt, 'utf8'));
    assert.notEqual(secondData.backup_path, firstData.backup_path,
      'two activations in one second reused one rollback namespace');
    assert.equal(readFileSync(join(firstData.backup_path, 'previous.json'), 'utf8'), firstManifest,
      'later activation modified the earlier rollback manifest');
  } finally {
    discard(base);
  }
});

test('activation refuses a tampered materialization and a symlinked target parent', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-activate-bounds-'));
  try {
    const first = candidate(join(base, 'tampered'));
    const source = join(first.data.store_path, 'payload/infra/php/webadmin-prepend.php');
    chmodSync(dirname(source), 0o755);
    chmodSync(source, 0o644);
    writeFileSync(source, '<?php /* tampered materialization */');
    const root = join(base, 'root-tampered');
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const ok = stubScript(join(base, 'ok'), 'exit 0');
    const reload = stubScript(join(base, 'reload'), 'exit 0');
    const tampered = spawnSync('bash', [activator,
      '--receipt', first.receipt, '--expected-manifest', first.expected,
      '--root', root, '--unprivileged-root', '--activation-receipt', join(base, 'bad.json'),
      '--backup-root', join(base, 'backups-tampered'), '--apache-configtest', ok,
      '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0, 'activation installed bytes from a tampered materialization');
    assert.ok(!existsSync(join(root, '/etc/am2/php/webadmin-prepend.php')));

    const second = candidate(join(base, 'symlink'));
    const symlinkRoot = join(base, 'root-symlink');
    const escaped = join(base, 'escaped');
    mkdirSync(escaped, { recursive: true });
    mkdirSync(join(symlinkRoot, 'etc'), { recursive: true });
    symlinkSync(escaped, join(symlinkRoot, 'etc/am2'));
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(symlinkRoot, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const linked = spawnSync('bash', [activator,
      '--receipt', second.receipt, '--expected-manifest', second.expected,
      '--root', symlinkRoot, '--unprivileged-root', '--activation-receipt', join(base, 'linked.json'),
      '--backup-root', join(base, 'backups-linked'), '--apache-configtest', ok,
      '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.notEqual(linked.status, 0, 'activation followed a symlinked target parent outside its root');
    assert.ok(!existsSync(join(escaped, 'php/webadmin-prepend.php')), 'activation escaped through target parent');
  } finally {
    discard(base);
  }
});

test('rollback restores activated bytes without source checkout or service reload', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-explicit-rollback-'));
  try {
    const { expected, receipt } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    const existing = join(root, '/etc/am2/php/webadmin-prepend.php');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'old-bytes\n');
    chmodSync(existing, 0o600);
    const evidence = join(base, 'activation.json');
    const ok = stubScript(join(base, 'ok'), 'exit 0');
    const reload = stubScript(join(base, 'reload'), 'exit 0');
    const common = [activator,
      '--receipt', receipt, '--expected-manifest', expected,
      '--root', root, '--unprivileged-root', '--activation-receipt', evidence,
      '--backup-root', join(base, 'backups'), '--apache-configtest', ok,
      '--nginx-configtest', ok, '--reload-command', reload,
      '--lock', join(base, 'activation.lock')];
    const applied = spawnSync('bash', [...common, '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    assert.notEqual(readFileSync(existing, 'utf8'), 'old-bytes\n');

    const rolledBack = spawnSync('bash', [rollback,
      '--activation-receipt', evidence, '--root', root, '--unprivileged-root',
      '--apache-configtest', ok, '--nginx-configtest', ok,
      '--reload-command', reload,
      '--lock', join(base, 'activation.lock'), '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.equal(readFileSync(existing, 'utf8'), 'old-bytes\n');
    assert.equal(statSync(existing).mode & 0o777, 0o600);
    assert.ok(!existsSync(evidence), 'rollback left a verified activation receipt active');
  } finally {
    discard(base);
  }
});

test('activation requires approval and atomically installs one verified host-security candidate', () => {
  assert.ok(existsSync(activator), 'missing host-security activator');
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-activate-'));
  try {
    const { expected, receipt, data } = candidate(base);
    const root = join(base, 'root');
    for (const sapi of ['apache2', 'fpm']) {
      mkdirSync(join(root, `/etc/php/8.3/${sapi}/conf.d`), { recursive: true });
    }
    const evidence = join(base, 'activation.json');
    const calls = join(base, 'calls');
    const apache = stubScript(join(base, 'apache-configtest'), `printf 'apache\\n' >> ${calls}`);
    const nginx = stubScript(join(base, 'nginx-configtest'), `printf 'nginx\\n' >> ${calls}`);
    const reload = stubScript(join(base, 'reload'), `printf 'reload %s %s\\n' "$1" "$2" >> ${calls}`);
    const verifier = stubScript(join(base, 'verify-installed'), [
      `bash ${installedVerifier} "$@"`,
      `printf 'verify\\n' >> ${calls}`,
    ].join('\n'));

    const common = [activator,
      '--receipt', receipt,
      '--expected-manifest', expected,
      '--root', root,
      '--unprivileged-root',
      '--activation-receipt', evidence,
      '--backup-root', join(base, 'backups'),
      '--apache-configtest', apache,
      '--nginx-configtest', nginx,
      '--reload-command', reload,
      '--verify-installed', verifier,
      '--lifecycle', lifecycle,
      '--lock', join(base, 'activation.lock'),
    ];

    const refused = spawnSync('bash', common, { encoding: 'utf8' });
    assert.notEqual(refused.status, 0, 'activation proceeded without explicit approval flags');
    assert.ok(!existsSync(evidence));

    const applied = spawnSync('bash', [...common, '--apply', '--allow-reload'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);

    for (const file of data.files) {
      const targets = file.target
        ? [file.target]
        : file.sapis.map((sapi) => `/etc/php/8.3/${sapi}/conf.d/${file.filename}`);
      for (const target of targets) {
        assert.deepEqual(readFileSync(join(root, target)),
          readFileSync(join(data.store_path, 'payload', file.origin)), target);
        assert.equal(statSync(join(root, target)).mode & 0o777, 0o644, target);
      }
    }
    for (const session of ['/var/lib/php/sessions/am2', '/var/lib/php/sessions/am2-staging']) {
      assert.equal(statSync(join(root, session)).mode & 0o7777, 0o1730, session);
    }
    assert.equal(readFileSync(calls, 'utf8'), 'apache\nnginx\nreload reload apache2\nreload reload nginx\nverify\n');
    const activation = JSON.parse(readFileSync(evidence, 'utf8'));
    assert.equal(activation.application, 'am2-host-security-activation');
    assert.equal(activation.status, 'verified');
    assert.equal(activation.payload_sha256, data.payload_sha256);
  } finally {
    discard(base);
  }
});
