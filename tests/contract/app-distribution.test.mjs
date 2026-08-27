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

/** What the endpoint actually serves to a handset. */
async function advertised() {
    const res = await fetch(`${BASE}/api_settings.php?action=check_update`, {
        headers: { Host: HOST },
    });
    return { status: res.status, body: await res.json() };
}

/** The distribution card, as rendered. */
async function shelf(locale = 'id') {
    const res = await fetch(`${BASE}/settings.php`, {
        headers: { Host: HOST, Cookie: `${sup};am2_lang=${locale}` },
    });
    assert.equal(res.status, 200, 'settings.php did not render');
    const html = await res.text();
    const start = html.indexOf('id="am2-card-shelf"');
    assert.ok(start > 0, 'the distribution card is not on the page');
    const end = html.indexOf('id="am2-shelf-upload"', start);
    return html.slice(start, end > start ? end : html.length);
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
