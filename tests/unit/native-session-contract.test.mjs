import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../../WebAdmin/config.php', import.meta.url), 'utf8');
const login = readFileSync(new URL('../../WebAdmin/api_login.php', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../../WebAdmin/api_settings.php', import.meta.url), 'utf8');

// Rotation moved into am2_session_login(), which also collapses the two
// Set-Cookie headers PHP would otherwise emit. Accept either the direct call
// or the helper -- and check the helper really rotates, so booting through one
// that does nothing cannot satisfy this.
const rotates = (source) => {
    if (/session_regenerate_id\(true\)/.test(source)) return true;
    if (!/am2_session_login\(\)/.test(source)) return false;
    const boot = readFileSync(new URL('../../WebAdmin/session_boot.php', import.meta.url), 'utf8');
    const helper = boot.slice(boot.indexOf('function am2_session_login'));
    return /session_regenerate_id\(true\)/.test(helper);
};


test('native login establishes a regenerated server session and returns its csrf token', () => {
    assert.ok(rotates(login), 'the login does not rotate the session id');
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
