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
  for (const sessionPath of ['/var/lib/php/sessions/am2', '/var/lib/php/sessions/am2-staging']) {
    const destination = join(fakeRoot, sessionPath);
    mkdirSync(destination, { recursive: true });
    chmodSync(destination, 0o1730);
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

/** A copy of the real-IP lifecycle contract with the permissions a host would give it. */
function hostLifecycle(base) {
  const path = join(base, 'cloudflare-realip-lifecycle.json');
  writeFileSync(path, readFileSync(resolve(ROOT, 'infra/contracts/cloudflare-realip-lifecycle.json')));
  chmodSync(path, 0o644);
  return path;
}

/**
 * Reissue a receipt and trusted manifest for one file's new bytes.
 *
 * Byte equality is checked first, so a fixture that wants to exercise the shape
 * or freshness checks has to make the installed bytes legitimately what the
 * receipt names -- otherwise it only ever proves byte equality again.
 */
function reissueFor(base, receipt, manifest, id, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const suffix = Math.random().toString(36).slice(2);
  const rewrite = (source, destination) => {
    const data = JSON.parse(readFileSync(source, 'utf8'));
    data.files = data.files.map((file) => file.id === id ? { ...file, sha256: digest } : file);
    writeFileSync(destination, JSON.stringify(data));
    chmodSync(destination, 0o644);
    return destination;
  };
  return {
    receipt: rewrite(receipt, join(base, `receipt-${suffix}.json`)),
    manifest: rewrite(manifest, join(base, `manifest-${suffix}.json`)),
  };
}

/** Materialized stores are deliberately read-only, so a fixture must unlock before removing. */
function discard(base) {
  spawnSync('chmod', ['-R', 'u+w', base]);
  rmSync(base, { recursive: true, force: true });
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

test('host-security materialization refuses a writable trust anchor', () => {
  // The expected manifest supplies every digest the materializer accepts. A
  // writable copy is not independent evidence; it is attacker input wearing a
  // reassuring filename. This rule applies to fixtures as well, so a test run
  // cannot accidentally normalize unsafe trust-anchor permissions.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-materializer-anchorperm-'));
  try {
    const bundle = sealedBundle(base);
    chmodSync(bundle.expected, 0o666);
    const { run } = materialize(bundle, base, ['--unprivileged-store']);
    assert.notEqual(run.status, 0, 'materializer accepted a world-writable expected manifest');
    assert.match(run.stderr, /expected manifest.*writable|trust anchor.*writable/i);
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

    const good = installFromReceipt(receiptData, join(base, 'root-good'));
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

    // Each guard is exercised on its own. A fixture that trips both at once
    // only proves at least one exists, and either could then be deleted with
    // the suite still green.

    // 1. The receipt says the materialization was unprivileged. That is a
    //    fixture, whatever root it is pointed at.
    const unprivilegedReceipt = spawnSync('bash', [installedVerifierPath,
      '--receipt', receipt, '--root', root,
      '--expected-manifest', bundle.expected,
      '--lifecycle', hostLifecycle(base)], { encoding: 'utf8' });
    assert.notEqual(unprivilegedReceipt.status, 0, 'verifier read a fixture receipt as host evidence');
    assert.match(unprivilegedReceipt.stderr, /unprivileged materialization/i);

    // 2. With that flag flipped, the fixture root must still be refused --
    //    otherwise editing one boolean is enough to make a scratch directory
    //    speak for the host.
    const claimsPrivileged = join(base, 'claims-privileged.json');
    writeFileSync(claimsPrivileged,
      JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), privileged: true }));
    chmodSync(claimsPrivileged, 0o644);
    const fixtureRoot = spawnSync('bash', [installedVerifierPath,
      '--receipt', claimsPrivileged, '--root', root,
      '--expected-manifest', bundle.expected,
      '--lifecycle', hostLifecycle(base)], { encoding: 'utf8' });
    assert.notEqual(fixtureRoot.status, 0, 'verifier accepted a fixture root as the real host');
    assert.match(fixtureRoot.stderr, /fixture/i);

    // 3. And a real-host check with no independently obtained manifest is the
    //    host vouching for itself.
    const noManifest = spawnSync('bash', [installedVerifierPath,
      '--receipt', claimsPrivileged, '--root', root,
      '--lifecycle', hostLifecycle(base)], { encoding: 'utf8' });
    assert.notEqual(noManifest.status, 0, 'verifier checked a host with nothing independent to check against');
    assert.match(noManifest.stderr, /expected-manifest/i);
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

    const good = installFromReceipt(receiptData, join(base, 'root-good'));
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

test('materialization re-verifies extracted bytes instead of trusting the bundle check', () => {
  // The bundle verifier authenticates a private snapshot and deletes it. If the
  // materializer then extracts the original archive without re-checking it,
  // anyone who can write the delivery directory between those two moments gets
  // arbitrary bytes sealed into the store under an authenticated digest.
  //
  // Reproduced deterministically by neutering the delegated verifier: the
  // materializer must still refuse, because it is not entitled to assume the
  // archive it extracts is the archive somebody else approved.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-toctou-'));
  try {
    const bundle = sealedBundle(base);
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const script of ['verify-host-security-bundle.sh', 'materialize-host-security.sh']) {
      writeFileSync(join(bin, script), readFileSync(resolve(ROOT, 'infra/scripts', script)));
      chmodSync(join(bin, script), 0o755);
    }
    mkdirSync(join(base, 'contracts'), { recursive: true });
    writeFileSync(join(bin, 'verify-host-security-bundle.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'verify-host-security-bundle.sh'), 0o755);

    // Swap in an archive whose bytes were never authenticated.
    const payload = join(base, 'swapped');
    mkdirSync(payload, { recursive: true });
    const extract = spawnSync('tar', ['-xzf', bundle.archive, '-C', payload], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    writeFileSync(join(payload, 'infra/nginx/am2-webadmin-security.conf'), '# EVIL: allow all\n');
    const repack = spawnSync('tar', ['-czf', bundle.archive, '-C', payload, '.'], { encoding: 'utf8' });
    assert.equal(repack.status, 0, repack.stderr);

    const run = spawnSync('bash', [join(bin, 'materialize-host-security.sh'),
      '--archive', bundle.archive,
      '--manifest', bundle.manifest,
      '--checksums', bundle.checksums,
      '--expected-manifest', bundle.expected,
      '--store-root', join(base, 'store'),
      '--receipt', join(base, 'receipt.json'),
      '--unprivileged-store'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'materializer sealed bytes it never authenticated itself');
    assert.match(run.stderr, /digest|differ|mismatch|does not match the trusted manifest/i);
  } finally {
    discard(base);
  }
});

test('materialization detects an edited contract inside an existing store', () => {
  // The contract is not listed in the manifest's file set, and it is what names
  // the install targets. If the reuse check skips it, one edit repoints the
  // receipt at decoy paths, the real /etc files stop being examined, and the
  // drift audit reports health forever.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-contract-tamper-'));
  try {
    const bundle = sealedBundle(base);
    const first = materializedReceipt(bundle, base);
    const contract = join(first.receiptData.store_path, 'payload/infra/contracts/host-security-contract.json');

    chmodSync(dirname(contract), 0o755);
    chmodSync(contract, 0o644);
    const edited = JSON.parse(readFileSync(contract, 'utf8'));
    edited.files = edited.files.map((file) => file.id === 'nginx-webadmin-production'
      ? { ...file, target: '/etc/nginx/sites-available/decoy.conf' }
      : file);
    writeFileSync(contract, JSON.stringify(edited));

    const again = materialize(bundle, base, ['--unprivileged-store'],
      { storeRoot: first.storeRoot, receipt: join(base, 'receipt-2.json') });
    assert.notEqual(again.run.status, 0, 'materializer reused a store whose contract was edited');
    assert.match(again.run.stderr, /differ|tamper|mismatch|contract/i);
  } finally {
    discard(base);
  }
});

test('materialization resolves a store path before deciding it is not a system path', () => {
  // A string match on the leading path lets /tmp/../etc walk straight past the
  // bound, and land a fixture receipt on the path the timer reads.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-traversal-'));
  try {
    const bundle = sealedBundle(base);
    for (const sneaky of ['/tmp/../etc/am2/host-security', '//etc/am2/host-security']) {
      const { run } = materialize(bundle, base, ['--unprivileged-store'], { storeRoot: sneaky });
      assert.notEqual(run.status, 0, `unprivileged materialization accepted a disguised system path: ${sneaky}`);
      assert.match(run.stderr, /system|privileg/i);
    }
    assert.ok(!existsSync('/etc/am2/host-security'), 'materializer created a system path');
  } finally {
    discard(base);
  }
});

test('installed-state verifier binds a receipt to the trusted manifest rather than its own claims', () => {
  // privileged/materialized_by_uid are self-declared fields in an unsigned
  // file. Flipping one boolean must not turn a fixture receipt into evidence,
  // and a receipt whose digests were rewritten to match tampered bytes must not
  // verify. The trusted manifest is the thing that was independently obtained.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-receipt-trust-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));

    const honest = verifyInstalled(receipt, root, ['--expected-manifest', bundle.expected]);
    assert.equal(honest.status, 0, `${honest.stdout}\n${honest.stderr}`);

    // Digests rewritten to match bytes an attacker installed.
    const forgedPath = join(base, 'forged-receipt.json');
    const forged = JSON.parse(readFileSync(receipt, 'utf8'));
    const tampered = join(base, 'root-tampered');
    installFromReceipt(receiptData, tampered, (where) => {
      writeFileSync(join(where, '/etc/am2/php/webadmin-prepend.php'), '<?php /* attacker */');
    });
    forged.files = forged.files.map((file) => file.id === 'php-webadmin-prepend'
      ? { ...file, sha256: createHash('sha256').update('<?php /* attacker */').digest('hex') }
      : file);
    forged.privileged = true;
    writeFileSync(forgedPath, JSON.stringify(forged));
    chmodSync(forgedPath, 0o644);

    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', forgedPath, '--root', tampered, '--unprivileged-root',
      '--expected-manifest', bundle.expected], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier believed a receipt whose digests were rewritten');
    assert.match(run.stderr, /trusted|manifest/i);
  } finally {
    discard(base);
  }
});

test('the committed Cloudflare real-IP data has not gone stale', () => {
  // Named on purpose. Freshness is a real finding, and when this list ages out
  // the failure should say so directly rather than surfacing as four unrelated
  // host-security tests going red on a date nobody chose.
  const lifecycle = JSON.parse(readFileSync(resolve(ROOT, 'infra/contracts/cloudflare-realip-lifecycle.json'), 'utf8'));
  const conf = readFileSync(resolve(ROOT, 'infra/nginx/am2-cloudflare-realip.conf'), 'utf8');
  const marker = conf.match(/# Regenerated (\d{4}-\d{2}-\d{2})/);
  assert.ok(marker, 'the real-IP data carries no generation marker');
  const age = Math.floor((Date.now() - Date.parse(`${marker[1]}T00:00:00Z`)) / 86400000);
  assert.ok(age <= lifecycle.staleness.warn_after_days,
    `Cloudflare real-IP data was generated ${age} days ago, past the ` +
    `${lifecycle.staleness.warn_after_days}-day warning threshold. ` +
    'Run infra/scripts/refresh-cloudflare-ranges.sh and commit the result.');
});


test('a published materialization is verified whichever path produced it', () => {
  const script = readFileSync(materializerPath, 'utf8');
  const call = 'compare_against_staged "$destination/payload"';
  assert.equal(script.split(call).length - 1, 1,
    'the store comparison is branch-specific; some path can reach a receipt without it');
  assert.ok(script.indexOf(call) > script.lastIndexOf('mv -T -n'),
    'the store comparison does not run after publishing');
  assert.ok(script.indexOf(call) < script.indexOf('"$receipt" "$unprivileged"'),
    'the receipt is written before the store is compared');
});

test('a root that resolves to the real host is never treated as a fixture', () => {
  // `//`, `/tmp/../` and `/.` all reach the real host through the kernel while a
  // string compare reads them as a fixture -- which would skip the trusted
  // manifest requirement, the receipt protection checks and the root-ownership
  // check, then print a clean bill of health for the live host.
  //
  // Asserted on the refusal message rather than the exit status, because a
  // build that got this wrong would also exit non-zero, for the wrong reason.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-rootresolve-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt } = materializedReceipt(bundle, base);
    for (const disguised of ['//', '/tmp/../', '/.']) {
      const run = spawnSync('bash', [installedVerifierPath,
        '--receipt', receipt, '--root', disguised, '--unprivileged-root'], { encoding: 'utf8' });
      assert.match(run.stderr, /cannot be used against the real host root/,
        `${disguised} was not recognised as the real host root`);
    }
  } finally {
    discard(base);
  }
});

test('a receipt the world can write is refused', () => {
  // A receipt is the thing everything downstream trusts. If anyone can edit it,
  // they decide what "verified" means.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-receiptperm-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));
    assert.equal(verifyInstalled(receipt, root).status, 0, 'baseline receipt should verify');

    chmodSync(receipt, 0o666);
    const run = verifyInstalled(receipt, root);
    assert.notEqual(run.status, 0, 'verifier accepted a world-writable receipt');
    assert.match(run.stderr, /world-writable|writable beyond/i);
  } finally {
    discard(base);
  }
});

test('installed-state verifier will not follow a receipt that redirects a target', () => {
  // Binding only the digests leaves `target` and `mode` on trust, and those are
  // what decide which file is examined at all. Repointing one entry at a decoy
  // path -- leaving every digest untouched, so the manifest binding still
  // matches -- makes the audit read the decoy, report health, and never look at
  // the live file again.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-redirect-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const governedId = 'nginx-cloudflare-realip';
    const entry = receiptData.files.find((file) => file.id === governedId);

    const root = installFromReceipt(receiptData, join(base, 'root'), (where) => {
      // The live file gains a range the attacker controls.
      const live = join(where, entry.target);
      writeFileSync(live, `${readFileSync(live, 'utf8')}set_real_ip_from 203.0.113.7/32;\n`);
      // ...and pristine bytes are placed where the receipt will be told to look.
      const decoy = join(where, '/etc/am2/decoy-realip.conf');
      mkdirSync(dirname(decoy), { recursive: true });
      writeFileSync(decoy, readFileSync(join(receiptData.store_path, 'payload', entry.origin)));
      chmodSync(decoy, 0o644);
    });

    const redirected = join(base, 'redirected-receipt.json');
    const data = JSON.parse(readFileSync(receipt, 'utf8'));
    data.files = data.files.map((file) => file.id === governedId
      ? { ...file, target: '/etc/am2/decoy-realip.conf' }
      : file);
    writeFileSync(redirected, JSON.stringify(data));
    chmodSync(redirected, 0o644);

    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', redirected, '--root', root, '--unprivileged-root',
      '--expected-manifest', bundle.expected], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier followed a receipt that repointed a target at a decoy');
    // It looked at the live file the contract names, not the decoy the receipt
    // pointed at -- which is the whole point.
    assert.match(run.stderr, /am2-cloudflare-realip\.conf: installed bytes differ/,
      'verifier did not examine the path the contract declares');
    assert.doesNotMatch(run.stderr, /decoy/, 'verifier read the decoy path');
  } finally {
    discard(base);
  }
});

