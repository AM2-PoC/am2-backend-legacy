// The published update manifest must be validated before it is advertised.
//
// The endpoint used to read admin_version.json and echo whatever it found:
// a version string, a URL, and a changelog. Nothing checked that the file it
// pointed at had that digest, that the APK was signed by the approved key, or
// that the version advanced. The validator written for exactly that job sat
// unused and unimplemented -- see #60.
//
// Source-contract rather than HTTP: the live suite for this endpoint needs the
// panel running and a session, so it lives on the VPS. These assertions run in
// CI, where the regression would otherwise land unseen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const settings = readFileSync(new URL('../../WebAdmin/api_settings.php', import.meta.url), 'utf8');
const gate = settings.slice(
    settings.indexOf("($_GET['action'] ?? '') === 'check_update'"),
    settings.indexOf('am2_api_auth();'),
);

/*
 * The validation moved out of this gate and into
 * am2_admin_update_advertisement(), because the settings card had to reach the
 * same verdict and, reading the manifest for itself, reached a different one --
 * announcing a version this endpoint was refusing to serve.
 *
 * So "the gate validates" now means one of two things, and both are checked:
 * it calls the validator itself, or it calls the one function that does. A
 * gate that calls neither, or a helper that validates nothing, still fails.
 */
const validation = readFileSync(new URL('../../WebAdmin/admin_update_validation.php', import.meta.url), 'utf8');
const advertisement = validation.slice(validation.indexOf('function am2_admin_update_advertisement'));

function validatesThePublishedSet(source) {
    if (source.includes('am2_validate_signed_update_set(')) return true;
    return source.includes('am2_admin_update_advertisement(')
        && advertisement.includes('am2_validate_signed_update_set(');
}

test('the update check validates the manifest before advertising it', () => {
    assert.ok(gate.length > 0, 'the check_update gate must precede authentication');
    assert.ok(validatesThePublishedSet(gate), 'check_update must validate the published set');
    // The rejection path has to come from the validator, not from a second
    // opinion written next to it that can drift out of agreement.
    assert.match(gate, /\$\w+\s*\[\s*'valid'\s*\]/, 'the validator verdict must decide the response');
});

test('an invalid or absent set is not advertised', () => {
    const reject = gate.indexOf('http_response_code(404)');
    const validated = gate.search(/am2_validate_signed_update_set\(|am2_admin_update_advertisement\(/);
    assert.ok(validatesThePublishedSet(gate), 'the validator must be called at all');
    assert.ok(reject > validated, '404 must be reachable from the validator verdict');
});

test('the three keys the panel and older builds read are still present', () => {
    for (const key of ['latest_version', 'download_url', 'changelog']) {
        assert.ok(gate.includes(`'${key}'`), `check_update lost ${key}`);
    }
});

test('the fields the handset verifies against are served', () => {
    // UpdateInfo.kt declares these non-null; without them the client cannot
    // build UpdateMetadata and every check fails as "identitas APK tidak valid".
    for (const key of ['version_code', 'version_name', 'update_url', 'sha256', 'signer_sha256']) {
        assert.ok(gate.includes(`'${key}'`), `check_update does not serve ${key}`);
    }
});
