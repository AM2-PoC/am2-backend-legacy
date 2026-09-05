import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const packagerPath = resolve(ROOT, 'infra/scripts/package-host-security-bundle.sh');
const materializerPath = resolve(ROOT, 'infra/scripts/materialize-host-security.sh');
const installedVerifierPath = resolve(ROOT, 'infra/scripts/verify-host-security-installed.sh');
const driftAuditPath = resolve(ROOT, 'infra/scripts/audit-host-security-drift.sh');
const receiptSchemaPath = resolve(ROOT, 'infra/contracts/host-security-receipt-schema.json');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceSha() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function cloneSource(base) {
  const source = join(base, 'source');
  const run = spawnSync('git', ['clone', '--shared', ROOT, source], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return source;
}

/** A packaged, checksummed bundle plus an independently held expected manifest. */
function sealedBundle(base) {
  const source = cloneSource(base);
  const output = join(base, 'bundle');
  const run = spawnSync('bash', [packagerPath,
    '--source-root', source,
    '--sha', sourceSha(),
    '--output-dir', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const trusted = join(base, 'trusted-host-security-manifest.json');
  writeFileSync(trusted, readFileSync(join(output, 'host-security-manifest.json')));
  return {
    source,
    archive: join(output, 'am2-host-security.tar.gz'),
    manifest: join(output, 'host-security-manifest.json'),
    checksums: join(output, 'SHA256SUMS'),
    expected: trusted,
  };
}

function materialize(bundle, base, extra = [], options = {}) {
  const storeRoot = options.storeRoot ?? join(base, 'store');
  const receipt = options.receipt ?? join(base, 'receipt.json');
  return {
    storeRoot,
    receipt,
    run: spawnSync('bash', [materializerPath,
      '--archive', bundle.archive,
      '--manifest', bundle.manifest,
      '--checksums', bundle.checksums,
      '--expected-manifest', bundle.expected,
      '--store-root', storeRoot,
      '--receipt', receipt,
      ...extra], { encoding: 'utf8', ...(options.spawn ?? {}) }),
  };
}

/** Materialize successfully in an unprivileged test store and return the receipt. */
function materializedReceipt(bundle, base, extra = []) {
  const result = materialize(bundle, base, ['--unprivileged-store', ...extra]);
  assert.equal(result.run.status, 0, `${result.run.stdout}\n${result.run.stderr}`);
  return { ...result, receiptData: JSON.parse(readFileSync(result.receipt, 'utf8')) };
}

/**
 * Lay the materialized bytes out under a fake root exactly as an approved
 * activation would, so the installed-state verifier has real installed bytes
 * to read rather than a description of them.
 */
function installFromReceipt(receiptData, fakeRoot, mutate = () => {}) {
  const payloadRoot = join(receiptData.store_path, 'payload');
  for (const file of receiptData.files) {
    const targets = file.target
      ? [file.target]
      : file.sapis.map((sapi) => `/etc/php/8.3/${sapi}/conf.d/${file.filename}`);
    for (const target of targets) {
      const destination = join(fakeRoot, target);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(payloadRoot, file.origin)));
      chmodSync(destination, 0o644);
    }
  }
  mutate(fakeRoot);
  return fakeRoot;
}

function verifyInstalled(receipt, fakeRoot, extra = []) {
  return spawnSync('bash', [installedVerifierPath,
    '--receipt', receipt,
    '--root', fakeRoot,
    '--unprivileged-root',
    ...extra], { encoding: 'utf8' });
}

function auditDrift(receipt, fakeRoot, extra = []) {
  return spawnSync('bash', [driftAuditPath,
    '--receipt', receipt,
    '--root', fakeRoot,
    '--unprivileged-root',
    ...extra], { encoding: 'utf8' });
}

/** Materialized stores are deliberately read-only, so a fixture must unlock before removing. */
function discard(base) {
  spawnSync('chmod', ['-R', 'u+w', base]);
  rmSync(base, { recursive: true, force: true });
}

/**
 * Stamp today's date on the externally refreshed Cloudflare file.
 *
 * Its staleness is judged against a policy, so a fixture that wants a healthy
 * host must say when the data was generated instead of inheriting whatever date
 * the committed copy happens to carry -- otherwise the suite starts failing on
 * a calendar date for reasons that have nothing to do with the code.
 */
function freshenRealIp(root) {
  const target = join(root, '/etc/nginx/snippets/am2-cloudflare-realip.conf');
  writeFileSync(target, readFileSync(target, 'utf8')
    .replace(/# Regenerated \d{4}-\d{2}-\d{2}/, `# Regenerated ${new Date().toISOString().slice(0, 10)}`));
}

test('host-security materialization is digest-addressed, immutable, and needs no source checkout', () => {
  assert.ok(existsSync(materializerPath), 'missing host-security materializer');
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-materialize-'));
  try {
    const bundle = sealedBundle(base);
    const { run, storeRoot, receipt } = materialize(bundle, base, ['--unprivileged-store']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const receiptData = JSON.parse(readFileSync(receipt, 'utf8'));
    const manifest = JSON.parse(readFileSync(bundle.manifest, 'utf8'));

    // Digest-addressed: the materialization lives under its own payload digest,
    // so two different payloads can never occupy one path.
    assert.equal(receiptData.payload_sha256, manifest.payload_sha256);
    assert.equal(receiptData.store_path, join(storeRoot, manifest.payload_sha256));
    assert.ok(existsSync(join(receiptData.store_path, 'payload')), 'materialized payload is missing');

    // Immutable: nothing in the materialization is writable after the fact.
    const materializedFile = join(receiptData.store_path, 'payload/infra/php/webadmin-prepend.php');
    assert.ok(existsSync(materializedFile), 'materialized prepend is missing');
    assert.equal(statSync(materializedFile).mode & 0o777, 0o444,
      'materialized bytes must not stay writable');
    assert.equal(statSync(join(receiptData.store_path, 'payload')).mode & 0o777, 0o555,
      'materialized directories must not stay writable');

    // The materialized bytes are the sealed bytes, not a re-read of the repo.
    assert.equal(sha256(materializedFile),
      manifest.files.find((file) => file.id === 'php-webadmin-prepend').sha256);
  } finally {
    discard(base);
  }
});

test('host-security materialization refuses to read a source checkout', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-nosource-'));
  try {
    const bundle = sealedBundle(base);
    // Put a git that always fails ahead of the real one, and run from a
    // directory that is no repository. A materializer that reaches for the
    // checkout cannot survive either condition; one that works from the
    // authenticated payload alone does not notice.
    const stubBin = join(base, 'bin');
    mkdirSync(stubBin, { recursive: true });
    const stubGit = join(stubBin, 'git');
    writeFileSync(stubGit, '#!/bin/sh\necho "materializer invoked git" >&2\nexit 127\n');
    chmodSync(stubGit, 0o755);
    const { run } = materialize(bundle, base, ['--unprivileged-store'], {
      spawn: { cwd: tmpdir(), env: { ...process.env, PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}` } },
    });
    assert.doesNotMatch(run.stderr, /invoked git/, 'materializer shelled out to git');
    assert.equal(run.status, 0,
      `materializer must not depend on git or a checkout\n${run.stdout}\n${run.stderr}`);
  } finally {
    discard(base);
  }
});

test('host-security materialization refuses an unprivileged run into system paths', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-bounds-'));
  try {
    const bundle = sealedBundle(base);
    for (const forbidden of ['/etc/am2/host-security', '/usr/local/am2-host-security', '/var/lib/am2-host-security']) {
      const { run } = materialize(bundle, base, ['--unprivileged-store'], { storeRoot: forbidden });
      assert.notEqual(run.status, 0, `unprivileged materialization accepted a system store: ${forbidden}`);
      assert.match(run.stderr, /system|privileg/i);
      assert.ok(!existsSync(forbidden), `materializer created a system path: ${forbidden}`);
    }
  } finally {
    discard(base);
  }
});

test('host-security materialization rejects a bundle its trusted manifest does not describe', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-untrusted-'));
  try {
    const bundle = sealedBundle(base);

    // Prove the same call succeeds with the honest trusted manifest first, so
    // this test cannot pass merely because the materializer refuses everything.
    const honest = materialize(bundle, base, ['--unprivileged-store'],
      { storeRoot: join(base, 'store-honest'), receipt: join(base, 'receipt-honest.json') });
    assert.equal(honest.run.status, 0, `${honest.run.stdout}\n${honest.run.stderr}`);

    const forged = JSON.parse(readFileSync(bundle.expected, 'utf8'));
    forged.files = forged.files.map((file) => file.id === 'php-webadmin-prepend'
      ? { ...file, sha256: 'f'.repeat(64) }
      : file);
    writeFileSync(bundle.expected, `${JSON.stringify(forged)}\n`);

    const { run, storeRoot } = materialize(bundle, base, ['--unprivileged-store']);
    assert.notEqual(run.status, 0, 'materializer accepted a bundle the trusted manifest does not describe');
    assert.ok(!existsSync(join(storeRoot, forged.payload_sha256, 'payload')),
      'materializer published a payload it could not authenticate');
  } finally {
    discard(base);
  }
});

test('host-security materialization is idempotent and detects a tampered store', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-idempotent-'));
  try {
    const bundle = sealedBundle(base);
    const first = materializedReceipt(bundle, base);

    // Re-materializing the same digest is a no-op success, not a second copy.
    const second = materialize(bundle, base, ['--unprivileged-store'],
      { storeRoot: first.storeRoot, receipt: join(base, 'receipt-2.json') });
    assert.equal(second.run.status, 0, `${second.run.stdout}\n${second.run.stderr}`);

    // A store somebody edited must not be reused as if it were sealed.
    const tampered = join(first.receiptData.store_path, 'payload/infra/php/webadmin-prepend.php');
    chmodSync(dirname(tampered), 0o755);
    chmodSync(tampered, 0o644);
    writeFileSync(tampered, '<?php /* edited in place */');
    const third = materialize(bundle, base, ['--unprivileged-store'],
      { storeRoot: first.storeRoot, receipt: join(base, 'receipt-3.json') });
    assert.notEqual(third.run.status, 0, 'materializer reused a tampered store');
    assert.match(third.run.stderr, /differ|tamper|mismatch/i);
  } finally {
    discard(base);
  }
});

test('host-security receipt matches its schema and records real materialization', () => {
  assert.ok(existsSync(receiptSchemaPath), 'missing host-security receipt schema');
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-receipt-'));
  try {
    const bundle = sealedBundle(base);
    const { receiptData, receipt } = materializedReceipt(bundle, base);
    const schema = JSON.parse(readFileSync(receiptSchemaPath, 'utf8'));
    const manifest = JSON.parse(readFileSync(bundle.manifest, 'utf8'));

    assert.equal(schema.application, 'am2-host-security-materialization');
    assert.deepEqual(Object.keys(receiptData).sort(), [...schema.required].sort());

    assert.equal(receiptData.schema_version, schema.schema_version);
    assert.equal(receiptData.source_sha, manifest.source_sha);
    assert.equal(receiptData.archive_sha256, manifest.archive_sha256);
    assert.match(receiptData.materialized_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // A receipt from an unprivileged run must say so, so it can never be
    // mistaken for evidence of a real root-owned installation.
    assert.equal(receiptData.privileged, false);
    assert.equal(receiptData.materialized_by_uid, process.getuid());

    // Every contract file is accounted for, with the target resolved from the
    // sealed payload rather than from the repository.
    const contract = JSON.parse(readFileSync(
      join(receiptData.store_path, 'payload/infra/contracts/host-security-contract.json'), 'utf8'));
    assert.deepEqual(receiptData.files.map((file) => file.id).sort(),
      contract.files.map((file) => file.id).sort());
    for (const file of receiptData.files) {
      assert.equal(file.mode, '0644');
      assert.ok(file.target || (file.target_kind && file.filename && file.sapis),
        `receipt entry resolves no target: ${file.id}`);
    }

    assert.equal(statSync(receipt).mode & 0o777, 0o644, 'receipt must be protected from casual edits');
  } finally {
    discard(base);
  }
});

test('installed-state verifier checks target bytes, ownership, mode and file type', () => {
  assert.ok(existsSync(installedVerifierPath), 'missing installed-state verifier');
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-installed-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);

    const good = installFromReceipt(receiptData, join(base, 'root-good'), freshenRealIp);
    const clean = verifyInstalled(receipt, good);
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

    // Wrong bytes at the target.
    const edited = installFromReceipt(receiptData, join(base, 'root-edited'), (root) => {
      writeFileSync(join(root, '/etc/am2/php/webadmin-prepend.php'), '<?php /* drifted */');
    });
    const drifted = verifyInstalled(receipt, edited);
    assert.notEqual(drifted.status, 0, 'verifier accepted drifted installed bytes');
    assert.match(drifted.stderr, /webadmin-prepend\.php/);

    // Wrong mode at the target.
    const loose = installFromReceipt(receiptData, join(base, 'root-loose'), (root) => {
      chmodSync(join(root, '/etc/am2/php/webadmin-prepend.php'), 0o666);
    });
    const looseRun = verifyInstalled(receipt, loose);
    assert.notEqual(looseRun.status, 0, 'verifier accepted a world-writable installed file');
    assert.match(looseRun.stderr, /mode/i);

    // A symlink where a regular file belongs.
    const linked = installFromReceipt(receiptData, join(base, 'root-linked'), (root) => {
      const target = join(root, '/etc/am2/php/webadmin-prepend.php');
      const decoy = join(root, 'decoy.php');
      writeFileSync(decoy, readFileSync(target));
      rmSync(target);
      symlinkSync(decoy, target);
    });
    const linkedRun = verifyInstalled(receipt, linked);
    assert.notEqual(linkedRun.status, 0, 'verifier accepted a symlinked installed file');
    assert.match(linkedRun.stderr, /symlink|regular/i);

    // A missing target.
    const absent = installFromReceipt(receiptData, join(base, 'root-absent'), (root) => {
      rmSync(join(root, '/etc/am2/php/webadmin-prepend.php'));
    });
    const absentRun = verifyInstalled(receipt, absent);
    assert.notEqual(absentRun.status, 0, 'verifier accepted a missing installed file');
    assert.match(absentRun.stderr, /missing/i);
  } finally {
    discard(base);
  }
});

test('installed-state verifier enforces per-lane session-store separation', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-lanes-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);

    const shared = installFromReceipt(receiptData, join(base, 'root-shared'), (root) => {
      // The exact regression that let a staging session authenticate in
      // production: both lanes pointing at one session store.
      const staging = join(root, '/etc/apache2/sites-available/am2-webadmin-staging.conf');
      writeFileSync(staging, readFileSync(staging, 'utf8')
        .replace('/var/lib/php/sessions/am2-staging', '/var/lib/php/sessions/am2'));
    });
    const sharedRun = verifyInstalled(receipt, shared);
    assert.notEqual(sharedRun.status, 0, 'verifier accepted one session store shared by both lanes');
    assert.match(sharedRun.stderr, /session/i);

    const unset = installFromReceipt(receiptData, join(base, 'root-unset'), (root) => {
      const production = join(root, '/etc/apache2/sites-available/am2-webadmin-internal.conf');
      writeFileSync(production, readFileSync(production, 'utf8')
        .split('\n').filter((line) => !line.includes('session.save_path')).join('\n'));
    });
    const unsetRun = verifyInstalled(receipt, unset);
    assert.notEqual(unsetRun.status, 0, 'verifier accepted a lane with no session store of its own');
    assert.match(unsetRun.stderr, /session/i);
  } finally {
    discard(base);
  }
});

test('installed-state verifier refuses to call an unprivileged check a real one', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-honesty-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));

    // Without the flag that admits the root is a fixture, an unprivileged
    // receipt must not be accepted as evidence about the real host.
    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', receipt, '--root', root], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier treated a fixture root as the real host');
    assert.match(run.stderr, /unprivileged|privileg/i);
  } finally {
    discard(base);
  }
});

test('drift audit is quiet on success and speaks only on actionable drift', () => {
  assert.ok(existsSync(driftAuditPath), 'missing host-security drift audit');
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-drift-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);

    const good = installFromReceipt(receiptData, join(base, 'root-good'), freshenRealIp);
    const quiet = auditDrift(receipt, good);
    assert.equal(quiet.status, 0, `${quiet.stdout}\n${quiet.stderr}`);
    assert.equal(quiet.stdout, '', 'a healthy drift audit must print nothing');
    assert.equal(quiet.stderr, '', 'a healthy drift audit must print nothing');

    const drifted = installFromReceipt(receiptData, join(base, 'root-drifted'), (root) => {
      writeFileSync(join(root, '/etc/am2/php/webadmin-prepend.php'), '<?php /* drifted */');
    });
    const noisy = auditDrift(receipt, drifted);
    assert.notEqual(noisy.status, 0, 'drift audit stayed silent about drifted bytes');
    assert.match(noisy.stderr, /webadmin-prepend\.php/);

    const missingReceipt = auditDrift(join(base, 'absent-receipt.json'), good);
    assert.notEqual(missingReceipt.status, 0, 'drift audit treated a missing receipt as healthy');
  } finally {
    discard(base);
  }
});

test('every host-security contract test is actually selected to run in CI', () => {
  // A test that never runs looks exactly like a test that passes. The offline
  // selector disqualifies files that appear to reach the network, and a literal
  // URL used only as fixture data is enough to trip it -- which silently
  // excluded the Cloudflare lifecycle test the first time it was written.
  const run = spawnSync('bash', [resolve(ROOT, 'tests/offline-tests.sh')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const selected = new Set(run.stdout.split('\n').filter(Boolean));
  for (const file of [
    'host-security-materialization.test.mjs',
    'host-security-drift-timer.test.mjs',
    'cloudflare-realip-lifecycle.test.mjs',
    'host-security-bundle.test.mjs',
    'host-security-contract.test.mjs',
  ]) {
    assert.ok(selected.has(file), `${file} is not selected by the offline test runner, so CI never runs it`);
  }
});