test('installed-state verifier will not accept a receipt that relaxes a mode', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-relaxmode-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'), (where) => {
      chmodSync(join(where, '/etc/am2/php/webadmin-prepend.php'), 0o666);
    });

    const relaxed = join(base, 'relaxed-receipt.json');
    const data = JSON.parse(readFileSync(receipt, 'utf8'));
    data.files = data.files.map((file) => file.id === 'php-webadmin-prepend'
      ? { ...file, mode: '0666' }
      : file);
    writeFileSync(relaxed, JSON.stringify(data));
    chmodSync(relaxed, 0o644);

    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', relaxed, '--root', root, '--unprivileged-root',
      '--expected-manifest', bundle.expected], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier accepted a receipt that relaxed an expected mode');
    assert.match(run.stderr, /mode|contract/i);
  } finally {
    discard(base);
  }
});

test('installed-state verifier refuses a contract from a store that fails its digest', () => {
  // Requiring the contract to come from the store is only worth something if
  // the store is checked: otherwise an attacker builds their own store, points
  // a receipt at it, and supplies the contract from inside it.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-fakestore-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));

    // A copy of the store with the contract rewritten, and a receipt pointed at it.
    const fakeStore = join(base, 'fake-store');
    assert.equal(spawnSync('cp', ['-a', receiptData.store_path, fakeStore]).status, 0);
    spawnSync('chmod', ['-R', 'u+w', fakeStore]);
    const fakeContract = join(fakeStore, 'payload/infra/contracts/host-security-contract.json');
    const contract = JSON.parse(readFileSync(fakeContract, 'utf8'));
    contract.files = contract.files.map((file) => file.id === 'php-webadmin-prepend'
      ? { ...file, mode: '0666' }
      : file);
    writeFileSync(fakeContract, JSON.stringify(contract));

    const pointed = join(base, 'pointed-receipt.json');
    writeFileSync(pointed, JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), store_path: fakeStore }));
    chmodSync(pointed, 0o644);

    const run = verifyInstalled(pointed, root, ['--expected-manifest', bundle.expected]);
    assert.notEqual(run.status, 0, 'verifier accepted a contract from a store that fails its digest');
    assert.match(run.stderr, /digest|payload|sealed/i);
  } finally {
    discard(base);
  }
});

