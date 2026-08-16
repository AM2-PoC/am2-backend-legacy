import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const build = resolve(root, 'infra/scripts/build-release.sh');
const verify = resolve(root, 'infra/scripts/verify-release-runtime.sh');

function git(...args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
