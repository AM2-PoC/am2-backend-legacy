import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../infra/scripts/verify-webadmin-guard.sh', import.meta.url), 'utf8');

test('direct-request libraries accept only their intentional opaque 404', () => {
    assert.match(source, /auth_guard\.php\|session_boot\.php\)/);
    assert.match(source, /\$api == 404 && \$nav == 404/);
});
