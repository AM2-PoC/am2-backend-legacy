import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const fixturePath = resolve(ROOT, 'tests/fixtures/webadmin-api-contract.json');

const expectedOperationIds = [
  'login', 'logout', 'dashboard-stats', 'dashboard-chart',
  'users-list', 'users-add', 'users-update-feature', 'users-delete',
  'users-get-channels', 'users-save-channels',
  'channels-list', 'channels-add', 'channels-edit', 'channels-delete',
  'channels-get-users-access', 'channels-save-access',
  'user-access-list', 'user-access-force-logout', 'user-access-update',
  'track-units', 'logs-list',
  'admins-list', 'admins-save', 'admins-delete', 'admins-delegate',
  'settings-profile', 'settings-check-update', 'settings-update-password',
  'settings-import-database',
].sort();

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

test('checked-in inventory records the audited Admin APK compatibility surface', () => {
  assert.ok(existsSync(fixturePath), 'missing WebAdmin API contract fixture');
  const inventory = JSON.parse(readFileSync(fixturePath, 'utf8'));

  assert.equal(inventory.schema_version, 2);
  assert.deepEqual(Object.keys(inventory.android_admin_source).sort(), ['path', 'repository', 'source_sha']);
  assert.equal(inventory.android_admin_source.repository, 'AM2-PoC/am2-android-admin');
  assert.match(inventory.android_admin_source.source_sha, /^[0-9a-f]{40}$/);
  assert.match(inventory.android_admin_source.path, /^app\/src\/main\/java\/.+ApiService\.kt$/);

  assert.ok(Array.isArray(inventory.operations));
  assert.deepEqual(inventory.operations.map((operation) => operation.id).sort(), expectedOperationIds);

  for (const operation of inventory.operations) {
    assert.match(operation.path, /^api_[a-z_]+\.php$/);
    assert.ok(['GET', 'POST'].includes(operation.method));
    assert.ok(['credential', 'public', 'session', 'session-superadmin'].includes(operation.auth));
    assert.equal(typeof operation.csrf, 'boolean');
    assert.ok(Array.isArray(operation.request_fields));
    assert.ok(Array.isArray(operation.response_keys));
    assert.ok(existsSync(resolve(ROOT, 'WebAdmin', operation.path)),
      `Admin APK inventory names a missing legacy endpoint: ${operation.path}`);

    assert.ok(['implemented', 'legacy-unsupported'].includes(operation.legacy_status));
    if (operation.action !== null) {
      assert.equal(typeof operation.action, 'string');
      assert.ok(operation.request_fields.includes('action'),
        `${operation.id} names an action without preserving its action field`);
      const source = read(`WebAdmin/${operation.path}`);
      const actionName = operation.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const handler = new RegExp(
        `(?:\\$action|\\$_(?:GET|POST)\\['action'\\]|\\(\\$_(?:GET|POST)\\['action'\\]\\s*\\?\\?\\s*['"]{2}\\))\\s*={2,3}\\s*['"]${actionName}['"]`
      );
      if (operation.legacy_status === 'implemented') {
        assert.match(source, handler,
          `${operation.id} action is no longer represented by its legacy endpoint`);
      } else {
        assert.doesNotMatch(source, handler,
          `${operation.id} incorrectly describes an implemented legacy action as unsupported`);
      }
    }
  }
});
