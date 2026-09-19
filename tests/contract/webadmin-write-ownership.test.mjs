import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const owners = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/webadmin-write-owners.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/webadmin-write-inventory.json'), 'utf8'));
const php = readdirSync(join(ROOT, 'WebAdmin'))
    .filter((name) => name.endsWith('.php'))
    .map((name) => [name, readFileSync(join(ROOT, 'WebAdmin', name), 'utf8')]);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const treeDigest = (root, extension) => {
    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(extension)) files.push(path);
        }
    };
    walk(join(ROOT, root));
    const hash = createHash('sha256');
    for (const path of files.sort()) {
        hash.update(path.slice(ROOT.length + 1));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
    }
    return { count: files.length, digest: hash.digest('hex') };
};

test('current direct-writer inventory fails closed when PHP or relay source changes', () => {
    assert.equal(inventory.schema_version, 1);
    assert.equal(inventory.source.backend_sha, '2037116c5748ba22d02185f1865606da964a5586');
    const webadmin = treeDigest('WebAdmin', '.php');
    const relay = treeDigest('server', '.js');
    assert.deepEqual(webadmin, {
        count: inventory.source.webadmin_php_files,
        digest: inventory.source.webadmin_tree_sha256,
    });
    assert.deepEqual(relay, {
        count: inventory.source.relay_js_files,
        digest: inventory.source.relay_tree_sha256,
    });
    assert.ok(inventory.direct_writes.length > 0);
    for (const write of inventory.direct_writes) {
        assert.ok(['webadmin', 'relay'].includes(write.writer));
        assert.ok(['INSERT', 'UPDATE', 'DELETE', 'UPSERT'].includes(write.command));
        assert.match(write.table, /^public\.[a-z_]+$/);
        assert.ok(write.columns.length > 0);
        const corpus = write.writer === 'webadmin'
            ? php.map(([, source]) => source).join('\n')
            : readdirSync(join(ROOT, 'server', 'lib'))
                .filter((name) => name.endsWith('.js'))
                .map((name) => read(`server/lib/${name}`)).join('\n');
        assert.match(corpus, new RegExp(`\\b${write.table.replace('.', '\\.') }\\b`, 'i'),
            `${write.writer} inventory names an unreferenced table: ${write.table}`);
        for (const column of write.columns.filter((name) => name !== '*')) {
            assert.match(corpus, new RegExp(`\\b${column}\\b`, 'i'),
                `${write.writer} inventory names an unreferenced column: ${write.table}.${column}`);
        }
    }
    assert.deepEqual(inventory.opaque_mutation_boundaries.sort(), [
        'WebAdmin/api_settings.php:psql-import',
        'WebAdmin/settings.php:psql-import',
    ]);
});

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
