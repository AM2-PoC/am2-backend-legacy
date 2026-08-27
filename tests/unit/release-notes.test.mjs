// Release notes are the one string on the panel that is not in the catalogue.
//
// Everything else a reader sees comes from lang/id.php or lang/en.php, keyed.
// Notes cannot: they are written per release, not per key. So the manifest and
// app_versions.release_notes each held one free-text field, and an English page
// rendered "Sesi native persisten, CSRF pada semua mutasi, logout server-side."
// -- the only Indonesian surviving anywhere on the English render.
//
// The field may now carry both languages at once. Two things read it: the panel
// in PHP, and the relay in JavaScript, which hands the notes to every field
// handset. Putting an object in that column without teaching the relay to read
// it would send handsets a JSON blob where a sentence belongs.
//
// Two implementations of one rule is what this codebase otherwise refuses. They
// are in different runtimes with no way to share, so instead every case below
// is asserted against BOTH -- which is the only thing that can stop them
// drifting apart later.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const I18N = new URL('../../WebAdmin/i18n.php', import.meta.url).pathname;
const { resolveReleaseNotes } = createRequire(import.meta.url)('../../server/lib/release-notes.js');

/**
 * Call am2_release_notes() for one locale.
 *
 * i18n.php is loaded whole rather than copied, so the test cannot drift from
 * the implementation. am2_locale() reads $_GET and $_COOKIE and nothing else,
 * which is why setting $_GET['lang'] is enough to choose a language without a
 * session, a database, or a request.
 */
function fromPhp(value, locale) {
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

const LEGACY = 'Sesi native persisten, CSRF pada semua mutasi.';

const cases = [
    {
        name: 'reads the language being asked for',
        value: { id: 'Sesi native persisten.', en: 'Persistent native sessions.' },
        locale: 'en',
        expected: 'Persistent native sessions.',
    },
    {
        name: 'reads Indonesian when Indonesian is asked for',
        value: { id: 'Sesi native persisten.', en: 'Persistent native sessions.' },
        locale: 'id',
        expected: 'Sesi native persisten.',
    },
    {
        // Every manifest published so far, and every row already in
        // app_versions, holds exactly this. A release note is not worth a
        // migration, so the plain string has to keep working untouched.
        name: 'accepts the plain string every published release still holds',
        value: LEGACY,
        locale: 'en',
        expected: LEGACY,
    },
    {
        // app_versions.release_notes is a text column: an object stored there
        // comes back as its JSON, not as a structure.
        name: 'reads an object that arrived as encoded JSON',
        value: JSON.stringify({ id: 'Rilis.', en: 'Release.' }),
        locale: 'en',
        expected: 'Release.',
    },
    {
        name: 'falls back to the default locale before giving up',
        value: { id: 'Hanya Indonesia.' },
        locale: 'en',
        expected: 'Hanya Indonesia.',
    },
    {
        // Wrong language beats an empty box: an operator can still read a
        // version note they did not ask for, and cannot read nothing.
        name: 'falls back to whatever single language is present',
        value: { fr: 'Notes de version.' },
        locale: 'en',
        expected: 'Notes de version.',
    },
    {
        name: 'an empty entry does not win over a filled one',
        value: { en: '   ', id: 'Ada isinya.' },
        locale: 'en',
        expected: 'Ada isinya.',
    },
    { name: 'an empty string stays empty', value: '', locale: 'en', expected: '' },
    { name: 'an empty object is an empty string', value: {}, locale: 'en', expected: '' },
    { name: 'nothing at all is an empty string, not a crash', value: null, locale: 'en', expected: '' },
    {
        // The relay's caller sends no locale at all; it must not become the
        // literal string "undefined" or throw.
        name: 'no locale asked for means the default',
        value: { id: 'Bawaan.', en: 'Default.' },
        locale: '',
        expected: 'Bawaan.',
    },
];

describe('release notes resolve the same way in both runtimes', () => {
    for (const { name, value, locale, expected } of cases) {
        test(`${name} (panel, PHP)`, () => {
            assert.equal(fromPhp(value, locale), expected);
        });

        test(`${name} (relay, JavaScript)`, () => {
            assert.equal(resolveReleaseNotes(value, locale), expected);
        });
    }
});
