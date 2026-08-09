/**
 * Staging is defended the same way production is.
 *
 * Staging restores from a production dump, so what sits behind that vhost is
 * real personal data on a host anyone can reach. Its nginx config had one deny
 * rule where production had four plus a login throttle, and its Apache vhost
 * had none of production's three. Nobody decided that: the files were written
 * months apart and only one of them was maintained.
 *
 * The shared rules live in one snippet now, so the interesting assertion is not
 * "both files contain these lines" -- it is that neither has quietly stopped
 * including it, and that nothing sensitive is defended in one place only.
 *
 * Credential-free by construction. It must never import
 * tests/contract/helpers.mjs, which reads a protected environment file at
 * module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SHARED = 'infra/nginx/am2-webadmin-security.conf';
const VHOSTS = ['infra/nginx/am2-webadmin.conf', 'infra/nginx/am2-webadmin-staging.conf'];

test('the shared edge rules cover everything that used to differ', () => {
    const snippet = read(SHARED);
    // The extensions are the point of the rule, not decoration: .bak is what
    // stops a hand-edited config.php.bak -- the file holding the database
    // password -- being served as plain text.
    for (const ext of ['env', 'ini', 'log', 'bak', 'sql', 'zip', 'tar', 'gz']) {
        assert.match(snippet, new RegExp(`\\b${ext}\\b`),
            `the shared deny list no longer covers .${ext}`);
    }
    for (const header of ['X-Frame-Options', 'X-Content-Type-Options',
                          'Referrer-Policy', 'Permissions-Policy']) {
        assert.match(snippet, new RegExp(header), `${header} is no longer set for either vhost`);
    }
    assert.match(snippet, /setup|install/, 'the one-time installer endpoints are reachable again');
    assert.match(snippet, /return 404/,
        'the installer endpoints answer 403, which confirms to a scanner that they exist');
});

test('every WebAdmin vhost includes them', () => {
    for (const f of VHOSTS) {
        assert.match(read(f), /include\s+snippets\/am2-webadmin-security\.conf;/,
            `${f} does not include the shared security rules, so it is defended on its own again`);
    }
});

test('nothing sensitive is defended in one vhost only', () => {
    /*
     * The regression this file exists for. A rule added straight into the
     * production vhost -- rather than into the snippet -- would protect
     * production and leave staging, holding the same personal data, open. This
     * catches that by comparing what each vhost adds beyond the shared file.
     */
    const own = (f) => read(f)
        .replace(/#[^\n]*/g, '')
        .split('\n')
        .filter((l) => /deny all|return 404|limit_req/.test(l))
        .map((l) => l.trim());

    const prodOnly = own(VHOSTS[0]).filter((l) => !own(VHOSTS[1]).includes(l));
    assert.deepEqual(prodOnly, [],
        'production carries a protection staging does not; it belongs in '
        + `${SHARED} so both get it:\n  ${prodOnly.join('\n  ')}`);
});

test('the login form is throttled wherever it is reachable', () => {
    // Staging shares production's password hashes, so an unthrottled login form
    // there is an unthrottled login form for those credentials.
    for (const f of VHOSTS) {
        assert.match(read(f), /limit_req\s+zone=am2_webadmin_login/,
            `${f} serves login.php with no rate limit`);
    }
});

test('HSTS is on, and starts low enough to be withdrawn', () => {
    for (const f of VHOSTS) {
        const src = read(f).replace(/#[^\n]*/g, '');
        const hsts = src.match(/Strict-Transport-Security\s+"max-age=(\d+)/);
        assert.ok(hsts, `${f} does not set HSTS, so the first plaintext request is unprotected`);
        // A browser remembers this and it cannot be taken back quickly. Raising
        // it is a deliberate step, not something to ship at six months on the
        // first commit that enables it.
        assert.ok(Number(hsts[1]) <= 86400,
            `${f} starts HSTS at ${hsts[1]}s; a long max-age is hard to withdraw if TLS breaks`);
    }
});

test('the Apache vhosts deny the same files as each other', () => {
    const prod = read('infra/apache/am2-webadmin-internal.conf');
    const staging = read('infra/apache/am2-webadmin-staging.conf');
    /*
     * Apache is the layer that still holds when a request arrives another way:
     * it listens on 127.0.0.1 and anything on the host can reach it directly,
     * which is exactly how the contract suite bypasses Cloudflare.
     */
    const patterns = (src) => (src.match(/<FilesMatch\s+"([^"]+)"/g) ?? []).sort();
    assert.deepEqual(patterns(staging), patterns(prod),
        'the staging Apache vhost denies a different set of files from production');
});
