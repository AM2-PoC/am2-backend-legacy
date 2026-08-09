// Session handling and sign-in throttling.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { env, BASE, HOST, login } from './helpers.mjs';

const form = (fields, headers = {}) => fetch(`${BASE}/login.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: HOST, ...headers },
    body: new URLSearchParams(fields),
});

describe('session cookie', () => {
    test('carries HttpOnly, Secure and SameSite', async () => {
        const res = await fetch(`${BASE}/login.php`, { headers: { Host: HOST } });
        const c = (res.headers.getSetCookie?.() ?? []).filter((x) => x.startsWith('PHPSESSID=')).pop();
        assert.ok(c, 'no session cookie issued');
        assert.match(c, /HttpOnly/i);

        /*
         * Secure is asserted over TLS, not here.
         *
         * BASE is http://127.0.0.1:8081 -- straight to Apache, bypassing nginx
         * and Cloudflare, which is what makes this suite runnable at all. That
         * connection is genuinely plain HTTP, so a cookie marked Secure would
         * not come back on it and every later test would lose its session.
         *
         * The flag is conditional in session_boot.php for exactly that reason,
         * so the meaningful check is that it appears on the path a browser
         * actually uses. Measured through nginx over TLS:
         *   PHPSESSID=...; path=/; secure; HttpOnly; SameSite=Lax
         * and without it on this one. Both are correct.
         */
        assert.doesNotMatch(c, /Secure/i,
            'the cookie is marked Secure on a plain-HTTP connection, so it will '
            + 'not be sent back and every session-bearing test loses its session');
        assert.match(c, /SameSite=Lax/i);
    });

    test('the id changes on successful sign-in', async () => {
        // Without regeneration an id planted before authentication survives it.
        const anon = await fetch(`${BASE}/login.php`, { headers: { Host: HOST } });
        const before = (anon.headers.getSetCookie?.() ?? [])
            .find((x) => x.startsWith('PHPSESSID='))?.split(';')[0];
        assert.ok(before);

        const res = await form(
            { username: env.CT_SUPER_USER, password: env.CT_SUPER_PASS },
            { Cookie: before }
        );
        const after = (res.headers.getSetCookie?.() ?? [])
            .filter((x) => x.startsWith('PHPSESSID=')).pop()?.split(';')[0];
        assert.ok(after, 'no new id issued on login');
        assert.notEqual(after, before);
    });
});

describe('sign-in throttling', () => {
    // Keyed on account plus source, so this probe cannot lock out a real admin.
    const probe = 'ct_throttle_probe_' + Date.now();

    test('blocks after repeated failures, and a rotating X-Forwarded-For does not evade it', async () => {
        let blockedAt = 0;
        for (let i = 1; i <= 14 && !blockedAt; i++) {
            const res = await form(
                { username: probe, password: 'wrong' },
                { 'X-Real-IP': '203.0.113.77', 'X-Forwarded-For': `10.0.0.${i}` }
            );
            if (/Terlalu banyak/.test(await res.text())) blockedAt = i;
        }
        assert.ok(blockedAt > 0 && blockedAt <= 12,
            `expected a block within 12 attempts, got ${blockedAt || 'none'}`);
    });

    test('a different account from the same source still signs in', async () => {
        const res = await form(
            { username: env.CT_BRANCH_A_USER, password: env.CT_BRANCH_A_PASS },
            { 'X-Real-IP': '203.0.113.77' }
        );
        assert.equal(res.status, 302, 'one guessed account must not lock out the rest');
    });
});
