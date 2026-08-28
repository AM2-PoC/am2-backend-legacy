// One channel, one source.
//
// The field app's update channel had two. CI writes server/update/version.json
// beside the APK it just built, with the digest and the signer read back off
// that artifact. A human writes public.app_versions, by hand, with SQL, when
// they remember. On staging the table said build 3 while the published APK was
// build 124.
//
// The question was which one to believe, and the access logs answer it. Across
// every retained nginx log, `/api/check-update` -- the endpoint that serves the
// table -- has been called *zero* times, while `/update/version.json` has been
// fetched by real handsets. AboutActivity reads UPDATE_MANIFEST_URL, and
// nothing in the client calls the relay endpoint at all.
//
// So the table was never the channel. It was a stale mirror that only the panel
// read, which is why the panel was the only thing lying. The fix is not to keep
// two authors in step; it is to stop having two.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SERVER_JS, SRC, NODE_URL, BASE, HOST, asSuper } from './helpers.mjs';

const UPDATE_DIR = path.join(path.dirname(SERVER_JS), 'update');
const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The field channel's section of the distribution card, as rendered. */
async function shelf() {
    const sup = await asSuper();
    const html = await (await fetch(`${BASE}/settings.php`, {
        headers: { Host: HOST, Cookie: sup },
    })).text();
    const SECTION = '<section class="rounded-control border border-edge p-4">';
    const start = html.indexOf('id="am2-shelf-version"');
    const first = html.indexOf(SECTION, start);
    const second = html.indexOf(SECTION, first + SECTION.length);
    assert.ok(second > first, 'the field channel section is not on the page');
    return html.slice(second, second + 3000);
}

/** The manifest CI wrote beside the APK, which is what a handset fetches. */
function published() {
    try {
        return JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'version.json'), 'utf8'));
    } catch {
        return null;
    }
}

