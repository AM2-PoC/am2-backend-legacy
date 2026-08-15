import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../../WebAdmin/config.php', import.meta.url), 'utf8');
const login = readFileSync(new URL('../../WebAdmin/api_login.php', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../../WebAdmin/api_settings.php', import.meta.url), 'utf8');

test('native login establishes a regenerated server session and returns its csrf token', () => {
    assert.match(login, /session_regenerate_id\(true\)/);
    assert.match(login, /\$_SESSION\['admin_logged_in'\]\s*=\s*true/);
    assert.match(login, /\$_SESSION\['admin_id'\]\s*=\s*\(int\)\s*\$user\['id'\]/);
    assert.match(login, /'csrf_token'\s*=>\s*am2_csrf_token\(\)/);
});

test('csrf applies to every unsafe HTTP method for authenticated sessions', () => {
    assert.match(config, /\['POST', 'PUT', 'PATCH', 'DELETE'\]/);
    assert.match(config, /HTTP_X_CSRF_TOKEN/);
});

test('a session identity is read server-side rather than from request parameters', () => {
    const identity = config.slice(config.indexOf('function am2_api_identity'), config.indexOf('function am2_api_require_super'));
    assert.match(identity, /\$_SESSION\['admin_id'\]/);
    assert.match(identity, /\$_SESSION\['admin_role'\]/);
});

test('the public update check is evaluated before session authentication', () => {
    const updateGate = settings.indexOf("($_GET['action'] ?? '') === 'check_update'");
    const authGate = settings.indexOf('am2_api_auth();');
    assert.ok(updateGate >= 0, 'settings must retain the update-check gate');
    assert.ok(authGate >= 0, 'settings must authenticate protected operations');
    assert.ok(updateGate < authGate, 'public update check must run before authentication');
});

const logout = readFileSync(new URL('../../WebAdmin/api_logout.php', import.meta.url), 'utf8');
test('native logout destroys the server session', () => {
    assert.match(logout, /session_destroy\(\)/);
    assert.match(logout, /setcookie\(session_name\(\)/);
});