test('installed-state verifier refuses a store containing a symlink', () => {
  // The materializer refuses symlinks on the way in. The verifier must too:
  // it copies the store to normalise modes before hashing, and a link to
  // /dev/zero would be copied faithfully until the disk -- or the unit's
  // PrivateTmp -- filled, with no digest ever computed.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-storelink-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));

    const store = join(base, 'linked-store');
    assert.equal(spawnSync('cp', ['-a', receiptData.store_path, store]).status, 0);
    spawnSync('chmod', ['-R', 'u+w', store]);
    symlinkSync('/dev/zero', join(store, 'payload/infra/nginx/am2-siphon.conf'));

    const pointed = join(base, 'pointed-receipt.json');
    writeFileSync(pointed, JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), store_path: store }));
    chmodSync(pointed, 0o644);

    const run = verifyInstalled(pointed, root, ['--expected-manifest', bundle.expected]);
    assert.notEqual(run.status, 0, 'verifier accepted a store containing a symlink');
    assert.match(run.stderr, /symlink/i);
  } finally {
    discard(base);
  }
});

test('materialization anchors on the trusted manifest, not the bundle manifest', () => {
  // The bundle verifier authenticates and returns; the archive AND the manifest
  // beside it are then read again from mutable paths. Swapping both after the
  // verifier returns makes forged bytes agree with a forged manifest, and the
  // trusted manifest -- the only thing obtained independently -- is never
  // consulted again. Re-deriving digests is worthless when the thing being
  // derived against moved too.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-anchor-'));
  try {
    const bundle = sealedBundle(base);
    const trustedPayload = JSON.parse(readFileSync(bundle.expected, 'utf8')).payload_sha256;

    // A second, forged bundle built from tampered sources.
    const evil = join(base, 'evil');
    assert.equal(spawnSync('cp', ['-a', bundle.source, evil]).status, 0);
    spawnSync('chmod', ['-R', 'u+w', evil]);
    const victim = join(evil, 'infra/nginx/am2-webadmin-security.conf');
    writeFileSync(victim, `${readFileSync(victim, 'utf8')}# EVIL: allow all\n`);
    assert.equal(spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x',
      'commit', '-qam', 'tamper'], { cwd: evil }).status, 0);
    const evilSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: evil, encoding: 'utf8' }).stdout.trim();
    const evilOut = join(base, 'evil-bundle');
    assert.equal(spawnSync('bash', [packagerPath, '--source-root', evil,
      '--sha', evilSha, '--output-dir', evilOut], { encoding: 'utf8' }).status, 0);

    // A verifier that authenticates honestly, then swaps both files on the way out.
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'materialize-host-security.sh'), readFileSync(materializerPath));
    chmodSync(join(bin, 'materialize-host-security.sh'), 0o755);
    writeFileSync(join(bin, 'verify-host-security-bundle.sh'), [
      '#!/bin/bash',
      `bash ${resolve(ROOT, 'infra/scripts/verify-host-security-bundle.sh')} "$@" || exit 1`,
      `cp ${join(evilOut, 'am2-host-security.tar.gz')} ${bundle.archive}`,
      `cp ${join(evilOut, 'host-security-manifest.json')} ${bundle.manifest}`,
      'exit 0',
    ].join('\n'));
    chmodSync(join(bin, 'verify-host-security-bundle.sh'), 0o755);

    const receipt = join(base, 'receipt.json');
    const run = spawnSync('bash', [join(bin, 'materialize-host-security.sh'),
      '--archive', bundle.archive, '--manifest', bundle.manifest,
      '--checksums', bundle.checksums, '--expected-manifest', bundle.expected,
      '--store-root', join(base, 'store'), '--receipt', receipt,
      '--unprivileged-store'], { encoding: 'utf8' });

    assert.notEqual(run.status, 0,
      `materializer sealed a payload the trusted manifest does not name\n${run.stdout}\n${run.stderr}`);
    if (existsSync(receipt)) {
      assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).payload_sha256, trustedPayload,
        'a receipt was written for a payload the trusted manifest does not name');
    }
    const sealed = spawnSync('grep', ['-rl', 'EVIL', join(base, 'store')], { encoding: 'utf8' });
    assert.equal(sealed.stdout.trim(), '', 'forged bytes were sealed into the store');
  } finally {
    discard(base);
  }
});

