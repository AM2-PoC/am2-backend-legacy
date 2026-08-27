'use strict';

/**
 * Release notes, in the language the caller asked for.
 *
 * The panel learned to carry notes in more than one language, because an
 * English page was rendering Indonesian release notes -- the only untranslated
 * copy left on the whole English render. app_versions.release_notes is read
 * from two places, though: the panel, and this relay, which hands it to every
 * field handset. Putting an object in that column without teaching this route
 * to read it would have sent handsets a JSON blob where a sentence belongs.
 *
 * So both ends resolve it the same way, and deliberately so:
 *
 *   - a plain string is returned unchanged, which is what every row holds
 *     today and what every handset already receives;
 *   - an object, or a string holding one (the column is text, so an object
 *     stored there comes back encoded), is read for the requested locale;
 *   - a locale the notes do not carry falls back to the default, then to
 *     whatever single language is present.
 *
 * The field app sends no locale, so it gets the default and sees exactly what
 * it sees today. That is the point: the column can start carrying both
 * languages without a single device noticing.
 *
 * This mirrors am2_release_notes() in WebAdmin/i18n.php. Two implementations of
 * one rule is a thing this codebase otherwise refuses, and the reason it is
 * allowed here is that they are in different runtimes with no way to share.
 * tests/unit/release-notes.test.mjs asserts the PHP; this file's own test
 * asserts the same cases against this one.
 */

const DEFAULT_LOCALE = 'id';

function resolveReleaseNotes(value, locale = DEFAULT_LOCALE) {
    let notes = value;

    if (typeof notes === 'string') {
        const trimmed = notes.trim();
        if (trimmed === '' || trimmed[0] !== '{') {
            return notes;
        }
        try {
            const decoded = JSON.parse(trimmed);
            if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
                return notes;
            }
            notes = decoded;
        } catch {
            return notes;
        }
    }

    if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) {
        return '';
    }

    for (const candidate of [locale, DEFAULT_LOCALE]) {
        const text = notes[candidate];
        if (typeof text === 'string' && text.trim() !== '') {
            return text;
        }
    }

    for (const text of Object.values(notes)) {
        if (typeof text === 'string' && text.trim() !== '') {
            return text;
        }
    }
    return '';
}

module.exports = { resolveReleaseNotes, DEFAULT_LOCALE };
