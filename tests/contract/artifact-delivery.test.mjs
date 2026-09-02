/* Artifact-only delivery boundary: first tracer bullet (Task 1). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(ROOT, '.github/workflows/publish-backend-artifact.yml');
const channelPath = resolve(ROOT, 'infra/contracts/artifact-channel.json');
const packagerPath = resolve(ROOT, 'infra/scripts/package-runtime-artifact.sh');
const verifierPath = resolve(ROOT, 'infra/scripts/verify-runtime-artifact.sh');
const manifestSchemaPath = resolve(ROOT, 'infra/schemas/artifact-manifest.schema.json');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function makeFixtureSource(base) {
  const source = join(base, 'source');
  const run = spawnSync('git', ['clone', '--shared', ROOT, source], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return source;
}

function installProductionDependencies(source) {
  const run = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: join(source, 'server'),
    encoding: 'utf8',
    timeout: 110_000,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
}

function packageFixture(base) {
  const source = makeFixtureSource(base);
  installProductionDependencies(source);
  const output = join(base, 'output');
  const run = spawnSync('bash', [packagerPath,
    '--source-root', source,
    '--sha', sha(),
    '--output-dir', output], { encoding: 'utf8', timeout: 110_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return output;
}

function writeChecksums(output) {
  const files = [
    'am2-backend-runtime.tar.gz',
    'artifact-manifest.json',
    'lockfiles/server-package-lock.json',
    'lockfiles/webadmin-package-lock.json',
  ];
  const rows = files.map((relative) => {
    const digest = crypto.createHash('sha256').update(readFileSync(join(output, relative))).digest('hex');
    return `${digest}  ${relative}`;
  });
  writeFileSync(join(output, 'SHA256SUMS'), `${rows.join('\n')}\n`);
}

function resealArchiveFromPayload(output, payload) {
  const archive = join(output, 'am2-backend-runtime.tar.gz');
  const pack = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const payloadTar = spawnSync('tar', [
    '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner',
    '-C', payload, '-cf', '-', '.',
  ], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(payloadTar.status, 0, payloadTar.stderr?.toString());
  const manifestPath = join(output, 'artifact-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.archive_sha256 = crypto.createHash('sha256').update(readFileSync(archive)).digest('hex');
  manifest.payload_sha256 = crypto.createHash('sha256').update(payloadTar.stdout).digest('hex');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  writeChecksums(output);
}

test('artifact channel keeps a public CI handoff separate from durable private bytes', () => {
  assert.ok(existsSync(channelPath), 'artifact channel contract is missing');
  const channel = JSON.parse(readFileSync(channelPath, 'utf8'));
  assert.equal(channel.schema_version, 1);
  assert.equal(channel.application, 'am2-backend');
  assert.equal(channel.artifact, 'am2-backend-runtime.tar.gz');
  assert.equal(channel.manifest, 'artifact-manifest.json');
  assert.equal(channel.checksums, 'SHA256SUMS');
  assert.equal(channel.source_visibility, 'temporary-public-github-repository');
  assert.equal(channel.ci_builder, 'github-actions-ephemeral-runner');
  assert.equal(channel.transit.source, 'github-actions-artifact');
  assert.equal(channel.transit.maximum_retention_days, 90);
  assert.equal(channel.transit.purpose, 'bounded-handoff-only');
  assert.equal(channel.durable_store.kind, 'self-hosted-private-artifact-cache');
  assert.equal(channel.durable_store.visibility, 'private');
  assert.equal(channel.durable_store.public_webroot, false);
  assert.equal(channel.durable_store.retention_policy, 'accepted-plus-verified-rollback');
  assert.equal(channel.publication.model, 'ci-push');
  assert.equal(channel.publication.identity, 'dedicated-restricted-ci-publisher');
  assert.ok(channel.publication.forbidden.includes('public-github-release-assets'));
  assert.ok(channel.publication.forbidden.includes('runtime-github-token'));
  assert.ok(channel.publication.forbidden.includes('runtime-source-repository-credential'));
  assert.equal(channel.deployment.identity, 'dedicated-bounded-deploy-interface');
  assert.equal(channel.deployment.selection, 'immutable-archive-sha256');
  assert.equal(channel.deployment.no_rebuild, true);
});

test('runtime packager seals an allowlisted artifact without repository residue', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-packager-');
  const source = makeFixtureSource(base);
  installProductionDependencies(source);
  const output = join(base, 'output');
  const sourceSha = sha();
  try {
    const run = spawnSync('bash', [packagerPath,
      '--source-root', source,
      '--sha', sourceSha,
      '--output-dir', output], { encoding: 'utf8', timeout: 110_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    assert.equal(manifest.source_sha, sourceSha);
    assert.equal(manifest.application, 'am2-backend');
    assert.ok(/^[0-9a-f]{64}$/.test(manifest.payload_sha256));
    assert.ok(/^[0-9a-f]{64}$/.test(manifest.archive_sha256));

    const check = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: output, encoding: 'utf8' });
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    const listing = spawnSync('tar', ['-tzf', 'am2-backend-runtime.tar.gz'], { cwd: output, encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    for (const forbidden of ['.git/', '.github/', '.hermes/', 'tests/', 'docs/', '.env', 'WebAdmin/package-lock.json', 'WebAdmin/package.json', 'tailwind.src.css', 'asset/js/src/']) {
      assert.doesNotMatch(listing.stdout, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `runtime archive leaks ${forbidden}`);
    }
    for (const required of ['.release-sha', 'server/server.js', 'server/node_modules/', 'WebAdmin/login.php', 'WebAdmin/asset/js/am2-ui.min.js', 'infra/scripts/smoke-release.sh']) {
      assert.match(listing.stdout, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `runtime archive misses ${required}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runtime packager rejects an untracked source file instead of archiving it', () => {
  const base = tempDir('am2-artifact-packager-untracked-');
  const source = makeFixtureSource(base);
  installProductionDependencies(source);
  writeFileSync(join(source, 'WebAdmin', 'untracked-injected.php'), '<?php echo "no";\n');
  const output = join(base, 'output');
  try {
    const run = spawnSync('bash', [packagerPath,
      '--source-root', source,
      '--sha', sha(),
      '--output-dir', output], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /untracked|clean source/i);
    assert.equal(existsSync(output), false, 'untracked source file produced an artifact');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runtime packager refuses an incomplete transitive production dependency', () => {
  const base = tempDir('am2-artifact-packager-deps-');
  const source = makeFixtureSource(base);
  installProductionDependencies(source);
  rmSync(join(source, 'server', 'node_modules', 'body-parser'), { recursive: true, force: true });
  const output = join(base, 'output');
  try {
    const run = spawnSync('bash', [packagerPath,
      '--source-root', source,
      '--sha', sha(),
      '--output-dir', output], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /production dependency|missing|closure/i);
    assert.equal(existsSync(output), false, 'incomplete dependency tree produced an artifact');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact manifest schema makes the release identity exact', () => {
  assert.ok(existsSync(manifestSchemaPath), 'artifact manifest schema is missing');
  const schema = JSON.parse(readFileSync(manifestSchemaPath, 'utf8'));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  for (const field of ['schema_version', 'application', 'source_sha', 'payload_sha256', 'archive_sha256', 'runtime', 'lockfiles']) {
    assert.ok(schema.required.includes(field), `manifest schema does not require ${field}`);
  }
});

test('artifact verifier rejects a manifest with extra runtime metadata', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-manifest-');
  try {
    const output = packageFixture(base);
    const manifestPath = join(output, 'artifact-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.runtime.unapproved = 'injected';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeChecksums(output);
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', manifestPath,
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /runtime|manifest|key/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact verifier rejects a manifest with a lockfile digest mismatch', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-lockfile-');
  try {
    const output = packageFixture(base);
    const manifestPath = join(output, 'artifact-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.lockfiles.server_package_lock_sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeChecksums(output);
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', manifestPath,
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /lockfile|package-lock|digest/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact verifier rejects a tampered archive before materialization', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-tamper-');
  try {
    const output = packageFixture(base);
    appendFileSync(join(output, 'am2-backend-runtime.tar.gz'), 'tampered');
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(output, 'artifact-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /checksum|sha256|digest/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact verifier rejects an archive containing root repository residue', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-residue-');
  try {
    const output = packageFixture(base);
    const payload = join(base, 'payload');
    mkdirSync(payload);
    const unpack = spawnSync('tar', ['-xzf', join(output, 'am2-backend-runtime.tar.gz'), '-C', payload], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    mkdirSync(join(payload, '.git'), { recursive: true });
    writeFileSync(join(payload, '.git', 'config'), '[core]\n');
    resealArchiveFromPayload(output, payload);
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(output, 'artifact-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /forbidden|\.git|residue/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact verifier rejects nested dependency repository residue', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-nested-residue-');
  try {
    const output = packageFixture(base);
    const payload = join(base, 'payload');
    mkdirSync(payload);
    const unpack = spawnSync('tar', ['-xzf', join(output, 'am2-backend-runtime.tar.gz'), '-C', payload], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    mkdirSync(join(payload, 'server', 'node_modules', 'express', '.github'), { recursive: true });
    writeFileSync(join(payload, 'server', 'node_modules', 'express', '.github', 'residue.txt'), 'no\n');
    resealArchiveFromPayload(output, payload);
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(output, 'artifact-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /forbidden|\.github|residue/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact verifier rejects an external same-basename manifest', { timeout: 120_000 }, () => {
  const base = tempDir('am2-artifact-verify-manifest-binding-');
  try {
    const output = packageFixture(base);
    const external = join(base, 'external');
    mkdirSync(external);
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    manifest.source_sha = '0'.repeat(40);
    writeFileSync(join(external, 'artifact-manifest.json'), `${JSON.stringify(manifest)}\n`);
    const run = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(external, 'artifact-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /manifest.*sealed|checksum directory/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('CI publishes a checksumed backend runtime artifact', () => {
  assert.ok(existsSync(workflowPath), 'no CI runtime-artifact publisher exists');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /upload-artifact|gh\s+release\s+upload|oras\s+push|\bscp\b|\brsync\b/i,
    'CI does not hand its runtime artifact to a retained artifact channel');
  assert.match(workflow, /SHA256SUMS|sha256sum/i,
    'CI does not record a checksum for its runtime artifact');
  assert.match(workflow, /artifact-manifest\.json/,
    'CI does not publish artifact provenance');
  assert.match(workflow, /concurrency:/,
    'two CI runs can publish competing bytes into one artifact channel');
  assert.match(workflow, /source_sha|GITHUB_SHA/,
    'CI artifact publication is not bound to its exact source');
});