test('lane session stores are compared by identity, not by spelling', () => {
  // Two lanes sharing one session store let a staging session authenticate in
  // production. Comparing the declared strings only catches the spelling: a
  // symlink, a bind mount, or two paths that resolve to the same directory are
  // the same store by every meaning that matters to PHP.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-laneidentity-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);

    const root = installFromReceipt(receiptData, join(base, 'root'), (where) => {
      // Both lanes keep their own spelling; staging's is a symlink to production's.
      const production = join(where, '/var/lib/php/sessions/am2');
      const staging = join(where, '/var/lib/php/sessions/am2-staging');
      rmSync(staging, { recursive: true });
      symlinkSync(production, staging);
    });

    const run = verifyInstalled(receipt, root, ['--expected-manifest', bundle.expected]);
    assert.notEqual(run.status, 0,
      'verifier accepted two lanes whose session stores resolve to one directory');
    assert.match(run.stderr, /session/i);
  } finally {
    discard(base);
  }
});

test('lane session stores must be real private directories', () => {
  // Two distinct strings are not enough: each configured store must exist and
  // retain the sticky, lane-private permissions expected by the Apache vhosts.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-session-metadata-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);

    const missing = installFromReceipt(receiptData, join(base, 'root-missing'), (root) => {
      rmSync(join(root, '/var/lib/php/sessions/am2-staging'), { recursive: true });
    });
    const missingRun = verifyInstalled(receipt, missing, ['--expected-manifest', bundle.expected]);
    assert.notEqual(missingRun.status, 0, 'verifier accepted a missing staging session directory');
    assert.match(missingRun.stderr, /session.*missing|missing.*session/i);

    const loose = installFromReceipt(receiptData, join(base, 'root-loose'), (root) => {
      chmodSync(join(root, '/var/lib/php/sessions/am2'), 0o777);
    });
    const looseRun = verifyInstalled(receipt, loose, ['--expected-manifest', bundle.expected]);
    assert.notEqual(looseRun.status, 0, 'verifier accepted a world-writable production session directory');
    assert.match(looseRun.stderr, /session.*mode|mode.*session/i);
  } finally {
    discard(base);
  }
});

