/* Artifact-only delivery boundary: first tracer bullet (Task 1). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(ROOT, '.github/workflows/publish-backend-artifact.yml');

test('CI publishes a checksumed backend runtime artifact', () => {
  assert.ok(existsSync(workflowPath), 'no CI runtime-artifact publisher exists');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /upload-artifact|gh\s+release\s+upload|oras\s+push|\bscp\b|\brsync\b/i,
    'CI does not hand its runtime artifact to a retained artifact channel');
  assert.match(workflow, /SHA256SUMS|sha256sum/i,
    'CI does not record a checksum for its runtime artifact');
  assert.match(workflow, /artifact-manifest\.json/,
    'CI does not publish artifact provenance');
  assert.match(workflow, /concurrency:/,
    'two CI runs can publish competing bytes into one artifact channel');
  assert.match(workflow, /source_sha|GITHUB_SHA/,
    'CI artifact publication is not bound to its exact source');
});
