// A helper the protocol calls but never imported.
//
// 80ab744 added the device-token login path and called userForDeviceToken and
// issueDeviceToken in protocol.js. The require at the top was never widened to
// include them, so both were ReferenceErrors at runtime -- invisible, because
// one sits inside a try that logs and continues and the other leaves through
// the login catch-all as "Database Timeout / Connection Error".
//
// The effect in the field: a handset presenting a token could never log in,
// and the relay answered with something that read like a database problem. It
// survived every test here because nothing exercises this call with a token,
// and node --check does not resolve names.
//
// So this asks the one question that catches the whole class: does protocol.js
// call anything db.js exports without importing it?
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../server/lib/${p}`, import.meta.url), 'utf8');

/** Names a module hands out through module.exports = { ... }. */
function exportsOf(source) {
    const at = source.lastIndexOf('module.exports');
    assert.ok(at > 0, 'the module exports nothing');
    const block = source.slice(at, source.indexOf('}', at));
    return new Set(
        block.replace(/module\.exports\s*=\s*{/, '')
            .split(',')
            .map((entry) => entry.split(':')[0].trim())
            .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
    );
}

/** Names a module destructures out of require('./<from>'). */
function importsOf(source, from) {
    const match = source.match(
        new RegExp(`const\\s*{([^}]*)}\\s*=\\s*require\\(['"]\\./${from}['"]\\)`),
    );
    assert.ok(match, `nothing is imported from ./${from}`);
    return new Set(match[1].split(',').map((name) => name.split(':').pop().trim()).filter(Boolean));
}

describe('protocol.js', () => {
    test('calls nothing from db.js that it did not import', () => {
        const protocol = read('protocol.js');
        const available = exportsOf(read('db.js'));
        const imported = importsOf(protocol, 'db');
        const declared = new Set([
            ...protocol.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g),
            ...protocol.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/g),
        ].map((m) => m[1]));

        const missing = [...available].filter((name) =>
            new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(protocol)
            && !imported.has(name)
            && !declared.has(name));

        assert.deepEqual(missing, [],
            `protocol.js calls ${missing.join(', ')} and imports neither -- a ReferenceError `
            + 'at runtime, which the login catch-all reports as a database problem');
    });
});
