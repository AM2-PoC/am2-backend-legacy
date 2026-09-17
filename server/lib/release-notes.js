'use strict';


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
