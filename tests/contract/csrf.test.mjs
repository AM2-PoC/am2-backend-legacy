// Cross-site request forgery protection on the panel.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, get, postForm, json, csrfToken, BASE, HOST } from './helpers.mjs';

let sup;
before(async () => { sup = await asSuper(); });

const bare = (path, cookie, fields) => fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: HOST, Cookie: cookie },
    body: new URLSearchParams(fields),
});

describe('csrf', () => {
    test('an authenticated POST without the token is refused', async () => {
        const res = await bare('/users.php', sup, {
            update_feature: '1', u_id: 'CT_A1', feature: 'enable_maps', val: 'true',
        });
        assert.equal(res.status, 403);
    });

    test('a wrong token is refused', async () => {
        const res = await bare('/users.php', sup, {
            update_feature: '1', u_id: 'CT_A1', feature: 'enable_maps', val: 'true',
            _csrf: 'f'.repeat(64),
        });
        assert.equal(res.status, 403);
    });

    test('the right token is accepted', async () => {
        const body = await json(await postForm('/users.php', sup, {
            update_feature: '1', u_id: 'CT_A1', feature: 'enable_maps', val: 'false',
        }));
        assert.equal(body.success, true);
    });

    test('every panel form carries a token field', async () => {
        for (const p of ['/users.php', '/channels.php', '/user_access.php',
                         '/settings.php', '/admin_panel.php']) {
            const html = await (await get(p, sup)).text();
            const forms = (html.match(/<form\b[^>]*method\s*=\s*["']post["'][^>]*>/gi) ?? []).length;
            const tokens = (html.match(/name="_csrf"/g) ?? []).length;
            assert.ok(forms > 0, `${p} rendered no POST form`);
            assert.ok(tokens >= forms,
                `${p}: ${forms} POST forms but only ${tokens} tokens`);
        }
    });

    test('unauthenticated api_*.php POSTs are not blocked by csrf', async () => {
        // The Admin Native app has no session and no token. CSRF must not be
        // what stops it; that is the job of the credential in a later change.
        const res = await fetch(`${BASE}/api_login.php`, {
            method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: HOST },
            body: new URLSearchParams({ username: 'nobody', password: 'x' }),
        });
        assert.notEqual(res.status, 403);
    });
});