test('real-IP required directives cannot be satisfied from a comment', () => {
  // A commented-out directive is not a directive. Substring matching over the
  // whole file lets a file that has commented out real_ip_header still pass,
  // and nginx would then take the peer address as the client.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-cfcomment-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const governed = receiptData.files.find((file) => file.id === 'nginx-cloudflare-realip');

    const root = installFromReceipt(receiptData, join(base, 'root'), (where) => {
      const target = join(where, governed.target);
      writeFileSync(target, readFileSync(target, 'utf8')
        .replace(/^real_ip_header CF-Connecting-IP;$/m, '# real_ip_header CF-Connecting-IP;'));
    });

    // Reissue so byte equality is satisfied and the shape check is isolated.
    const reissued = reissueFor(base, receipt, bundle.expected, governed.id,
      readFileSync(join(root, governed.target)));
    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', reissued.receipt, '--root', root, '--unprivileged-root',
      '--expected-manifest', reissued.manifest], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier accepted a commented-out required directive');
    assert.match(run.stderr, /directive/i);
  } finally {
    discard(base);
  }
});

test('real-IP data dated in the future is refused', () => {
  // A future generation marker is not fresh data, it is a broken clock or a
  // forged marker -- and treating it as fresh makes the stale-data policy
  // trivially defeatable by writing tomorrow's date.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-cffuture-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const governed = receiptData.files.find((file) => file.id === 'nginx-cloudflare-realip');

    const ahead = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const root = installFromReceipt(receiptData, join(base, 'root'), (where) => {
      const target = join(where, governed.target);
      writeFileSync(target, readFileSync(target, 'utf8')
        .replace(/# Regenerated \d{4}-\d{2}-\d{2}/, `# Regenerated ${ahead}`));
    });

    const reissued = reissueFor(base, receipt, bundle.expected, governed.id,
      readFileSync(join(root, governed.target)));
    const run = spawnSync('bash', [installedVerifierPath,
      '--receipt', reissued.receipt, '--root', root, '--unprivileged-root',
      '--expected-manifest', reissued.manifest], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'verifier accepted real-IP data dated in the future');
    assert.match(run.stderr, /future|ahead/i);
  } finally {
    discard(base);
  }
});

test('a world-writable trust anchor is refused', () => {
  // The manifest supplies every expected digest and the lifecycle supplies the
  // real-IP policy. Whoever can write either decides what "verified" means, so
  // they are held to the same rule as the receipt.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-anchorperm-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const root = installFromReceipt(receiptData, join(base, 'root'));
    const lifecycle = hostLifecycle(base);

    assert.equal(verifyInstalled(receipt, root,
      ['--expected-manifest', bundle.expected, '--lifecycle', lifecycle]).status, 0,
      'baseline should verify');

    chmodSync(bundle.expected, 0o666);
    const manifestRun = verifyInstalled(receipt, root,
      ['--expected-manifest', bundle.expected, '--lifecycle', lifecycle]);
    assert.notEqual(manifestRun.status, 0, 'verifier trusted a world-writable manifest');
    assert.match(manifestRun.stderr, /trusted expected manifest is world-writable/i);
    chmodSync(bundle.expected, 0o644);

    chmodSync(lifecycle, 0o666);
    const lifecycleRun = verifyInstalled(receipt, root,
      ['--expected-manifest', bundle.expected, '--lifecycle', lifecycle]);
    assert.notEqual(lifecycleRun.status, 0, 'verifier trusted a world-writable lifecycle contract');
    assert.match(lifecycleRun.stderr, /lifecycle contract is world-writable/i);
  } finally {
    discard(base);
  }
});