describe('the field update channel', () => {
    test('the panel shows the build a handset would actually fetch', () => {
        if (published() === null) {
            return; // nothing published on this host
        }
        const settings = fs.readFileSync(path.join(SRC, 'settings.php'), 'utf8');
        const channel = settings.slice(settings.indexOf('function am2_field_channel'));
        const body = channel.slice(0, channel.indexOf('\n}'));

        assert.match(body, /version\.json/,
            'the field card reads something other than the manifest the handset reads');
        assert.doesNotMatch(body, /app_versions/,
            'the field card still reads a table no handset has ever asked for');
    });

    test('the card shows what the relay would advertise, not its own reading', async () => {
        // The admin card and its endpoint once disagreed because each read the
        // manifest for itself; this is the same card and the same trap. The
        // relay decides what may be advertised -- it refuses a manifest naming
        // an APK that is not there -- and the panel has to show that decision
        // rather than a second opinion about the same file.
        const res = await fetch(`${NODE_URL}/api/check-update`);
        const advertised = res.ok ? await res.json() : null;

        const settings = fs.readFileSync(path.join(SRC, 'settings.php'), 'utf8');
        const channel = settings.slice(settings.indexOf('function am2_field_channel'));
        const body = channel.slice(0, channel.indexOf('\n}'));
        assert.match(body, /am2_node_get|check-update/,
            'the field card decides for itself what the channel holds');

        if (!advertised || advertised.success !== true) {
            return; // nothing published here
        }
        const card = await shelf();
        assert.ok(
            card.includes(String(advertised.server_version_code)),
            `the relay advertises build ${advertised.server_version_code} and the card does not show it`,
        );
    });

    test('nothing reads the table that nothing writes', () => {
        // Enforced by absence. app_versions was populated by hand and read by
        // two things that disagreed; leaving one reader is how it comes back.
        const offenders = [];
        for (const file of ['server/lib/routes.js', 'WebAdmin/settings.php']) {
            if (/FROM public\.app_versions/.test(read(file))) offenders.push(file);
        }
        assert.deepEqual(offenders, [],
            `${offenders.join(', ')} still treats app_versions as the channel`);
    });

    test('one act of publishing puts the artifact and its manifest in place together', () => {
        // Copying them separately is the remaining way to get a manifest that
        // describes something other than the bytes beside it.
        const script = path.join(ROOT, 'infra/scripts/publish-field-update.sh');
        assert.ok(fs.existsSync(script), 'nothing publishes the field channel; it is done by hand');

        // What it must do, not how. The APK's published name is taken from the
        // manifest's own update_url, so the literal never appears here.
        const source = fs.readFileSync(script, 'utf8');
        assert.match(source, /sha256sum/, 'the publisher does not check the manifest against the APK');
        assert.match(source, /\.apk/, 'the publisher does not place an APK');
        assert.match(source, /version\.json/, 'the publisher does not place the manifest');
    });

    test('the runbook publishes through it rather than around it', () => {
        assert.match(read('docs/how-to/deploy-and-roll-back.md'), /publish-field-update\.sh/,
            'the runbook still leaves the field channel to whoever remembers');
    });

    /** An artifact as CI leaves it: one APK and the manifest describing it. */
    function artifact({ bytes = 'apk bytes', code = 200, digest = null } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-field-'));
        fs.writeFileSync(path.join(dir, 'am2-client-staging-debug.apk'), bytes);
        const sha = digest ?? spawnSync('sha256sum', [path.join(dir, 'am2-client-staging-debug.apk')],
            { encoding: 'utf8' }).stdout.split(' ')[0];
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({
            version_code: code,
            version_name: `1.1.0-staging+${code}`,
            update_url: 'https://staging-apiapi.am2-poc.com/update/update.apk',
            sha256: sha,
            signer_sha256: 'a'.repeat(64),
            changelog: 'a test build',
        }));
        return dir;
    }

    function publish(from, into) {
        return spawnSync('bash', [
            path.join(ROOT, 'infra/scripts/publish-field-update.sh'),
            '--artifact', from, '--update-dir', into,
        ], { encoding: 'utf8' });
    }

    test('it places the APK under the name the manifest promises', () => {
        const from = artifact();
        const into = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-published-'));
        try {
            const result = publish(from, into);
            assert.equal(result.status, 0, result.stderr);
            // update_url ends in update.apk, so that is what must land -- not
            // whatever the artifact happened to call it.
            assert.ok(fs.existsSync(path.join(into, 'update.apk')), 'no APK was published');
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(into, 'version.json'), 'utf8')).version_code, 200);
        } finally {
            fs.rmSync(from, { recursive: true, force: true });
            fs.rmSync(into, { recursive: true, force: true });
        }
    });

    test('it refuses a manifest that describes different bytes', () => {
        // The handset checks this digest and refuses the install, reporting
        // nothing an operator could act on. Better to refuse at publish time.
        const from = artifact({ digest: 'b'.repeat(64) });
        const into = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-published-'));
        try {
            const result = publish(from, into);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /does not describe this APK/);
            assert.ok(!fs.existsSync(path.join(into, 'update.apk')), 'it published anyway');
        } finally {
            fs.rmSync(from, { recursive: true, force: true });
            fs.rmSync(into, { recursive: true, force: true });
        }
    });

    test('it refuses a build that does not advance past the published one', () => {
        // A handset compares version codes, so republishing something older
        // makes the channel answer "already current" forever to anyone who
        // already took the newer build.
        const into = fs.mkdtempSync(path.join(os.tmpdir(), 'am2-published-'));
        const newer = artifact({ code: 200 });
        const older = artifact({ code: 199, bytes: 'different apk bytes' });
        try {
            assert.equal(publish(newer, into).status, 0);
            const result = publish(older, into);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /does not advance past/);
            assert.equal(
                JSON.parse(fs.readFileSync(path.join(into, 'version.json'), 'utf8')).version_code, 200,
                'the older build replaced the newer one',
            );
        } finally {
            for (const dir of [newer, older, into]) fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
