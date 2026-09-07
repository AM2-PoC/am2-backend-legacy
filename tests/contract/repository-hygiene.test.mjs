import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function trackedPaths() {
  const run = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\0').filter(Boolean);
}

test('local assistant workspaces and internal planning directories are never tracked', () => {
  const forbidden = /(?:^|\/)(?:\.codex|\.claude|\.superpowers|\.hermes)(?:\/|$)|^docs\/(?:ai|prompts|plans|superpowers|hermes)(?:\/|$)/;
  const offenders = trackedPaths().filter((path) => forbidden.test(path));

  assert.deepEqual(
    offenders,
    [],
    `local workspace or internal planning files are tracked:\n${offenders.join('\n')}`,
  );
});
