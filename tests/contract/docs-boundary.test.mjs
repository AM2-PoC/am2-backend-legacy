import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const runbook = () => read('docs/how-to/deploy-and-roll-back.md');
const boundary = () => read('docs/explanation/release-boundary.md');

test('production runbook deploys immutable artifacts without source or host builds', () => {
  const source = runbook();
  for (const required of [
    'artifact-manifest.json',
    'archive_sha256',
    'verify-runtime-artifact.sh',
    'materialize-runtime-release.sh',
    'smoke-release.sh',
    'promote-to-production.sh',
    'rollback',
  ]) {
    assert.match(source, new RegExp(required.replaceAll('.', '\\.')), `runbook omits ${required}`);
  }
  assert.doesNotMatch(source, /git\s+(?:-C\s+\S+\s+)?(?:clone|fetch|pull)\b/,
    'production runbook still obtains deploy input from Git');
  assert.doesNotMatch(source, /\bnpm\s+(?:--prefix\s+\S+\s+)?(?:ci|install)\b/,
    'production runbook still resolves dependencies on the runtime host');
  assert.doesNotMatch(source, /build-release\.sh/,
    'production runbook still builds a release from source on the runtime host');
});

test('release boundary separates source, artifact, release, and activation identities', () => {
  const source = boundary();
  for (const phrase of [
    'Source identity',
    'Artifact identity',
    'Release identity',
    'Activation identity',
    'same archive digest',
    'rollback never rebuilds',
  ]) {
    assert.match(source, new RegExp(phrase, 'i'), `release boundary omits ${phrase}`);
  }
  assert.match(source, /operator checkout[\s\S]*transitional/i,
    'the temporary operator-checkout exception is undocumented');
  assert.match(source, /deployment[\s\S]*must not[\s\S]*(?:read|use)[\s\S]*operator checkout/i,
    'the operator exception can be mistaken for a deployment input');
});

test('release boundary documents host security as a separate release lifecycle', () => {
  const source = boundary();
  for (const phrase of [
    'Host-security release boundary',
    'host-security-manifest.json',
    'independent trusted channel',
    'materializer',
    'protected receipt',
    'installed-state verifier',
    'Cloudflare real-IP',
  ]) {
    assert.match(source, new RegExp(phrase.replaceAll('.', '\\.'), 'i'),
      `release boundary omits ${phrase}`);
  }
  assert.match(source, /must not be folded into the backend runtime archive/i,
    'host configuration may be mistaken for runtime artifact content');
  assert.match(source, /source contract and deterministic bundle\/verifier[\s\S]*implemented/i,
    'current host-security completion boundary is not recorded');
  assert.match(source, /root-owned materializer, protected receipt, installed-state verifier, and drift audit[\s\S]*implemented/i,
    'the implemented host-security lifecycle is not recorded');
  assert.match(source, /activation, reload, and rollback[\s\S]*not implemented/i,
    'unfinished host-security lifecycle is not recorded');
  assert.match(source, /cloudflare-realip-lifecycle\.json/i,
    'the separate externally-refreshed real-IP lifecycle is not recorded');
});

test('staging documentation uses artifact materialization rather than Git deployment', () => {
  const source = read('docs/how-to/use-the-staging-environment.md');
  for (const required of [
    'materialize-runtime-release.sh',
    'verify-current-release.sh',
    'verify-materialized-artifact.sh',
    'protected staging rehearsal',
  ]) {
    assert.match(source, new RegExp(required.replaceAll('.', '\\.'), 'i'),
      `staging documentation omits ${required}`);
  }
  assert.doesNotMatch(source, /git\s+(?:-C\s+\S+\s+)?(?:clone|fetch|pull|checkout)\b/,
    'staging documentation still deploys code from Git');
  assert.doesNotMatch(source, /reset\s+--hard\s+origin\//,
    'staging documentation still treats an environment branch as deployment input');
  assert.doesNotMatch(source, /sudo\s+\/usr\/local\/libexec\/am2\/(?:verify-current-release|verify-materialized-artifact)\.sh/,
    'staging documentation runs artifact-sensitive verification as root');
  assert.doesNotMatch(source, /before this indirection|hardcoded to|would have disconnected|Restarting .* is free/i,
    'staging documentation still carries incident narrative or unsafe restart minimization');
  assert.match(source, /production receives the exact digest accepted in staging/i,
    'staging documentation does not state the candidate-to-production promotion boundary');
  assert.match(source, /:\s+"\$\{SOURCE_SHA:\?export the exact 40-character source SHA\}"/,
    'staging documentation does not fail closed when SOURCE_SHA is unset');
  assert.match(source, /:\s+"\$\{ARCHIVE_SHA:\?export the exact 64-character archive SHA-256\}"/,
    'staging documentation does not fail closed when ARCHIVE_SHA is unset');
});

test('security posture stays current instead of becoming an incident ledger', () => {
  const source = read('docs/explanation/security-posture.md');
  for (const required of [
    'WebAdmin invariants',
    'Host-security configuration lifecycle',
    'Remaining adjacent risks',
    'protected installation receipt',
    'write ownership',
  ]) {
    assert.match(source, new RegExp(required.replaceAll('.', '\\.'), 'i'),
      `security posture omits ${required}`);
  }
  assert.doesNotMatch(source, /retained window|one unauthenticated POST could|used to explain|closed since this document|fixture account|before this guard existed/i,
    'security posture still carries incident or historical implementation narrative');
  assert.match(source, /API-key validation uses Node's constant-time comparison/i,
    'security posture does not name Node as the API-key validator');
  assert.match(source, /PHP presents the protected key only to the loopback relay and does not compare it itself/i,
    'security posture misstates PHP API-key responsibility');
});
