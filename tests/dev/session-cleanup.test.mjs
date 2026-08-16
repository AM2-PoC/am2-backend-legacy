/**
 * The boundaries of what a development session may delete.
 *
 * These run before any cleanup handler exists, and they stay ahead of it: a
 * handler can only ever act on a manifest that has already passed here. The
 * cost of getting this wrong is not a failed build — it is a deleted checkout,
 * a removed release artifact, or a shared container taken down under someone
 * else's work, so every rule below refuses rather than guesses.
 *
 * Written against the source, with no harness, no daemon and no privileges, so
 * they can run anywhere including a machine that has nothing to clean up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest, cleanupTargets, PATH_TYPES } from '../../infra/dev/session-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'dev-session', 'valid-manifest.json');

const valid = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

/** The manifest with one field changed, so each case differs from the accepted one by exactly that field. */
const withManifest = (patch) => ({ ...valid(), ...patch });
const withResource = (patch) => {
    const manifest = valid();
    manifest.resources = [{ ...manifest.resources[0], ...patch }];
    return manifest;
};

const rejects = (manifest, why) => {
    const result = validateManifest(manifest);
    assert.equal(result.ok, false, `expected refusal: ${why}`);
    assert.ok(result.errors.length > 0, 'a refusal must say what was wrong');
    return result;
};

test('a manifest without a session id is rejected', () => {
    const manifest = valid();
    delete manifest.session_id;
    rejects(manifest, 'ownership is unknowable without it');
});

test('an unknown resource type is rejected', () => {
    rejects(withResource({ type: 'kubernetes_namespace' }),
        'a type this controller does not understand cannot be deleted safely');
});

test('a path outside the session root is rejected', () => {
    for (const outside of ['/tmp/somewhere-else', '/tmp/am2-session-otherzzzz/x', '/opt/am2']) {
        rejects(withResource({ type: 'temp_dir', id: outside }),
            `${outside} was not created by this session`);
    }
});

test('a path that escapes the session root by traversal is rejected', () => {
    const manifest = valid();
    const root = manifest.session_root;
    rejects(withResource({ type: 'temp_dir', id: `${root}/../../etc` }),
        'a prefix match is not containment');
});

test('the canonical repository roots are rejected', () => {
    for (const repo of [
        '/home/am2deploy/am2-main',
        '/home/am2deploy/am2-android-client',
        '/home/am2deploy/am2-android-admin',
    ]) {
        rejects(withResource({ type: 'git_worktree', id: repo }),
            'a canonical checkout is source, not session scratch');
    }
});

test('the machine itself is rejected', () => {
    for (const path of ['/', '/home', '/home/am2deploy', '/var/www', '/etc', '/tmp']) {
        rejects(withResource({ type: 'temp_dir', id: path }),
            `${path} is the host, not a session resource`);
    }
});

test('a resource owned by another session is rejected', () => {
    rejects(withResource({ owner_session: 'someoneelse01' }),
        'the other session is the one entitled to remove it');
});

test('shared runtime resources are rejected even when listed', () => {
    for (const id of ['mailcowdockerized-mysql-mailcow-1', 'am2-api', 'bridge', 'host']) {
        rejects(withResource({ type: 'docker_container', id }),
            `${id} outlives any development session`);
    }
});

test('a manifest carrying anything secret-looking is rejected', () => {
    rejects(withManifest({ resources: [{ ...valid().resources[0], id: '/tmp/am2-session-abcd1234/x', password: 'hunter2' }] }),
        'an unknown field may be a credential and is certainly not understood');
    rejects(withResource({ ownership_proof: 'AKIAIOSFODNN7EXAMPLE' }),
        'a manifest is not a place to carry a key');
});

test('protected retention classes never reach a destructive handler', () => {
    for (const retention of ['release', 'source', 'evidence', 'shared']) {
        const manifest = withResource({ retention });
        const result = validateManifest(manifest);
        assert.equal(result.ok, true, `${retention} is a legal thing to record`);
        assert.deepEqual(cleanupTargets(manifest), [],
            `${retention} must never be offered for deletion`);
    }
});

test('a resource without ownership proof fails rather than being deleted anyway', () => {
    const manifest = valid();
    delete manifest.resources[0].ownership_proof;
    rejects(manifest, 'best-effort deletion is how the wrong thing gets removed');
});

test('a valid temporary fixture is accepted and offered for cleanup', () => {
    const manifest = valid();
    const result = validateManifest(manifest);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(cleanupTargets(manifest).length, manifest.resources.length);
});

test('the schema on disk describes the same shape the validator enforces', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'infra', 'dev', 'session.schema.json'), 'utf8'));
    const types = schema.$defs.resource.properties.type.enum;
    const retentions = schema.$defs.resource.properties.retention.enum;
    // A schema that drifts from the validator documents a boundary nothing enforces.
    for (const type of types) {
        assert.equal(validateManifest(withResource({
            type,
            id: PATH_TYPES.has(type)
                ? `${valid().session_root}/thing`
                : `am2-session-abcd1234-${type}`,
        })).ok, true, `validator rejects ${type}, which the schema allows`);
    }
    assert.deepEqual(retentions, ['disposable', 'release', 'source', 'evidence', 'shared']);
});
