import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseRetrofitInterface } from './lib/kotlin-retrofit-parser.mjs';

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

const assertRetrofitInventory = (methods, operations) => {
  assert.equal(methods.length, operations.length, 'Retrofit operation count drifted from inventory');
  const byFunction = new Map(methods.map((method) => [method.function, method]));
  assert.equal(byFunction.size, methods.length, 'Retrofit function names must be unique');
  const fixtureFunctions = operations.map((operation) => operation.retrofit.function);
  assert.equal(new Set(fixtureFunctions).size, fixtureFunctions.length,
    'inventory Retrofit function names must be unique');
  for (const operation of operations) {
    const method = byFunction.get(operation.retrofit.function);
    assert.ok(method, `${operation.id} Retrofit function is missing: ${operation.retrofit.function}`);
    assert.deepEqual(method, operation.retrofit,
      `${operation.id} no longer matches the current Retrofit method declaration`);
    assert.equal(operation.method, method.http_method, `${operation.id} HTTP method differs from Retrofit`);
    assert.equal(operation.path, method.path, `${operation.id} path differs from Retrofit`);
    assert.deepEqual(operation.request_fields, method.parameters.map((parameter) => parameter.name),
      `${operation.id} wire fields differ from Retrofit`);
    const actionParameter = method.parameters.find((parameter) => parameter.name === 'action');
    if (operation.action !== null && actionParameter && Object.hasOwn(actionParameter, 'default')) {
      assert.equal(operation.action, actionParameter.default,
        `${operation.id} action differs from the Retrofit literal default`);
    }
  }
};

test('Retrofit parser handles multiline parameters, literal defaults, and nested response types', () => {
  const methods = parseRetrofitInterface(`
    interface Fixture {
      @FormUrlEncoded
      @POST("api_items.php")
      suspend fun save(
        @Field("action") action: String = "save",
        @Field("ids[]") ids: List<Int>?,
      ): Response<Map<String, List<Int?>>>

      @Multipart
      @POST("api_import.php")
      suspend fun upload(@Part file: MultipartBody.Part): Response<GenericResponse>
    }
  `);
  assert.deepEqual(methods, [
    {
      function: 'save', http_method: 'POST', path: 'api_items.php', encoding: 'form',
      parameters: [
        { kind: 'field', name: 'action', default: 'save' },
        { kind: 'field', name: 'ids[]' },
      ],
      response_type: 'Map<String,List<Int?>>',
    },
    {
      function: 'upload', http_method: 'POST', path: 'api_import.php', encoding: 'multipart',
      parameters: [{ kind: 'part', name: 'file' }],
      response_type: 'GenericResponse',
    },
  ]);
});

test('Retrofit parser ignores commented annotations and rejects new HTTP verbs', () => {
  const source = `
    interface Fixture {
      // @POST("api_phantom.php")
      /* @GET("api_phantom.php") */
      @GET("api_users.php")
      suspend fun users(): Response<List<User>>
    }
  `;
  assert.equal(parseRetrofitInterface(source).length, 1);
  assert.equal(parseRetrofitInterface(source.replace(
    '@GET("api_users.php")',
    '@GET("api_users.php")\n      /* @POST("api_phantom.php") suspend fun phantom() */',
  )).length, 1);
  assert.throws(() => parseRetrofitInterface(source.replace('    }',
    '      @PUT("api_users.php")\n      suspend fun edit(): Response<GenericResponse>\n    }')),
  /unsupported Retrofit HTTP annotation @PUT/);
  assert.throws(() => parseRetrofitInterface(source.replace('    }',
    '      @PUT\n      suspend fun edit(): Response<GenericResponse>\n    }')),
  /unsupported Retrofit HTTP annotation @PUT/);
  assert.throws(() => parseRetrofitInterface(source.replace('    }',
    '      @GET\n      suspend fun dynamic(@Url url: String): Response<GenericResponse>\n    }')),
  /unsupported Retrofit HTTP annotation @GET/);
  assert.throws(() => parseRetrofitInterface(source.replace('    }',
    '      @GET(value = "api_other.php")\n      suspend fun other(): Response<GenericResponse>\n    }')),
  /unsupported Retrofit HTTP annotation @GET/);
  assert.throws(() => parseRetrofitInterface(`
    interface Fixture {
      @FormUrlEncoded
      @POST("api_users.php")
      suspend fun edit(@Field("action") action: String = ACTION): Response<GenericResponse>
    }
  `), /unsupported non-literal default: ACTION/);
  assert.throws(() => parseRetrofitInterface(`
    interface Fixture {
      @Multipart
      @POST("api_users.php")
      suspend fun edit(@Field("name") name: String): Response<GenericResponse>
    }
  `), /parameter annotations do not match @Multipart encoding/);
});

