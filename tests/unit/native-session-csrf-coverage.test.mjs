import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const endpoints = [
    'api_users.php',
    'api_channels.php',
    'api_user_access.php',
    'api_admin_panel.php',
    'api_settings.php',
    'api_logout.php',
];

for (const endpoint of endpoints) {
    test(`${endpoint} protects its session-authenticated unsafe requests with CSRF`, () => {
        const source = readFileSync(new URL(`../../WebAdmin/${endpoint}`, import.meta.url), 'utf8');
        const csrf = source.indexOf('am2_csrf_require();');
        assert.ok(csrf >= 0, `${endpoint} must enforce CSRF for unsafe session requests`);
        assert.ok(
            source.includes('am2_api_auth();') || source.includes('am2_session_boot();'),
            `${endpoint} must establish or recognize its session before CSRF enforcement`,
        );
    });
}

// The native app has explicit write methods for all mutation routes above.
// Login creates a new session, so it is deliberately excluded from CSRF.
test('native login is the only POST endpoint deliberately exempt from CSRF', () => {
    const source = readFileSync(new URL('../../WebAdmin/api_login.php', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /am2_csrf_require\(\)/);
    // Rotation moved into am2_session_login(); it must still happen, and the
    // helper it moved into must be the thing that does it.
    const boot = readFileSync(new URL('../../WebAdmin/session_boot.php', import.meta.url), 'utf8');
    const helper = boot.slice(boot.indexOf('function am2_session_login'));
    assert.ok(
        /session_regenerate_id\(true\)/.test(source)
            || (/am2_session_login\(\)/.test(source) && /session_regenerate_id\(true\)/.test(helper)),
        'the native login does not rotate the session id',
    );
});
