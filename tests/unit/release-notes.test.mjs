// Release notes are the one string on the panel that is not in the catalogue.
//
// Everything else a reader sees comes from lang/id.php or lang/en.php, keyed.
// Notes cannot: they are written per release, not per key. So the manifest and
// app_versions.release_notes each held one free-text field, and an English page
// rendered "Sesi native persisten, CSRF pada semua mutasi, logout server-side."
// -- the only Indonesian surviving anywhere on the English render.
//
// The field may now carry both languages at once. This states what that reader
// must do with every shape the field has ever held, including the plain string
// every manifest published so far contains.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const I18N = new URL('../../WebAdmin/i18n.php', import.meta.url).pathname;

/**
 * Call am2_release_notes() for one locale.
 *
 * i18n.php is loaded whole rather than copied, so the test cannot drift from
 * the implementation. am2_locale() reads $_GET and $_COOKIE and nothing else,
 * which is why setting $_GET['lang'] is enough to choose a language without a
 * session, a database, or a request.
 */
function notes(value, locale) {
    const dir = mkdtempSync(join(tmpdir(), 'am2-notes-'));
    const harness = join(dir, 'run.php');
    writeFileSync(harness, `<?php
$_GET = ['lang' => ${JSON.stringify(locale)}];
$_COOKIE = [];
require ${JSON.stringify(I18N)};
echo json_encode(am2_release_notes(json_decode(${JSON.stringify(JSON.stringify(value))}, true)));
`);
    try {
        return JSON.parse(execFileSync('php', [harness], { encoding: 'utf8' }));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('am2_release_notes', () => {
    test('reads the language being asked for', () => {
        const both = { id: 'Sesi native persisten.', en: 'Persistent native sessions.' };
        assert.equal(notes(both, 'id'), 'Sesi native persisten.');
        assert.equal(notes(both, 'en'), 'Persistent native sessions.');
    });

    test('accepts the plain string every published manifest still holds', () => {
        const legacy = 'Sesi native persisten, CSRF pada semua mutasi.';
        assert.equal(notes(legacy, 'en'), legacy);
        assert.equal(notes(legacy, 'id'), legacy);
    });

    test('reads an object that arrived as encoded JSON', () => {
        // app_versions.release_notes is a text column: an object stored there
        // comes back as its JSON, not as an array.
        const encoded = JSON.stringify({ id: 'Rilis.', en: 'Release.' });
        assert.equal(notes(encoded, 'en'), 'Release.');
    });

    test('falls back to the default locale before giving up', () => {
        assert.equal(notes({ id: 'Hanya Indonesia.' }, 'en'), 'Hanya Indonesia.');
    });

    test('falls back to whatever single language is present', () => {
        // Wrong language beats an empty box: an operator can still read a
        // version note they did not ask for, and cannot read nothing.
        assert.equal(notes({ fr: 'Notes de version.' }, 'en'), 'Notes de version.');
    });

    test('an empty entry does not win over a filled one', () => {
        assert.equal(notes({ en: '   ', id: 'Ada isinya.' }, 'en'), 'Ada isinya.');
    });

    test('nothing at all is an empty string, not a crash', () => {
        assert.equal(notes('', 'en'), '');
        assert.equal(notes({}, 'en'), '');
        assert.equal(notes(null, 'en'), '');
    });
});
