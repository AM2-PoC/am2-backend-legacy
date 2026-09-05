import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const contractPath = resolve(ROOT, 'infra/contracts/host-security-contract.json');
const packagerPath = resolve(ROOT, 'infra/scripts/package-host-security-bundle.sh');
const verifierPath = resolve(ROOT, 'infra/scripts/verify-host-security-bundle.sh');

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

function cleanSource(base) {
  return cloneSource(base);
}

function packageBundle(base, sha = sourceSha(), source = ROOT, environment = {}) {
  const output = join(base, 'bundle');
  const run = spawnSync('bash', [packagerPath,
    '--source-root', source,
    '--sha', sha,
    '--output-dir', output], { encoding: 'utf8', env: { ...process.env, ...environment } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return output;
}

function trustedManifest(base, output) {
  const trusted = join(base, 'trusted-host-security-manifest.json');
  writeFileSync(trusted, readFileSync(join(output, 'host-security-manifest.json')));
  return trusted;
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

    const trusted = trustedManifest(base, output);
    const verify = spawnSync('bash', [verifierPath,
      '--archive', archivePath,
      '--manifest', manifestPath,
      '--checksums', checksumsPath,
      '--expected-manifest', trusted], { encoding: 'utf8' });
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

test('host-security packager rejects an empty contract file set', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-empty-contract-'));
  try {
    const source = cloneSource(base);
    const contractPath = join(source, 'infra/contracts/host-security-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.files = [];
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    let run = spawnSync('git', ['add', 'infra/contracts/host-security-contract.json'], { cwd: source, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'empty host contract'], { cwd: source, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim();
    assert.throws(() => packageBundle(base, sha, source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects an untracked origin hidden by ignore rules', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-ignored-origin-'));
  try {
    const source = cloneSource(base);
    const contractPath = join(source, 'infra/contracts/host-security-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.files.push({
      id: 'ignored-origin',
      source: 'infra/php/ignored-host-setting.ini',
      target: '/etc/am2/php/ignored-host-setting.ini',
      mode: '0644',
      consumer: 'php-sapi',
    });
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    writeFileSync(join(source, 'infra/php/ignored-host-setting.ini'), 'ignored\n');
    appendFileSync(join(source, '.git/info/exclude'), '\ninfra/php/ignored-host-setting.ini\n');
    const commit = spawnSync('git', ['add', contractPath], { cwd: source, encoding: 'utf8' });
    assert.equal(commit.status, 0, `${commit.stdout}\n${commit.stderr}`);
    const saved = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'contract references ignored origin'], { cwd: source, encoding: 'utf8' });
    assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
    assert.throws(() => packageBundle(base, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim(), source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects tracked source hidden by assume-unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-assume-unchanged-'));
  try {
    const source = cloneSource(base);
    const target = 'infra/php/webadmin-prepend.php';
    const mark = spawnSync('git', ['update-index', '--assume-unchanged', target], { cwd: source, encoding: 'utf8' });
    assert.equal(mark.status, 0, `${mark.stdout}\n${mark.stderr}`);
    appendFileSync(join(source, target), '\n// hidden by assume-unchanged\n');
    assert.throws(() => packageBundle(base, sourceSha(), source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager rejects tracked source hidden by skip-worktree', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-skip-worktree-'));
  try {
    const source = cloneSource(base);
    const target = 'infra/php/webadmin-prepend.php';
    const mark = spawnSync('git', ['update-index', '--skip-worktree', target], { cwd: source, encoding: 'utf8' });
    assert.equal(mark.status, 0, `${mark.stdout}\n${mark.stderr}`);
    appendFileSync(join(source, target), '\n// hidden by skip-worktree\n');
    assert.throws(() => packageBundle(base, sourceSha(), source), /!== 0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security packager seals exact Git tree bytes despite post-cleanliness worktree mutation', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-tree-bytes-'));
  try {
    const source = cloneSource(base);
    const target = join(source, 'infra/php/webadmin-prepend.php');
    const contractTarget = join(source, 'infra/contracts/host-security-contract.json');
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    const marker = join(base, 'mutated');
    writeFileSync(wrapper, `#!/usr/bin/env bash
set -euo pipefail
"$AM2_REAL_GIT" "$@"
status=$?
case " $* " in
  *" diff --cached --quiet "*)
    if [[ $status -eq 0 && ! -e $AM2_MUTATION_MARKER ]]; then
      printf '\\n// worktree race\\n' >> "$AM2_MUTATION_TARGET"
      printf '\\n ' >> "$AM2_MUTATION_CONTRACT"
      : > "$AM2_MUTATION_MARKER"
    fi
    ;;
esac
exit "$status"
`);
    const chmod = spawnSync('chmod', ['0755', wrapper], { encoding: 'utf8' });
    assert.equal(chmod.status, 0, `${chmod.stdout}\n${chmod.stderr}`);
    const realGit = spawnSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' });
    assert.equal(realGit.status, 0, realGit.stderr);
    const output = packageBundle(base, sourceSha(), source, {
      PATH: `${bin}:${process.env.PATH}`,
      AM2_REAL_GIT: realGit.stdout.trim(),
      AM2_MUTATION_TARGET: target,
      AM2_MUTATION_CONTRACT: contractTarget,
      AM2_MUTATION_MARKER: marker,
    });
    assert.ok(existsSync(marker), 'test wrapper did not mutate after the cleanliness check');
    const payload = join(base, 'payload');
    mkdirSync(payload);
    const extract = spawnSync('tar', ['-xzf', join(output, 'am2-host-security.tar.gz'), '-C', payload], { encoding: 'utf8' });
    assert.equal(extract.status, 0, `${extract.stdout}\n${extract.stderr}`);
    assert.doesNotMatch(readFileSync(join(payload, 'infra/php/webadmin-prepend.php'), 'utf8'), /worktree race/);
    assert.doesNotMatch(readFileSync(join(payload, 'infra/contracts/host-security-contract.json'), 'utf8'), /\n $/m);
    assert.match(readFileSync(target, 'utf8'), /worktree race/);
    assert.match(readFileSync(contractTarget, 'utf8'), /\n $/m);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects its bundle manifest as the trust anchor', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-self-anchor-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const manifest = join(output, 'host-security-manifest.json');
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', manifest,
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', manifest], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'bundle manifest was accepted as its own trust anchor');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects an expected manifest stored beside the bundle', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-co-located-anchor-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const expected = join(output, 'expected-manifest.json');
    writeFileSync(expected, readFileSync(join(output, 'host-security-manifest.json')));
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', expected], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'bundle-adjacent expected manifest was accepted as trusted provenance');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects a bundle-adjacent expected manifest through a symlinked bundle path', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-symlinked-anchor-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const expected = join(output, 'expected-manifest.json');
    writeFileSync(expected, readFileSync(join(output, 'host-security-manifest.json')));
    const linked = join(base, 'linked-bundle');
    symlinkSync(output, linked, 'dir');
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(linked, 'am2-host-security.tar.gz'),
      '--manifest', join(linked, 'host-security-manifest.json'),
      '--checksums', join(linked, 'SHA256SUMS'),
      '--expected-manifest', join(linked, 'expected-manifest.json')], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'symlinked bundle accepted a bundle-adjacent trust anchor');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects a nested bundle-manifest trust anchor', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-nested-anchor-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const trustedDir = join(output, 'trusted');
    mkdirSync(trustedDir);
    const expected = join(trustedDir, 'expected-manifest.json');
    writeFileSync(expected, readFileSync(join(output, 'host-security-manifest.json')));
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', expected], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'nested bundle manifest was accepted as trusted provenance');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects a hard-linked bundle-manifest trust anchor', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-hardlink-anchor-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const expected = join(base, 'hard-linked-manifest.json');
    linkSync(join(output, 'host-security-manifest.json'), expected);
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', expected], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'hard-linked bundle manifest was accepted as trusted provenance');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier requires an independent trusted manifest', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-trust-anchor-'));
  try {
    const source = cleanSource(base);
    const output = packageBundle(base, sourceSha(), source);
    const archive = join(output, 'am2-host-security.tar.gz');
    const manifestPath = join(output, 'host-security-manifest.json');
    const checksums = join(output, 'SHA256SUMS');
    const trusted = trustedManifest(base, output);

    const payload = join(base, 'payload');
    mkdirSync(payload);
    let run = spawnSync('tar', ['-xzf', archive, '-C', payload], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const changed = join(payload, 'infra/php/webadmin-prepend.php');
    appendFileSync(changed, '\n// forged bundle payload\n');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files.find((file) => file.origin === 'infra/php/webadmin-prepend.php').sha256 = sha256(changed);
    run = spawnSync('tar', [
      '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner',
      '-C', payload, '-cf', '-', '.'], { encoding: null });
    assert.equal(run.status, 0, run.stderr.toString());
    manifest.payload_sha256 = createHash('sha256').update(run.stdout).digest('hex');
    run = spawnSync('tar', [
      '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner',
      '-C', payload, '-czf', archive, '.'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    manifest.archive_sha256 = sha256(archive);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(checksums, `${sha256(archive)}  am2-host-security.tar.gz\n${sha256(manifestPath)}  host-security-manifest.json\n`);

    const withoutAnchor = spawnSync('bash', [verifierPath,
      '--archive', archive,
      '--manifest', manifestPath,
      '--checksums', checksums], { encoding: 'utf8' });
    assert.notEqual(withoutAnchor.status, 0, 'unanchored host-security verification unexpectedly accepted forged bytes');

    const withAnchor = spawnSync('bash', [verifierPath,
      '--archive', archive,
      '--manifest', manifestPath,
      '--checksums', checksums,
      '--expected-manifest', trusted], { encoding: 'utf8' });
    assert.notEqual(withAnchor.status, 0, 'forged host-security metadata matched trusted provenance');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier requires checksums for the complete canonical bundle', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-checksums-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const archive = join(output, 'am2-host-security.tar.gz');
    const checksums = join(output, 'SHA256SUMS');
    writeFileSync(checksums, `${sha256(archive)}  am2-host-security.tar.gz\n`);

    const verify = spawnSync('bash', [verifierPath,
      '--archive', archive,
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', checksums,
      '--expected-manifest', trustedManifest(base, output)], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'incomplete checksum set retained trusted bundle status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects checksum entries outside the canonical bundle set', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-extra-checksum-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const external = join(base, 'external-input');
    writeFileSync(external, 'external\n');
    appendFileSync(join(output, 'SHA256SUMS'), `${sha256(external)}  ${external}\n`);
    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', trustedManifest(base, output)], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'verifier accepted a checksum entry outside the canonical bundle set');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects altered bundle bytes even when the manifest is unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-archive-tamper-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const trusted = trustedManifest(base, output);
    appendFileSync(join(output, 'am2-host-security.tar.gz'), 'tampered');

    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', join(output, 'host-security-manifest.json'),
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', trusted], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'altered host-security archive retained trusted bundle status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('host-security verifier rejects altered manifest provenance', () => {
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-tamper-'));
  try {
    const output = packageBundle(base, sourceSha(), cleanSource(base));
    const trusted = trustedManifest(base, output);
    const manifestPath = join(output, 'host-security-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.source_sha = '0'.repeat(40);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const verify = spawnSync('bash', [verifierPath,
      '--archive', join(output, 'am2-host-security.tar.gz'),
      '--manifest', manifestPath,
      '--checksums', join(output, 'SHA256SUMS'),
      '--expected-manifest', trusted], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'altered manifest retained trusted bundle status');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
