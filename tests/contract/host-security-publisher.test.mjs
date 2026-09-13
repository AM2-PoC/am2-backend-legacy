/**
 * The host-security bundle is built in ephemeral CI, never on the runtime host.
 *
 * The release boundary asks for an exact reviewed source SHA, a deterministic
 * bundle, and an expected manifest that reaches the host through a channel
 * independent of the bundle. The packager and verifier existed, but nothing
 * ran them off-host, so the only way to ship an nginx or Apache change was to
 * assemble the bundle on the production VPS -- which CONTRIBUTING.md forbids
 * and which leaves the bundle and its "trusted" manifest with one origin.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github/workflows/publish-host-security-bundle.yml');

const workflow = () => {
    assert.ok(existsSync(WORKFLOW), 'no CI workflow builds the host-security bundle');
    return readFileSync(WORKFLOW, 'utf8');
};
// YAML comments explain intent and may name what the file must not contain.
const code = () => workflow().replace(/^\s*#.*$/gm, '');

test('host-security bundle publication is an explicit exact-SHA operator action', () => {
    const source = code();
    assert.match(source, /workflow_dispatch:/, 'publication is not an explicit operator action');
    assert.match(source, /source_sha:/, 'publication does not take an exact source SHA');
    assert.doesNotMatch(source,
        /^\s*(push|pull_request|pull_request_target|workflow_run|workflow_call|repository_dispatch|schedule):/m,
        'publication would run without an operator choosing a SHA');
    assert.match(source, /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*read/,
        'publication is not limited to read permissions');
    assert.doesNotMatch(source, /:\s*write\b/, 'publication grants a write permission');
    assert.match(source, /concurrency:/, 'two runs can publish competing bundles for one SHA');
    assert.doesNotMatch(source, /\bsecrets\b/, 'the bundle build needs no secret and must not receive one');
    // A branch that edits this workflow could be dispatched instead; the run
    // itself refuses any ref but main, and the how-to checks the run's branch.
    assert.match(source, /GITHUB_REF[^\n]*refs\/heads\/main/, 'a non-main version of this workflow could publish');
});

test('host-security bundle is built only from reviewed main with passing source checks', () => {
    const source = workflow();
    assert.match(source, /actions\/checkout@[0-9a-f]{40}/, 'checkout is not pinned to an immutable revision');
    assert.match(source, /ref:\s*\$\{\{\s*inputs\.source_sha\s*\}\}/, 'checkout is not the requested SHA');
    assert.match(source, /merge-base --is-ancestor "\$SOURCE_SHA" origin\/main/,
        'a SHA outside main could be packaged');
    assert.match(source, /actions\/workflows\/source-checks\.yml\/runs/,
        'no evidence the source checks passed for this SHA');
    assert.match(source, /conclusion == "success"/, 'a SHA with failing checks could be packaged');
    // A pull_request run reports the PR branch as head_branch and tests a merge
    // ref, so only a push run on main is evidence about the SHA on main.
    assert.match(source, /source-checks\.yml\/runs\?[^"]*event=push/,
        'a pull-request run could stand in for checks on main');
    assert.match(source, /head_branch == "main"/, 'checks from another branch could be accepted');
});

test('host-security bundle is packaged, verified, and handed off with its identity', () => {
    const source = workflow();
    assert.match(source, /infra\/scripts\/package-host-security-bundle\.sh/,
        'the workflow does not use the sealed packager');
    assert.match(source, /infra\/scripts\/verify-host-security-bundle\.sh/,
        'the workflow publishes a bundle it did not verify');
    assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/, 'upload is not pinned');
    assert.match(source, /retention-days:\s*\d+/, 'handoff retention is unbounded');
    assert.match(source, /am2-host-security\.tar\.gz[\s\S]{0,300}host-security-manifest\.json[\s\S]{0,300}SHA256SUMS/,
        'the handoff omits the bundle, its manifest, or its checksums');
    // The run summary is the independent channel: the operator compares the
    // downloaded manifest against the digest GitHub recorded for this run.
    assert.match(source, /GITHUB_STEP_SUMMARY/, 'the run records no identity for the operator to check');
    assert.match(source, /sha256sum[^\n]*host-security-manifest\.json/,
        'the run does not record the manifest digest');
});
