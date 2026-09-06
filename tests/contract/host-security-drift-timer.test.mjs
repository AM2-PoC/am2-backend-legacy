import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const servicePath = resolve(ROOT, 'infra/systemd/am2-host-security-drift.service');
const timerPath = resolve(ROOT, 'infra/systemd/am2-host-security-drift.timer');
const packagerPath = resolve(ROOT, 'infra/scripts/package-host-security-bundle.sh');
const materializerPath = resolve(ROOT, 'infra/scripts/materialize-host-security.sh');

function discard(base) {
  spawnSync('chmod', ['-R', 'u+w', base]);
  rmSync(base, { recursive: true, force: true });
}

function sealedBundle(base) {
  const source = join(base, 'source');
  assert.equal(spawnSync('git', ['clone', '--shared', ROOT, source], { encoding: 'utf8' }).status, 0);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const output = join(base, 'bundle');
  const pack = spawnSync('bash', [packagerPath, '--source-root', source, '--sha', sha,
    '--output-dir', output], { encoding: 'utf8' });
  assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
  const expected = join(base, 'trusted.json');
  writeFileSync(expected, readFileSync(join(output, 'host-security-manifest.json')));
  return {
    archive: join(output, 'am2-host-security.tar.gz'),
    manifest: join(output, 'host-security-manifest.json'),
    checksums: join(output, 'SHA256SUMS'),
    expected,
  };
}

function materializedReceipt(bundle, base) {
  const receipt = join(base, 'receipt.json');
  const run = spawnSync('bash', [materializerPath,
    '--archive', bundle.archive, '--manifest', bundle.manifest, '--checksums', bundle.checksums,
    '--expected-manifest', bundle.expected, '--store-root', join(base, 'store'),
    '--receipt', receipt, '--unprivileged-store'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return { receipt, receiptData: JSON.parse(readFileSync(receipt, 'utf8')) };
}

function installFromReceipt(receiptData, fakeRoot) {
  const payloadRoot = join(receiptData.store_path, 'payload');
  for (const file of receiptData.files) {
    const targets = file.target ? [file.target]
      : file.sapis.map((sapi) => `/etc/php/8.3/${sapi}/conf.d/${file.filename}`);
    for (const target of targets) {
      const destination = join(fakeRoot, target);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(payloadRoot, file.origin)));
      chmodSync(destination, 0o644);
    }
  }
  return fakeRoot;
}

test('the host-security drift audit runs periodically and only ever reads', () => {
  assert.ok(existsSync(servicePath), 'missing host-security drift audit service unit');
  assert.ok(existsSync(timerPath), 'missing host-security drift audit timer unit');
  const service = readFileSync(servicePath, 'utf8');
  const timer = readFileSync(timerPath, 'utf8');
  // Directives only: the unit is allowed to explain in comments what it
  // deliberately does not do.
  const directives = service.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  // systemd continues a directive across lines with a trailing backslash.
  const joined = directives.replace(/\\\n\s*/g, ' ');

  assert.match(joined, /^ExecStart=.*audit-host-security-drift\.sh .*--receipt /m,
    'the service unit does not run the drift audit against a receipt');

  // Without the independently obtained manifest the audit refuses on a real
  // host, so a timer that omits it fails every day and inverts the whole
  // "silence means healthy" contract into permanent noise.
  assert.match(joined, /^ExecStart=.*--expected-manifest \/\S+/m,
    'the timer would run the audit with nothing independent to check against');
  assert.match(service, /^Type=oneshot$/m);

  // Quiet on success: a timer that mails something every day trains everybody
  // to skim past it, and the one run that mattered scrolls by with the rest.
  assert.match(service, /^StandardOutput=null$/m);

  // An auditor that can also change things is one whose findings nobody has to
  // take seriously. It must not activate, reload or restart anything.
  assert.doesNotMatch(directives, /systemctl|apache2ctl|nginx -t|reload|restart|ExecStartPre|ExecStartPost/,
    'the drift audit unit may not activate or reload anything');
  assert.match(service, /^ProtectSystem=strict$/m, 'the drift audit is not confined to reading');
  assert.match(service, /^NoNewPrivileges=yes$/m);

  assert.match(timer, /^OnCalendar=/m, 'the timer never fires');
  assert.match(timer, /^Persistent=true$/m,
    'a missed audit must run after boot rather than being skipped');
  assert.match(timer, /^Unit=am2-host-security-drift\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test('the timer command actually runs in the layout it names', () => {
  // Asserting on the text of a unit file proves the string is present, not that
  // the command works. The verifier resolves its contracts relative to its own
  // directory, so an ExecStart that points into a bin/ directory fails on every
  // run unless that layout exists or the paths are passed explicitly -- and a
  // regex test cannot see that at all.
  //
  // So: build the layout the unit names, and run exactly what it runs.
  const base = mkdtempSync(join(tmpdir(), 'am2-host-security-unitlayout-'));
  try {
    const bundle = sealedBundle(base);
    const { receipt, receiptData } = materializedReceipt(bundle, base);
    const installed = installFromReceipt(receiptData, join(base, 'root'));

    const prefix = join(base, 'host-security');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(join(prefix, 'contracts'), { recursive: true });
    for (const script of ['audit-host-security-drift.sh', 'verify-host-security-installed.sh']) {
      const to = join(prefix, 'bin', script);
      writeFileSync(to, readFileSync(resolve(ROOT, 'infra/scripts', script)));
      chmodSync(to, 0o755);
    }
    // The contracts the unit names, placed where it names them. If the layout
    // the how-to describes is wrong, this is where it shows up.
    writeFileSync(join(prefix, 'contracts/cloudflare-realip-lifecycle.json'),
      readFileSync(resolve(ROOT, 'infra/contracts/cloudflare-realip-lifecycle.json')));

    const service = readFileSync(resolve(ROOT, 'infra/systemd/am2-host-security-drift.service'), 'utf8');
    const execStart = service
      .split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
      .replace(/\\\n\s*/g, ' ')
      .split('\n').find((line) => line.startsWith('ExecStart='));
    assert.ok(execStart, 'the unit declares no ExecStart');

    // Point every /etc path the unit names at this fixture instead.
    const argv = execStart.slice('ExecStart='.length).trim().split(/\s+/).map((token) => token
      .replace('/etc/am2/host-security/receipt.json', receipt)
      .replace('/etc/am2/host-security/trusted-host-security-manifest.json', bundle.expected)
      .replace('/etc/am2/host-security', prefix));

    const run = spawnSync('bash', [...argv, '--root', installed, '--unprivileged-root'],
      { encoding: 'utf8' });
    assert.equal(run.status, 0,
      `the command the timer runs fails in the layout the unit names\n${run.stdout}\n${run.stderr}`);
    assert.equal(run.stderr, '', 'a healthy audit must stay quiet');
  } finally {
    discard(base);
  }
});
