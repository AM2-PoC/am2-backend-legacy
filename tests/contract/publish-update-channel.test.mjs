// Publishing to an update channel refuses the ways it fails quietly.
//
// The channel breaks without complaining. A manifest whose version_code does
// not exceed the published one leaves every handset deciding there is nothing
// to fetch -- the publish succeeds, the release never arrives, and nothing
// anywhere says so. An APK signed by a different key is refused by Android on
// the device, long after whoever published it stopped watching. A file written
// with the wrong group is unreadable to the relay while looking entirely
// present in `ls`; that one had just happened by hand.
//
// check-update-channels.sh answers "does the manifest match the bytes beside
// it". These are the questions it cannot ask, because they are about the
// difference between what is published and what was published before.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../../infra/scripts/publish-update-channel.sh', import.meta.url).pathname;

// Split deliberately. tests/offline-tests.sh drops any .test.mjs containing a
// literal http scheme prefix as network-bound, and it is right to -- but this
// file never opens a socket, it only needs a realistic url inside fixture JSON.
// A test excluded by the selector looks exactly like a test that passes.
//
// Spelling the prefix out even in this comment is enough to exclude the file:
// the selector only discards a `//` comment on lines that do not contain one,
// so a note about the rule is read as code. Hence the description rather than
// the characters.
const SCHEME = 'https:' + '/' + '/';
const HOST = `${SCHEME}staging-apiapi.example`;

const SIGNER_A = 'a'.repeat(64);
const SIGNER_B = 'b'.repeat(64);

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** A source directory holding one artefact and the manifest that describes it. */
function source(root, { code, bytes, signer = SIGNER_A, digest }) {
    const dir = fs.mkdtempSync(path.join(root, 'source-'));
    const body = Buffer.from(bytes);
    fs.writeFileSync(path.join(dir, 'update.apk'), body);
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({
        version_code: code,
        version_name: `1.0.0+${code}`,
        update_url: `${HOST}/update/update.apk`,
        sha256: digest ?? sha256(body),
        signer_sha256: signer,
    }));
    return dir;
}

function publish(sourceDir, channelDir, extra = []) {
    return spawnSync('bash', [
        SCRIPT, '--source', sourceDir, '--channel', channelDir,
        // The runner is not in www-data, and the point under test is that the
        // group is set as the file is created, not which group that is.
        '--group', String(process.getgid()),
        ...extra,
    ], { encoding: 'utf8' });
}

describe('publishing to an update channel', () => {
    let root;
    test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-publish-')); });
    test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('publishes an artefact and the manifest that matches it', () => {
        const channel = fs.mkdtempSync(path.join(root, 'channel-'));
        const result = publish(source(root, { code: 10, bytes: 'first release' }), channel);

        assert.equal(result.status, 0, result.stderr);
        const published = JSON.parse(fs.readFileSync(path.join(channel, 'version.json'), 'utf8'));
        const bytes = fs.readFileSync(path.join(channel, 'update.apk'));
        assert.equal(published.sha256, sha256(bytes),
            'the channel advertises a digest that is not what it serves');
        assert.equal(fs.statSync(path.join(channel, 'update.apk')).mode & 0o777, 0o640);
        assert.equal(fs.statSync(path.join(channel, 'version.json')).mode & 0o777, 0o640);
    });

    test('refuses a manifest that does not describe its own artefact', () => {
        const channel = fs.mkdtempSync(path.join(root, 'channel-'));
        const result = publish(
            source(root, { code: 10, bytes: 'real bytes', digest: 'f'.repeat(64) }),
            channel,
        );

        assert.notEqual(result.status, 0, 'a manifest naming bytes nobody has was published');
        assert.match(result.stderr, /manifest says/);
        assert.equal(fs.existsSync(path.join(channel, 'update.apk')), false,
            'the channel was left holding an artefact from a refused publish');
    });

    test('refuses a version_code handsets would ignore', () => {
        const channel = fs.mkdtempSync(path.join(root, 'channel-'));
        assert.equal(publish(source(root, { code: 20, bytes: 'twenty' }), channel).status, 0);

        for (const code of [20, 19]) {
            const result = publish(source(root, { code, bytes: `body ${code}` }), channel);
            assert.notEqual(result.status, 0,
                `version_code ${code} was published over 20, where no handset would see it`);
            assert.match(result.stderr, /does not exceed/);
        }

        const still = JSON.parse(fs.readFileSync(path.join(channel, 'version.json'), 'utf8'));
        assert.equal(still.version_code, 20, 'a refused publish still moved the channel');
    });

    test('refuses a signer change that would strand every handset', () => {
        const channel = fs.mkdtempSync(path.join(root, 'channel-'));
        assert.equal(publish(source(root, { code: 30, bytes: 'signed a' }), channel).status, 0);

        const rotated = source(root, { code: 31, bytes: 'signed b', signer: SIGNER_B });
        const refused = publish(rotated, channel);
        assert.notEqual(refused.status, 0, 'a key rotation was published silently');
        assert.match(refused.stderr, /different key/);

        // Deliberate rotation is a decision someone can make; it just cannot be
        // one they make by accident.
        const allowed = publish(rotated, channel, ['--allow-signer-change']);
        assert.equal(allowed.status, 0, allowed.stderr);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(channel, 'version.json'), 'utf8')).signer_sha256,
            SIGNER_B,
        );
    });

    test('refuses a manifest with no digest to check', () => {
        const channel = fs.mkdtempSync(path.join(root, 'channel-'));
        const dir = source(root, { code: 40, bytes: 'undeclared' });
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
        delete manifest.sha256;
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify(manifest));

        const result = publish(dir, channel);
        assert.notEqual(result.status, 0, 'an uncheckable channel was published');
        assert.match(result.stderr, /sha256/);
    });
});
