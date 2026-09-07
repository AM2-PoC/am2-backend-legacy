import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const owners = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/webadmin-write-owners.json'), 'utf8'));
const php = readdirSync(join(ROOT, 'WebAdmin'))
    .filter((name) => name.endsWith('.php'))
    .map((name) => [name, readFileSync(join(ROOT, 'WebAdmin', name), 'utf8')]);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const relayOwned = Object.entries(owners)
    .filter(([, owner]) => owner === 'relay')
    .map(([column]) => column.split('.').at(-1));

test('WebAdmin cannot write relay-owned session columns', () => {
    const offenders = [];
    for (const [name, source] of php) {
        const statements = [
            ...source.matchAll(/"UPDATE\s+(?:public\.)?users\s+SET([\s\S]*?)"/gi),
            ...source.matchAll(/'UPDATE\s+(?:public\.)?users\s+SET([^']*)'/gi),
        ];
        for (const statement of statements) {
            const assignments = statement[1];
            for (const column of relayOwned) {
                if (new RegExp(`\\b${column}\\s*=`, 'i').test(assignments)) offenders.push(`${name}:${column}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `relay-owned columns still have PHP writers: ${offenders.join(', ')}`);
});

test('last_channel_id remains the durable WebAdmin default, not a relay join side effect', () => {
    assert.equal(owners['public.users.last_channel_id'], 'webadmin');
    assert.match(read('WebAdmin/channel_access.php'), /UPDATE public\.users SET last_channel_id = \?/);
    assert.doesNotMatch(read('server/lib/protocol.js'), /UPDATE public\.users SET[^"`]*last_channel_id\s*=/s,
        'joining an operational room still rewrites the operator-selected default');
});

test('force logout crosses the relay command boundary once', () => {
    assert.doesNotMatch(read('WebAdmin/user_rules.php'), /UPDATE\s+(?:public\.)?users\s+SET[\s\S]{0,240}?force_logout\s*=/i,
        'WebAdmin still keeps its own force-logout database writer');
    for (const path of ['WebAdmin/user_access.php', 'WebAdmin/api_user_access.php']) {
        const source = read(path);
        assert.match(source, /notifyForceLogout\(/, `${path} does not command the relay`);
        assert.doesNotMatch(source, /am2_force_logout_user\(/, `${path} still uses the deleted local writer`);
    }
});
