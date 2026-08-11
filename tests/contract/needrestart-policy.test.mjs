import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const policyPath = resolve(root, 'infra/needrestart/am2-realtime.conf');

function readPolicy() {
  return readFileSync(policyPath, 'utf8');
}

test('needrestart policy defers only exact AM2 realtime service names', () => {
  const policy = readPolicy();
  assert.match(policy, /override_rc.*qr\(\^am2-api\\\.service\$\).*0/);
  assert.match(policy, /override_rc.*qr\(\^am2-api-staging\\\.service\$\).*0/);
  assert.doesNotMatch(policy, /qr\(\^am2(?!(?:-api(?:-staging)?\\\.service\$))/);
  assert.doesNotMatch(policy, /blacklist_rc/);
});

test('needrestart policy is valid Perl and sets both exact overrides to false', () => {
  const syntax = spawnSync('perl', ['-c', policyPath], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const evaluator = String.raw`
    our %nrconf = (override_rc => {});
    do $ARGV[0] or die($@ || $!);
    my %expected = (
      'am2-api.service' => 0,
      'am2-api-staging.service' => 0,
      'am2-api-extra.service' => 1,
      'not-am2-api.service' => 1,
    );
    for my $service (sort keys %expected) {
      my $restart = 1;
      for my $re (keys %{$nrconf{override_rc}}) {
        if ($service =~ /$re/) {
          $restart = $nrconf{override_rc}->{$re};
          last;
        }
      }
      die "$service=$restart\n" unless $restart == $expected{$service};
    }
  `;
  const evaluation = spawnSync('perl', ['-e', evaluator, policyPath], { encoding: 'utf8' });
  assert.equal(evaluation.status, 0, evaluation.stderr);
});
