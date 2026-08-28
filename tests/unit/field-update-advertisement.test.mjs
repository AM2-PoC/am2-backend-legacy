// Do not offer a handset something that is not there.
//
// The field channel is a manifest and the APK it names. When the panel and the
// relay stopped reading a stale database table and started reading that
// manifest, production began answering `success: true` for build 1 -- a
// manifest written in May, naming an APK that has never been in the directory.
// Before the change it answered "No version info found", which was at least
// true.
//
// A handset told about a build it cannot download gets a failed fetch and no
// explanation. The admin channel has refused this since its validator landed:
// the published URL has to resolve to a real regular file below the update
// directory. This is the same rule for the other channel.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { fieldUpdate } = createRequire(import.meta.url)('../../server/lib/field-update.js');

/** An update directory in whatever state we want to describe. */
function channel({ manifest = {}, apk = 'update.apk' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-channel-'));
    if (manifest !== null) {
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({
            version_code: 124,
            version_name: '1.1.0-staging+124',
            update_url: 'https://staging-apiapi.am2-poc.com/update/update.apk',
            sha256: 'a'.repeat(64),
            signer_sha256: 'b'.repeat(64),
            changelog: 'a build',
            ...manifest,
        }));
    }
    if (apk) fs.writeFileSync(path.join(dir, apk), 'apk bytes');
    return dir;
}

const run = (dir) => { try { return fieldUpdate(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };

describe('what the field channel may advertise', () => {
    test('a published build with its APK beside it', () => {
        const verdict = run(channel());
        assert.equal(verdict.valid, true, verdict.reason);
        assert.equal(verdict.manifest.version_code, 124);
    });

    test('refuses a manifest naming an APK that is not there', () => {
        // Exactly production: a manifest from May naming update.apk, and an
        // empty directory beside it.
        const verdict = run(channel({ apk: null }));
        assert.equal(verdict.valid, false);
        assert.match(verdict.reason, /apk|file|there/i);
    });

    test('refuses a manifest that names no download at all', () => {
        const verdict = run(channel({ manifest: { update_url: '' } }));
        assert.equal(verdict.valid, false);
    });

    test('refuses a download URL that points outside the update directory', () => {
        // The name is taken from a file on disk, so a path in it is a path this
        // would otherwise follow.
        const verdict = run(channel({ manifest: { update_url: 'https://x/update/../../etc/passwd' } }));
        assert.equal(verdict.valid, false);
    });

    test('refuses a manifest with no build to compare', () => {
        const verdict = run(channel({ manifest: { version_code: null } }));
        assert.equal(verdict.valid, false);
    });

    test('an empty channel is refused, not crashed on', () => {
        const verdict = run(channel({ manifest: null, apk: null }));
        assert.equal(verdict.valid, false);
        assert.match(verdict.reason, /manifest/i);
    });
});
