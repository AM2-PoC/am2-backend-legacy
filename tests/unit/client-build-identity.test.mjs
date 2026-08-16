import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The relay must be able to name the build on the other end of the socket.
 *
 * It logged a username and nothing about the software. So "is that unit running
 * the fix" had no answer from the server, and the question was instead answered
 * from an APK signer digest -- which identifies a keystore, not a commit, and
 * gave the wrong answer for a whole round of latency work.
 *
 * The client now sends its version with the login. Recording it turns a
 * question that needed a cable, a device and somebody reading a screen into one
 * line of a log the server already writes.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = readFileSync(join(ROOT, 'server', 'lib', 'protocol.js'), 'utf8');

test('the login records which build connected', () => {
    assert.match(protocol, /client_version_code/,
        'the relay ignores the version the client sends');
});

test('the recorded version is attached to the session, not just logged once', () => {
    // A number that exists only in a log line cannot be reported alongside link
    // quality, and link quality is where the question actually gets asked.
    assert.match(protocol, /ws\.clientVersionCode/,
        'the build is not held on the session');
});

test('link quality reports the build it is measuring', () => {
    const report = protocol.slice(protocol.indexOf('function reportLinkQuality'));
    assert.match(report.slice(0, 1200), /client_version/,
        'the link report cannot say which build produced these numbers');
});

test('a client that sends no version is recorded as unknown, not as a crash', () => {
    // Every APK in the field predates this field. Parsing must tolerate absence.
    assert.match(protocol, /clientVersionCode\s*=\s*Number\.isSafeInteger|clientVersionCode\s*=\s*\(/,
        'the version is trusted without validation');
});
