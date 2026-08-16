/**
 * Nothing in the panel writes into the update folder.
 *
 * The settings page accepted an .apk upload and moved it straight into
 * `update/`, which Apache serves publicly. The extension was the only check —
 * the bytes were never examined — and the filename came from the request, so a
 * signed-in superadmin could publish any content at a predictable URL on the
 * production hostname.
 *
 * `admin_version.json` already announced `webadmin.am2-poc.com/update/admin.apk`
 * (written here without a scheme on purpose: the offline selector treats a URL
 * as a sign the file talks to the network, and would skip this test silently).
 * That file had never existed, so uploading one under that exact name was
 * enough to become the update every admin device is offered.
 *
 * Releases are published by the release pipeline from bytes signed on an
 * isolated runner. The panel was never part of that path, so the upload was an
 * unused write surface, and this pins it closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEBADMIN = join(ROOT, 'WebAdmin');

/**
 * PHP with comment lines dropped: prose describing a feature is not the
 * feature, and prose describing a guard is not a guard.
 *
 * Done line by line rather than by matching comment delimiters, because this
 * source contains `glob($dir . '/*.apk')` — a `/*` inside a string literal,
 * which opens a comment that a delimiter match then closes thousands of
 * characters later, swallowing real code and quietly passing every assertion
 * made about it.
 */
const code = (name) => readFileSync(join(WEBADMIN, name), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|#|\*|\/\*)/.test(line))
    .join('\n');

const phpFiles = () => readdirSync(WEBADMIN).filter((name) => name.endsWith('.php'));

test('the panel never lands an upload anywhere on disk', () => {
    // The APK upload was the only move_uploaded_file in the panel. The import
    // reads its temporary file in place and never keeps it, so the honest
    // invariant is that nothing here writes an uploaded file at all — checked
    // by absence, which cannot be satisfied by a variable holding the path.
    for (const name of phpFiles()) {
        assert.doesNotMatch(code(name), /move_uploaded_file/,
            `${name} writes an uploaded file to disk`);
    }
});

test('the apk upload handler and its form are gone', () => {
    const settings = code('settings.php');
    for (const token of ['upload_apk', 'apk_file', 'am2-apk-form', 'am2-apk-zone']) {
        assert.ok(!settings.includes(token), `settings.php still carries ${token}`);
    }
});

test('the panel creates no directories in the web root', () => {
    // update/ is a symlink to shared storage. The upload handler's mkdir would
    // replace it with a real directory whenever the link was missing, quietly
    // splitting the channel in two. Nothing in the panel needs to create a
    // directory, so this is checked by absence too.
    for (const name of phpFiles()) {
        assert.doesNotMatch(code(name), /\bmkdir\s*\(/,
            `${name} creates a directory in the web root`);
    }
});

test('the update channel is runtime state, not something the repository ships', () => {
    // What is announced lives in shared storage and is written by the release
    // pipeline. A manifest committed here would be a second source of truth
    // that deploys over whatever is actually published.
    const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    assert.match(ignored, /^WebAdmin\/update$/m, 'the update folder is not held outside the tree');
});

test('the database import still validates its upload', () => {
    // The import path stays: it is used, and removing the APK upload must not
    // take its guard with it.
    const settings = code('settings.php');
    assert.match(settings, /is_uploaded_file/, 'the import no longer checks for a real upload');
    assert.match(settings, /am2_upload_error/, 'the import no longer reports why an upload failed');
});