test('Retrofit comparison goes RED for an unreviewed wire-name change', () => {
  const [method] = parseRetrofitInterface(`
    interface Fixture {
      @FormUrlEncoded
      @POST("api_user_access.php")
      suspend fun updateUserAccess(
        @Field("action") action: String = "update_access",
        @Field("channels") channelIds: List<Int>?,
      ): Response<GenericResponse>
    }
  `);
  assert.throws(() => assertRetrofitInventory([method], [{
    id: 'user-access-update', method: 'POST', path: 'api_user_access.php', action: 'update_access',
    request_fields: ['action', 'channels[]'],
    retrofit: {
      ...method,
      parameters: [
        { kind: 'field', name: 'action', default: 'update_access' },
        { kind: 'field', name: 'channels[]' },
      ],
    },
  }]), /user-access-update no longer matches|user-access-update wire fields differ/);
  assert.throws(() => assertRetrofitInventory([method, { ...method, function: 'other' }], [
    { id: 'one', method: 'POST', path: method.path, action: 'update_access', request_fields: ['action', 'channels'], retrofit: method },
    { id: 'two', method: 'POST', path: method.path, action: 'update_access', request_fields: ['action', 'channels'], retrofit: method },
  ]), /inventory Retrofit function names must be unique/);
});

test('checked-in inventory records the audited Admin APK compatibility surface', () => {
  assert.ok(existsSync(fixturePath), 'missing WebAdmin API contract fixture');
  const inventory = JSON.parse(readFileSync(fixturePath, 'utf8'));

  assert.equal(inventory.schema_version, 3);
  assert.deepEqual(Object.keys(inventory.android_admin_source).sort(), ['callsite', 'path', 'repository', 'sha256', 'source_sha']);
  assert.equal(inventory.android_admin_source.repository, 'AM2-PoC/am2-android-admin');
  assert.equal(inventory.android_admin_source.source_sha, '6a8f2a010fd855afc57100f5f6beb7e75279104a');
  assert.equal(inventory.android_admin_source.sha256, '6901f947e5ee32a255c0ee02445b6a5436eb038a3ae34557665aa03c7356d9c5');
  assert.match(inventory.android_admin_source.path, /^app\/src\/main\/java\/.+ApiService\.kt$/);

  assert.deepEqual(inventory.shared_semantics, {
    identity_authority: 'server-session',
    client_identity_fields: 'compatibility-input-only',
    anonymous: { status: 401, body_keys: ['success', 'message'] },
    csrf: { status: 403, body_keys: ['success', 'msg'] },
    forbidden: { status: 403, body_keys: ['success', 'message'] },
    method_not_allowed: { status: 405 },
    handler_failures_may_use_http_200: true,
  });

  const adminCheckout = process.env.AM2_ADMIN_CHECKOUT;
  assert.ok(adminCheckout, 'AM2_ADMIN_CHECKOUT is required for current Admin route proof');
  const apiService = readFileSync(resolve(adminCheckout, inventory.android_admin_source.path));
  assert.equal(createHash('sha256').update(apiService).digest('hex'), inventory.android_admin_source.sha256,
    'checked-out Admin ApiService.kt differs from the audited fixture');
  const methods = parseRetrofitInterface(apiService.toString('utf8'));
  const callsite = readFileSync(resolve(adminCheckout, inventory.android_admin_source.callsite.path));
  assert.equal(createHash('sha256').update(callsite).digest('hex'), inventory.android_admin_source.callsite.sha256,
    'checked-out Admin import callsite differs from the audited fixture');
  const callsiteSource = callsite.toString('utf8');
  assert.match(callsiteSource, /MultipartBody\.Part\.createFormData\("sql_file"\s*,/,
    'database import no longer sends the audited multipart file part');
  assert.match(callsiteSource, /val\s+actionPart\s*=\s*"import_db"\.toRequestBody\(/,
    'database import no longer sends the audited action literal');
  const importOperation = inventory.operations.find((operation) => operation.id === 'settings-import-database');
  assert.equal(importOperation?.action, 'import_db',
    'database import fixture action differs from the audited callsite literal');
  assert.match(callsiteSource, /\.importDatabase\(actionPart,\s*adminIdPart,\s*body\)/,
    'database import no longer passes the audited multipart values');

  assert.ok(Array.isArray(inventory.operations));
  assert.deepEqual(inventory.operations.map((operation) => operation.id).sort(), expectedOperationIds);
  assertRetrofitInventory(methods, inventory.operations);

  for (const operation of inventory.operations) {
    assert.match(operation.path, /^api_[a-z_]+\.php$/);
    assert.ok(['GET', 'POST'].includes(operation.method));
    assert.ok(['credential', 'public', 'session', 'session-superadmin'].includes(operation.auth));
    assert.equal(typeof operation.csrf, 'boolean');
    assert.ok(Array.isArray(operation.request_fields));
    assert.ok(Array.isArray(operation.response_keys));
    // Samples only: complete status/body/type/null/cookie behavior needs isolated differential tests.
    assert.equal(operation.response_keys_scope, 'non-exhaustive-sample');
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
