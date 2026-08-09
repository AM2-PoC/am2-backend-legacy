import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('unit rules reject arbitrary live-track entity types', () => {
    const src = read('WebAdmin/user_rules.php');
    assert.match(src, /function\s+am2_entity_type/i);
    assert.match(src, /in_array\([\s\S]*\['user',\s*'tracker'\][\s\S]*true/i);
    assert.match(src, /InvalidArgumentException/i);
});

test('create and edit persist entity type without touching location sample time', () => {
    const src = read('WebAdmin/user_rules.php');
    assert.match(src, /function\s+am2_create_user\([^)]*entityType/i);
    assert.match(src, /INSERT INTO public\.users[\s\S]*entity_type/i);
    assert.match(src, /function\s+am2_update_user\([^)]*entityType/i);
    assert.match(src, /UPDATE public\.users[\s\S]*entity_type\s*=/i);
    assert.doesNotMatch(src, /location_updated_at\s*=/i);
});

test('panel and API callers submit validated identity type', () => {
    const panel = read('WebAdmin/users.php');
    const api = read('WebAdmin/api_users.php');
    assert.match(panel, /name="entity_type"/i);
    assert.match(panel, /name="edit_entity_type"/i);
    assert.match(panel, /data-entity-type/i);
    assert.match(panel, /am2_create_user\([^;]*\$entity_type/i);
    assert.match(panel, /am2_update_user\([^;]*\$edit_entity_type/i);
    assert.match(api, /\$entity_type\s*=\s*am2_entity_type/i);
    assert.match(api, /am2_(?:create|update)_user\([^;]*\$entity_type/i);
    assert.match(api, /SELECT\s+entity_type\s+FROM\s+public\.users/i,
        'legacy mobile edits must preserve an omitted tracker classification');
    assert.match(panel, /SELECT\s+entity_type\s+FROM\s+public\.users/i,
        'legacy panel submissions must preserve an omitted tracker classification');
    assert.match(api, /u\.entity_type/,
        'Admin Native cannot preserve/display identity when GET omits entity_type');
});

test('unit catalogue includes identity labels in both locales', () => {
    for (const file of ['WebAdmin/lang/id.php', 'WebAdmin/lang/en.php']) {
        const src = read(file);
        for (const key of ['usr.entity_type', 'usr.entity_user', 'usr.entity_tracker']) {
            assert.match(src, new RegExp(`['"]${key.replace('.', '\\.')}`), `${file} missing ${key}`);
        }
    }
});
