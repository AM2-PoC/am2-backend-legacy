import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/contracts/host-security-contract.json');
const packagerPath = resolve(ROOT, 'infra/scripts/package-host-security-bundle.sh');
const verifierPath = resolve(ROOT, 'infra/scripts/verify-host-security-bundle.sh');

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

function cleanSource(base) {
  return cloneSource(base);
}

function packageBundle(base, sha = sourceSha(), source = ROOT) {
  const output = join(base, 'bundle');
  const run = spawnSync('bash', [packagerPath,
    '--source-root', source,
    '--sha', sha,
    '--output-dir', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return output;
}

test('host-security bundle seals the exact source contract outside the runtime payload', () => {
  assert.ok(existsSync(contractPath), 'missing host-security contract');
  assert.ok(existsSync(packagerPath), 'missing host-security bundle packager');
  assert.ok(existsSync(verifierPath), 'missing host-security bundle verifier');

  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-bundle-'));
  try {
    const source = cleanSource(base);
    const output = packageBundle(base, sourceSha(), source);
    const manifestPath = join(output, 'host-security-manifest.json');
    const archivePath = join(output, 'am2-host-security.tar.gz');
    const checksumsPath = join(output, 'SHA256SUMS');
    for (const file of [manifestPath, archivePath, checksumsPath]) {
      assert.ok(existsSync(file), `missing sealed host-security bundle file: ${file}`);
    }

    const verify = spawnSync('bash', [verifierPath,
      '--archive', archivePath,
      '--manifest', manifestPath,
      '--checksums', checksumsPath], { encoding: 'utf8' });
    assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);

    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.source_sha, sourceSha());
    assert.deepEqual(manifest.files.map((file) => file.id).sort(), contract.files.map((file) => file.id).sort());

    const listed = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    for (const file of manifest.files) {
      const path = `./${file.origin}`;
      assert.match(listed.stdout, new RegExp(`(?:^|\\n)${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`),
        `bundle omits host-security origin: ${file.origin}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security bundle is reproducible for the same exact source identity', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-reproducible-'));
  try {
    const first = packageBundle(join(base, 'first'), sourceSha(), cleanSource(join(base, 'first-source')));
    const second = packageBundle(join(base, 'second'), sourceSha(), cleanSource(join(base, 'second-source')));
    for (const file of ['am2-host-security.tar.gz', 'host-security-manifest.json', 'SHA256SUMS']) {
      const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
      assert.equal(digest(join(first, file)), digest(join(second, file)),
        `${file} changes for the same source identity`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects a source identity other than its checked-out commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-sha-'));
  try {
    assert.throws(() => packageBundle(base, '0'.repeat(40)), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects a dirty source checkout', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-dirty-'));
  try {
    const source = cloneSource(base);
    appendFileSync(join(source, 'infra/php/webadmin-prepend.php'), '\n// uncommitted mutation\n');
    assert.throws(() => packageBundle(base, sourceSha(), source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects untracked source input', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-untracked-'));
  try {
    const source = cloneSource(base);
    writeFileSync(join(source, 'infra/php/unsealed-host-setting.ini'), 'unsealed\n');
    assert.throws(() => packageBundle(base, sourceSha(), source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects altered bundle bytes even when the manifest is unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-archive-tamper-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    appendFileSync(join(output, 'am2-host-security.tar.gz'), 'tampered');

    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'altered host-security archive retained trusted bundle status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects altered manifest provenance', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-tamper-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const manifestPath = join(output, 'host-security-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.source_sha = '0'.repeat(40);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', manifestPath,
      '--checksums', join(output, 'SHA256SUMS')], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'altered manifest retained trusted bundle status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
