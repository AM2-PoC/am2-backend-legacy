import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const smoke = resolve(root, 'infra/scripts/smoke-release.sh');

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'am2-smoke-fixture-'));
  const release = join(dir, 'release');
  const server = join(release, 'server');
  spawnSync('mkdir', ['-p', server]);
  writeFileSync(join(release, '.release-sha'), `${'a'.repeat(40)}\n`);
  writeFileSync(join(server, 'server.js'), `
const http = require('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('PTT Server smoke fixture');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGINT', () => server.close(() => process.exit(0)));
`);
  chmodSync(join(server, 'server.js'), 0o755);
  const env = join(dir, 'smoke.env');
  writeFileSync(env, 'SMOKE_SENTINEL=[REDACTED]\n');
  return { dir, release, env };
}

test('smoke runner requires an explicit protected environment file', () => {
  const fixture = makeFixture();
  try {
    const run = spawnSync('bash', [smoke, fixture.release, 'a'.repeat(40)], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /env|usage/i);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('smoke runner cold-starts exact release on loopback and leaves no child', () => {
  const fixture = makeFixture();
  try {
    const before = spawnSync('pgrep', ['-f', join(fixture.release, 'server/server.js')], { encoding: 'utf8' });
    assert.notEqual(before.status, 0, before.stdout);

    const run = spawnSync('bash', [smoke, fixture.release, 'a'.repeat(40), fixture.env], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /smoke.*OK|OK.*smoke/i);
    assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /SMOKE_SENTINEL|\[REDACTED\]/);

    const after = spawnSync('pgrep', ['-f', join(fixture.release, 'server/server.js')], { encoding: 'utf8' });
    assert.notEqual(after.status, 0, after.stdout);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('smoke runner rejects marker mismatch without starting relay', () => {
  const fixture = makeFixture();
  try {
    const run = spawnSync('bash', [smoke, fixture.release, 'b'.repeat(40), fixture.env], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /marker|mismatch/i);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
