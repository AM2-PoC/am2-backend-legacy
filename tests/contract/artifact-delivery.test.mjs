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
const deployIdentityPath = resolve(ROOT, 'infra/contracts/deploy-identity.json');
const cacheReceiverPath = resolve(ROOT, 'infra/scripts/am2-artifact-cache-receive.py');
const cacheSshWrapperPath = resolve(ROOT, 'infra/scripts/am2-artifact-cache-ssh-wrapper.py');

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

test('cache SSH wrapper rejects any command outside immutable stdin ingress', () => {
  assert.ok(existsSync(cacheSshWrapperPath), 'cache SSH wrapper is missing');
  const root = tempDir('am2-cache-wrapper-');
  try {
    for (const command of ['', 'bash', 'am2-artifact-cache-receive --source /tmp/x --destination latest', `am2-artifact-cache-receive --stdin --destination ${'a'.repeat(40)}/latest`]) {
      const run = spawnSync('python3', [cacheSshWrapperPath, '--root', join(root, 'cache')], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: command } });
      assert.notEqual(run.status, 0, `cache SSH wrapper accepted ${command || 'empty command'}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache SSH wrapper receives only a verified immutable stdin bundle', { timeout: 120_000 }, () => {
  const base = tempDir('am2-cache-wrapper-positive-');
  try {
    const output = packageFixture(base);
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    const files = ['am2-backend-runtime.tar.gz', 'artifact-manifest.json', 'SHA256SUMS', 'lockfiles/server-package-lock.json', 'lockfiles/webadmin-package-lock.json'];
    const bundle = spawnSync('tar', ['-C', output, '-cf', '-', ...files], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(bundle.status, 0, bundle.stderr?.toString());
    const cache = join(base, 'cache');
    const destination = `${manifest.source_sha}/${manifest.archive_sha256}`;
    const run = spawnSync('python3', [cacheSshWrapperPath, '--root', cache], {
      encoding: 'utf8',
      input: bundle.stdout,
      env: { ...process.env, SSH_ORIGINAL_COMMAND: `am2-artifact-cache-receive --stdin --destination ${destination}` },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(existsSync(join(cache, destination, 'am2-backend-runtime.tar.gz')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache receiver rejects a mutable or malformed artifact destination', () => {
  assert.ok(existsSync(cacheReceiverPath), 'cache receiver is missing');
  const root = tempDir('am2-cache-receiver-');
  try {
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'placeholder'), 'x\n');
    for (const destination of ['latest', '../escape', `${'a'.repeat(40)}/${'b'.repeat(64)}/extra`]) {
      const run = spawnSync('python3', [cacheReceiverPath, '--root', join(root, 'cache'), '--source', source, '--destination', destination], { encoding: 'utf8' });
      assert.notEqual(run.status, 0, `receiver accepted ${destination}`);
    }
    const sourceLink = join(root, 'source-link');
    const link = spawnSync('ln', ['-s', source, sourceLink], { encoding: 'utf8' });
    assert.equal(link.status, 0, link.stderr);
    const run = spawnSync('python3', [cacheReceiverPath, '--root', join(root, 'cache'), '--source', sourceLink, '--destination', `${'a'.repeat(40)}/${'b'.repeat(64)}`], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'receiver accepted a symlinked artifact ingress');
    assert.match(run.stderr, /symlink|regular artifact/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache receiver stores one verified immutable artifact bundle', { timeout: 120_000 }, () => {
  const base = tempDir('am2-cache-receiver-positive-');
  try {
    const output = packageFixture(base);
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    const cache = join(base, 'cache');
    const destination = `${manifest.source_sha}/${manifest.archive_sha256}`;
    const run = spawnSync('python3', [cacheReceiverPath, '--root', cache, '--source', output, '--destination', destination], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const stored = join(cache, destination);
    assert.equal(readFileSync(join(stored, 'artifact-manifest.json'), 'utf8'), readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(stored, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(stored, 'artifact-manifest.json'),
      '--checksums', join(stored, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache receiver stores a verified immutable bundle from standard input', { timeout: 120_000 }, () => {
  const base = tempDir('am2-cache-receiver-stdin-');
  try {
    const output = packageFixture(base);
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    const files = ['am2-backend-runtime.tar.gz', 'artifact-manifest.json', 'SHA256SUMS', 'lockfiles/server-package-lock.json', 'lockfiles/webadmin-package-lock.json'];
    const bundle = spawnSync('tar', ['-C', output, '-cf', '-', ...files], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(bundle.status, 0, bundle.stderr?.toString());
    const cache = join(base, 'cache');
    const destination = `${manifest.source_sha}/${manifest.archive_sha256}`;
    const run = spawnSync('python3', [cacheReceiverPath, '--root', cache, '--stdin', '--destination', destination], { encoding: 'utf8', input: bundle.stdout });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(existsSync(join(cache, destination, 'am2-backend-runtime.tar.gz')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache receiver never overwrites an existing immutable artifact bundle', { timeout: 120_000 }, () => {
  const base = tempDir('am2-cache-receiver-overwrite-');
  try {
    const output = packageFixture(base);
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    const cache = join(base, 'cache');
    const destination = `${manifest.source_sha}/${manifest.archive_sha256}`;
    const first = spawnSync('python3', [cacheReceiverPath, '--root', cache, '--source', output, '--destination', destination], { encoding: 'utf8' });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const second = spawnSync('python3', [cacheReceiverPath, '--root', cache, '--source', output, '--destination', destination], { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists|immutable/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deploy identity remains bounded to immutable artifacts', () => {
  assert.ok(existsSync(deployIdentityPath), 'deploy identity contract is missing');
  const identity = JSON.parse(readFileSync(deployIdentityPath, 'utf8'));
  assert.equal(identity.schema_version, 1);
  assert.equal(identity.identity, 'dedicated-bounded-deploy-interface');
  assert.equal(identity.artifact.selection, 'immutable-archive-sha256');
  assert.equal(identity.artifact.mutable_references_allowed, false);
  assert.equal(identity.source_repository.access, 'none');
  assert.equal(identity.privileges.arbitrary_shell, false);
  assert.equal(identity.privileges.broad_sudo, false);
  assert.equal(identity.privileges.runtime_secret_write, false);
  assert.equal(identity.privileges.rollback_artifact_delete, false);
  assert.deepEqual(identity.services.may_restart, ['am2-api', 'am2-api-staging']);
  assert.deepEqual(identity.services.may_reload, ['apache2', 'nginx']);
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

test('CI packages an explicit exact-main candidate only after source checks succeed', () => {
  assert.ok(existsSync(workflowPath), 'no CI runtime-artifact publisher exists');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/,
    'CI artifact publication is not an explicit operator action');
  assert.match(workflow, /source_sha:/,
    'CI artifact publisher does not require an exact source SHA');
  assert.doesNotMatch(workflow, /workflow_run:/,
    'CI artifact publisher would spend quota automatically after every main push');
  assert.match(workflow, /actions\/workflows\/source-checks\.yml\/runs/,
    'CI artifact publisher does not verify source-check workflow evidence');
  assert.match(workflow, /conclusion.*success|success.*conclusion/s,
    'CI artifact publisher accepts a source SHA without successful checks');
  assert.match(workflow, /head_branch.*main|main.*head_branch/s,
    'CI artifact publisher accepts a source SHA outside main');
  assert.match(workflow, /actions\/checkout@v4/,
    'CI artifact publisher does not checkout source');
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.source_sha\s*\}\}/,
    'CI artifact publisher does not checkout the explicit exact source SHA');
  assert.match(workflow, /npm --prefix server ci --omit=dev --ignore-scripts/,
    'CI artifact publisher does not install the locked production dependency tree');
  assert.match(workflow, /package-runtime-artifact\.sh/,
    'CI artifact publisher does not use the sealed runtime packager');
  assert.match(workflow, /verify-runtime-artifact\.sh/,
    'CI artifact publisher does not verify its archive before publication');
  assert.match(workflow, /upload-artifact@v4/,
    'CI does not preserve the bounded handoff artifact');
  assert.match(workflow, /retention-days:\s*90/,
    'CI handoff artifact retention is not bounded at 90 days');
  assert.match(workflow, /am2-backend-runtime\.tar\.gz[\s\S]{0,300}artifact-manifest\.json[\s\S]{0,300}SHA256SUMS/,
    'CI artifact upload omits archive provenance or checksums');
  assert.match(workflow, /ARTIFACT_CACHE_SSH_PRIVATE_KEY/,
    'CI publisher does not require the restricted private-cache identity');
  assert.match(workflow, /known_hosts/,
    'CI publisher does not pin private-cache host verification');
  assert.match(workflow, /concurrency:/,
    'two CI runs can publish competing bytes into one artifact channel');
  assert.match(workflow, /source_sha|head_sha/,
    'CI artifact publication is not bound to its exact source');
});
