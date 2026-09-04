// The panel may not announce a version the endpoint refuses to serve.
//
// api_settings.php?action=check_update validates the published set before it
// advertises anything: an exact key set, an approved URL, a signer that is not
// on the denied list, and a digest matching the bytes on disk. The settings
// card read the same file and showed whatever version_name it found, with no
// validation at all.
//
// So the two disagreed silently. The card said "1.1.0-staging announced" while
// every handset asking the endpoint got 404 and a null version. An operator
// looking at the panel had no way to learn the channel was dead, and the number
// on screen was the reason to believe it was not.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asSuper, BASE, HOST, SRC } from './helpers.mjs';

let sup;
before(async () => { sup = await asSuper(); });

/**
 * What the endpoint serves to a handset asking for an update.
 *
 * With a session, because that is the only way it is ever asked: the check is a
 * button on SettingsActivity, and that screen is reached through the navigation
 * drawer in BaseActivity -- after signing in. This helper used to call
 * anonymously, which stopped being a faithful simulation when api_*.php began
 * requiring a session; it then reported "the endpoint refuses to serve" for
 * every version, including correct ones.
 *
 * A handset that cannot sign in is not cut off from recovery: the manifest and
 * the APK are plain files under /update/, served by the web server without
 * touching PHP, so neither passes through this guard.
 */
async function advertised() {
    const res = await fetch(`${BASE}/api_settings.php?action=check_update`, {
        headers: { Host: HOST, Cookie: sup },
    });
    return { status: res.status, body: await res.json() };
}

/**
 * The Admin Native channel alone, as rendered.
 *
 * Scoped to the first of the two channel sections on purpose. The field app is
 * published from app_versions and currently carries the same version string, so
 * a slice covering both cards cannot tell "the admin channel announces a
 * refused version" from "the field channel announces its own, correctly".
 */
async function shelf(locale = 'id') {
    const res = await fetch(`${BASE}/settings.php`, {
        headers: { Host: HOST, Cookie: `${sup};am2_lang=${locale}` },
    });
    assert.equal(res.status, 200, 'settings.php did not render');
    const html = await res.text();
    const start = html.indexOf('id="am2-shelf-version"');
    assert.ok(start > 0, 'the distribution card is not on the page');

    /*
     * Matched on the classes that carry meaning, not on the exact attribute
     * string. Pinning the literal broke the moment `min-w-0` was added to stop
     * the card sizing itself to an unbreakable URL and overflowing its column
     * -- a correct fix, reported as a missing section. A test that fails when a
     * utility class is added is testing the stylesheet, not the page.
     */
    const cards = [...html.matchAll(/<section class="[^"]*\brounded-control\b[^"]*\bborder-edge\b[^"]*">/g)]
        .filter((m) => m.index > start);
    assert.ok(cards.length > 0, 'the admin channel section is not on the page');
    const first = cards[0].index;
    const second = cards.length > 1 ? cards[1].index : -1;
    return html.slice(first, second > first ? second : html.length);
}

/** The manifest on disk, whatever state it is in. */
function manifest() {
    const file = path.join(SRC, 'update', 'admin_version.json');
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch {
        return {};
    }
}

describe('the admin update channel', () => {
    test('the card shows the version the endpoint serves, and no other', async () => {
        const { body } = await advertised();
        const card = await shelf();

        if (body.latest_version) {
            assert.ok(
                card.includes(body.latest_version),
                `the endpoint serves ${body.latest_version} and the card does not show it`,
            );
            return;
        }

        const claimed = String(manifest().version_name ?? '');
        if (claimed !== '') {
            assert.ok(
                !card.includes(claimed),
                `the endpoint refuses to serve ${claimed} and the card announces it anyway`,
            );
        }
    });

    test('the card names the build, not only the marketing version', async () => {
        // version_name does not move on its own. The admin app takes it from
        // app/version.properties, where a human writes "1.1.0" and leaves it
        // there for a release or ten, so build 51 and build 52 both render as
        // "1.1.0-staging" and an operator cannot tell which one a handset has.
        //
        // version_code does move -- it is the CI run number, and it is the only
        // thing either end compares when deciding an update exists. The
        // manifest carries it and the endpoint serves it; the card simply never
        // showed it.
        const { body } = await advertised();
        if (!body.latest_version) {
            return; // covered by the refusal tests
        }
        const card = await shelf();
        assert.match(
            card, new RegExp(`\\b${body.version_code}\\b`),
            `the endpoint serves build ${body.version_code} and the card does not name it`,
        );
    });

    test('a refused channel is shown as refused, not as empty space', async () => {
        const { body } = await advertised();
        if (body.latest_version) {
            return; // nothing to say while the channel is healthy
        }
        const card = await shelf();
        assert.match(
            card, /border-warn/,
            'the channel serves nothing and the card carries no warning',
        );
    });

    test('one rule decides what is advertised, not two copies of it', async () => {
        // The card and the endpoint disagreed because each read the manifest
        // for itself. Whatever else changes, they must not go back to holding
        // separate opinions: both call the same function.
        const validation = fs.readFileSync(path.join(SRC, 'admin_update_validation.php'), 'utf8');
        assert.match(validation, /function am2_admin_update_advertisement/);

        for (const file of ['api_settings.php', 'settings.php']) {
            assert.match(
                fs.readFileSync(path.join(SRC, file), 'utf8'),
                /am2_admin_update_advertisement\(/,
                `${file} decides for itself what may be advertised`,
            );
        }
    });
});

test('each environment tells the validator which package it actually builds', () => {
    // The Android flavours append applicationIdSuffix, so a staging APK is
    // com.am2.admin.staging and only production is the bare com.am2.admin that
    // config.php defaults to. An environment that does not say so refuses every
    // update set it is given, with "package is not the expected application",
    // while its base URL and its signer both look perfectly correct.
    //
    // This was set by hand on the host and silently reverted by the next
    // deploy, because the vhost is tracked and installed from the repository.
    // A host-only edit to a tracked file is a change with a fuse on it.
    const vhost = fs.readFileSync(
        new URL('../../infra/apache/am2-webadmin-staging.conf', import.meta.url), 'utf8');

    assert.match(vhost, /SetEnv\s+AM2_ADMIN_UPDATE_PACKAGE\s+com\.am2\.admin\.staging/,
        'the staging vhost does not name the package the staging flavour builds');

    // Production is the default and must stay unset rather than repeated: two
    // places holding one value is how they come to disagree.
    const config = fs.readFileSync(path.join(SRC, 'config.php'), 'utf8');
    assert.match(config, /AM2_ADMIN_UPDATE_PACKAGE[\s\S]{0,80}?'com\.am2\.admin'/,
        'the default package is no longer com.am2.admin');
});
