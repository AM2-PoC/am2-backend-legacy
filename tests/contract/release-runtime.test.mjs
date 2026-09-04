import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const build = resolve(root, 'infra/scripts/build-release.sh');
const verify = resolve(root, 'infra/scripts/verify-release-runtime.sh');
const materialize = resolve(root, 'infra/scripts/materialize-runtime-release.sh');
const packageArtifact = resolve(root, 'infra/scripts/package-runtime-artifact.sh');
const atomicRename = resolve(root, 'infra/scripts/atomic-rename-no-replace.py');
const snapshotArtifactInput = resolve(root, 'infra/scripts/snapshot-artifact-input.py');

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function packageArtifactFixture(base, sha) {
  const source = join(base, 'source');
  const clone = spawnSync('git', ['clone', '--shared', root, source], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  const install = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(source, 'server'), encoding: 'utf8', timeout: 300_000 });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const output = join(base, 'ingress');
  const pack = spawnSync('bash', [packageArtifact, '--source-root', source, '--sha', sha, '--output-dir', output], { encoding: 'utf8', timeout: 110_000 });
  assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
  return output;
}

test('artifact snapshot rejects ingress behind a symlinked parent', () => {
  const base = tempDir('am2-snapshot-parent-link-');
  try {
    const realParent = join(base, 'real');
    const linkedParent = join(base, 'linked');
    const ingress = join(realParent, 'ingress');
    mkdirSync(ingress, { recursive: true });
    const destination = join(base, 'snapshot');
    mkdirSync(destination);
    const link = spawnSync('ln', ['-s', realParent, linkedParent], { encoding: 'utf8' });
    assert.equal(link.status, 0, link.stderr);
    const run = spawnSync('python3', [snapshotArtifactInput, '--ingress', join(linkedParent, 'ingress'), '--destination', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /canonical|symlink|ingress/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('atomic release publisher refuses replacing an existing destination', () => {
  const base = tempDir('am2-atomic-release-');
  try {
    const source = join(base, 'source');
    const destination = join(base, 'destination');
    mkdirSync(source);
    mkdirSync(destination);
    const run = spawnSync('python3', [atomicRename, '--source', source, '--destination', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.ok(existsSync(source), 'atomic helper removed source after refusing destination');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('atomic release publisher rejects a symlink source', () => {
  const base = tempDir('am2-atomic-release-link-');
  try {
    const realSource = join(base, 'real-source');
    const source = join(base, 'source-link');
    const destination = join(base, 'destination');
    mkdirSync(realSource);
    const link = spawnSync('ln', ['-s', realSource, source], { encoding: 'utf8' });
    assert.equal(link.status, 0, link.stderr);
    const run = spawnSync('python3', [atomicRename, '--source', source, '--destination', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.ok(lstatSync(source).isSymbolicLink(), 'atomic helper followed or removed symlink source');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact materializer rejects malformed identity without creating release destination', () => {
  const base = tempDir('am2-materialize-invalid-');
  try {
    const ingress = join(base, 'ingress');
    const destination = join(base, 'releases', 'candidate');
    mkdirSync(ingress, { recursive: true });
    const run = spawnSync('bash', [materialize,
      '--archive', join(ingress, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(ingress, 'artifact-manifest.json'),
      '--checksums', join(ingress, 'SHA256SUMS'),
      '--dest', destination,
      '--webadmin-update', join(base, 'webadmin-update'),
      '--server-update', join(base, 'server-update')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /missing|required|artifact|shared update/i);
    assert.equal(spawnSync('test', ['-e', destination]).status, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact materializer creates immutable runnable release and leaves current untouched', { timeout: 180_000 }, () => {
  const base = tempDir('am2-materialize-green-');
  const sha = git('rev-parse', 'HEAD');
  try {
    const ingress = packageArtifactFixture(base, sha);
    const environment = join(base, 'environment');
    const destination = join(environment, 'releases', `candidate-${sha.slice(0, 12)}`);
    mkdirSync(join(environment, 'releases'), { recursive: true });
    chmodSync(join(environment, 'releases'), 0o2775);
    const webadminUpdate = join(environment, 'shared', 'webadmin-update');
    const serverUpdate = join(environment, 'shared', 'server-update');
    const current = join(environment, 'current');
    mkdirSync(webadminUpdate, { recursive: true });
    mkdirSync(serverUpdate, { recursive: true });
    const run = spawnSync('bash', [materialize,
      '--archive', join(ingress, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(ingress, 'artifact-manifest.json'),
      '--checksums', join(ingress, 'SHA256SUMS'),
      '--dest', destination,
      '--webadmin-update', webadminUpdate,
      '--server-update', serverUpdate], { encoding: 'utf8', timeout: 110_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(join(destination, '.release-sha'), 'utf8').trim(), sha);
    const artifactIdentity = JSON.parse(readFileSync(join(destination, '.artifact-identity.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(ingress, 'artifact-manifest.json'), 'utf8'));
    assert.deepEqual(artifactIdentity, {
      source_sha: manifest.source_sha,
      archive_sha256: manifest.archive_sha256,
      payload_sha256: manifest.payload_sha256,
    });
    assert.equal(readlinkSync(join(destination, 'WebAdmin/update')), webadminUpdate);
    assert.equal(readlinkSync(join(destination, 'server/update')), serverUpdate);
    assert.equal(existsSync(current), false, 'materializer changed current release pointer');
    const preflight = spawnSync('bash', [verify, destination, sha], { encoding: 'utf8' });
    assert.equal(preflight.status, 0, `${preflight.stdout}\n${preflight.stderr}`);
    const verifyMaterialized = resolve(root, 'infra/scripts/verify-materialized-artifact.sh');
    const intact = spawnSync('bash', [verifyMaterialized, '--release', destination,
      '--manifest', join(ingress, 'artifact-manifest.json')], { encoding: 'utf8' });
    assert.equal(intact.status, 0, `${intact.stdout}\n${intact.stderr}`);
    assert.equal(statSync(join(destination, 'server')).mode & 0o777, 0o755,
      'materialized setgid release directory changes the sealed payload digest');
    assert.equal(statSync(join(destination, 'server')).mode & 0o2000, 0o2000,
      'setgid releases root did not exercise inherited directory mode normalization');
    chmodSync(join(destination, 'server'), 0o700);
    const permissionTampered = spawnSync('bash', [verifyMaterialized, '--release', destination,
      '--manifest', join(ingress, 'artifact-manifest.json')], { encoding: 'utf8' });
    assert.notEqual(permissionTampered.status, 0,
      'materialized verifier normalized an unauthorized sealed child-directory mode');
    chmodSync(join(destination, 'server'), 0o755);
    writeFileSync(join(destination, 'server/server.js'), '\n// tampered\n', { flag: 'a' });
    const tampered = spawnSync('bash', [verifyMaterialized, '--release', destination,
      '--manifest', join(ingress, 'artifact-manifest.json')], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0, 'mutated materialized runtime retained artifact identity');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact materializer rejects a shared update directory behind a symlinked parent', { timeout: 180_000 }, () => {
  const base = tempDir('am2-materialize-update-parent-link-');
  const sha = git('rev-parse', 'HEAD');
  try {
    const ingress = packageArtifactFixture(base, sha);
    const realShared = join(base, 'real-shared');
    const linkedParent = join(base, 'linked-shared');
    const serverUpdate = join(base, 'server-update');
    mkdirSync(realShared);
    mkdirSync(serverUpdate);
    const link = spawnSync('ln', ['-s', realShared, linkedParent], { encoding: 'utf8' });
    assert.equal(link.status, 0, link.stderr);
    const run = spawnSync('bash', [materialize,
      '--archive', join(ingress, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(ingress, 'artifact-manifest.json'),
      '--checksums', join(ingress, 'SHA256SUMS'),
      '--dest', join(base, 'releases', 'candidate'),
      '--webadmin-update', linkedParent,
      '--server-update', serverUpdate], { encoding: 'utf8', timeout: 110_000 });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /canonical|symlink|shared update/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('artifact materializer never overwrites destination or release pointer', { timeout: 180_000 }, () => {
  const base = tempDir('am2-materialize-existing-');
  const sha = git('rev-parse', 'HEAD');
  try {
    const ingress = packageArtifactFixture(base, sha);
    const environment = join(base, 'environment');
    const destination = join(environment, 'releases', 'existing');
    const webadminUpdate = join(environment, 'shared', 'webadmin-update');
    const serverUpdate = join(environment, 'shared', 'server-update');
    const current = join(environment, 'current');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'sentinel'), 'keep\n');
    mkdirSync(webadminUpdate, { recursive: true });
    mkdirSync(serverUpdate, { recursive: true });
    const currentLink = spawnSync('ln', ['-s', destination, current], { encoding: 'utf8' });
    assert.equal(currentLink.status, 0, currentLink.stderr);
    const run = spawnSync('bash', [materialize,
      '--archive', join(ingress, 'am2-backend-runtime.tar.gz'),
      '--manifest', join(ingress, 'artifact-manifest.json'),
      '--checksums', join(ingress, 'SHA256SUMS'),
      '--dest', destination,
      '--webadmin-update', webadminUpdate,
      '--server-update', serverUpdate], { encoding: 'utf8', timeout: 110_000 });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /already exists/i);
    assert.equal(readFileSync(join(destination, 'sentinel'), 'utf8'), 'keep\n');
    assert.equal(readlinkSync(current), destination);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder rejects a destination that already exists', () => {
  const base = tempDir('am2-release-existing-');
  try {
    const destination = join(base, 'candidate');
    const make = spawnSync('mkdir', [destination]);
    assert.equal(make.status, 0);
    const sha = git('rev-parse', 'HEAD');
    const run = spawnSync('bash', [build, '--repo', root, '--sha', sha, '--dest', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /already exists/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder rejects a non-commit SHA before creating destination', () => {
  const base = tempDir('am2-release-invalid-');
  try {
    const destination = join(base, 'candidate');
    const run = spawnSync('bash', [build, '--repo', root, '--sha', 'not-a-commit', '--dest', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /commit|SHA/i);
    const exists = spawnSync('test', ['-e', destination]);
    assert.notEqual(exists.status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder rejects a moving symbolic ref', () => {
  const base = tempDir('am2-release-symbolic-');
  try {
    const destination = join(base, 'candidate');
    const run = spawnSync('bash', [build, '--repo', root, '--sha', 'HEAD', '--dest', destination], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /40-character|exact SHA/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runtime verifier rejects marker mismatch and a dependency-less archive', () => {
  const base = tempDir('am2-release-verify-');
  const archive = join(base, 'archive');
  const sha = git('rev-parse', 'HEAD');
  try {
    const extract = spawnSync('bash', ['-c', 'mkdir -p "$1" && git archive "$2" | tar -x -C "$1"', '_', archive, sha], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(extract.status, 0, extract.stderr);

    const mismatch = spawnSync('bash', [verify, archive, '0'.repeat(40)], { encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /marker|SHA|mismatch/i);

    const marker = spawnSync('bash', ['-c', 'printf "%s\\n" "$1" > "$2/.release-sha"', '_', sha, archive]);
    assert.equal(marker.status, 0);
    const dependency = spawnSync('bash', [verify, archive, sha], { encoding: 'utf8' });
    assert.notEqual(dependency.status, 0);
    assert.match(dependency.stderr, /node_modules|dependenc|resolve/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release verifier rejects a missing transitive production dependency', { timeout: 180_000 }, () => {
  const base = tempDir('am2-release-transitive-dependency-');
  const destination = join(base, 'candidate');
  const sha = git('rev-parse', 'HEAD');
  try {
    const buildRun = spawnSync('bash', [build, '--repo', root, '--sha', sha, '--dest', destination], { encoding: 'utf8', timeout: 110_000 });
    assert.equal(buildRun.status, 0, `${buildRun.stdout}\n${buildRun.stderr}`);
    const remove = spawnSync('rm', ['-rf', join(destination, 'server', 'node_modules', 'body-parser')]);
    assert.equal(remove.status, 0);
    const run = spawnSync('bash', [verify, destination, sha], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /dependency|missing|closure/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder creates an exact immutable runnable artifact', { timeout: 120_000 }, () => {
  const base = tempDir('am2-release-build-');
  const destination = join(base, 'candidate');
  const sha = git('rev-parse', 'HEAD');
  try {
    const run = spawnSync('bash', [build, '--repo', root, '--sha', sha, '--dest', destination], {
      encoding: 'utf8',
      timeout: 110_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(join(destination, '.release-sha'), 'utf8').trim(), sha);
    assert.equal(statSync(destination).mode & 0o777, 0o750);
    assert.ok(statSync(join(destination, 'server/node_modules')).isDirectory());

    const preflight = spawnSync('bash', [verify, destination, sha], { encoding: 'utf8' });
    assert.equal(preflight.status, 0, `${preflight.stdout}\n${preflight.stderr}`);

    const tracked = git('ls-tree', '-r', '--name-only', sha);
    assert.ok(tracked.length > 0);
    assert.equal(readFileSync(join(destination, '.release-sha'), 'utf8').trim(), sha);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder seals runtime update links before final publication', { timeout: 120_000 }, () => {
  const base = tempDir('am2-release-links-');
  const destination = join(base, 'candidate');
  const webadminUpdate = join(base, 'shared-webadmin-update');
  const serverUpdate = join(base, 'shared-server-update');
  const sha = git('rev-parse', 'HEAD');
  mkdirSync(webadminUpdate);
  mkdirSync(serverUpdate);
  try {
    const run = spawnSync('bash', [
      build,
      '--repo', root,
      '--sha', sha,
      '--dest', destination,
      '--webadmin-update', webadminUpdate,
      '--server-update', serverUpdate,
    ], { encoding: 'utf8', timeout: 110_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readlinkSync(join(destination, 'WebAdmin/update')), webadminUpdate);
    assert.equal(readlinkSync(join(destination, 'server/update')), serverUpdate);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('release builder publishes a directory the web server can traverse', { timeout: 120_000 }, () => {
  /*
   * A release is mode 0750, so on a deploy host the group is the web server's
   * only way in. Apache could not enter a published release and answered 403
   * for all of WebAdmin:
   *
   *   AH00035: access to /api_login.php denied ... search permissions are
   *   missing on a component of the path
   *
   * The group comes from the directory releases are published into, through
   * setgid, so it is inherited with no privilege. The builder cannot set it
   * itself — it runs unprivileged and cannot join a group it does not belong
   * to, and trying failed the build on CI rather than fixing the host.
   *
   * So what is pinned is the property that holds everywhere: a published
   * release carries the group of the directory it was published into. On a
   * host with setgid that is the web group; here it is the temp directory's
   * own group, and a builder that reset it would fail this either way.
   */
  const base = tempDir('am2-release-group-');
  const destination = join(base, 'candidate');
  const sha = git('rev-parse', 'HEAD');
  try {
    const run = spawnSync('bash', [build, '--repo', root, '--sha', sha, '--dest', destination], {
      encoding: 'utf8',
      timeout: 110_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    assert.equal(statSync(destination).gid, statSync(base).gid,
      'the release does not carry the group of the directory it was published into');
    assert.equal(statSync(join(destination, 'WebAdmin')).gid, statSync(base).gid,
      'WebAdmin does not carry the published group');
    // The mode stays closed to everyone else; the group is what opens it.
    assert.equal(statSync(destination).mode & 0o777, 0o750);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
