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
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SHARED = 'infra/nginx/am2-webadmin-security.conf';
const DEV_DENY = 'infra/nginx/am2-webadmin-dev-deny.conf';
const VHOSTS = ['infra/nginx/am2-webadmin.conf', 'infra/nginx/am2-webadmin-staging.conf'];
const APACHE_VHOSTS = [
    'infra/apache/am2-webadmin-internal.conf',
    'infra/apache/am2-webadmin-staging.conf',
];

test('the shared edge rules cover everything that used to differ', () => {
    const snippet = read(SHARED);
    // The extensions are the point of the rule, not decoration: .bak is what
    // stops a hand-edited config.php.bak -- the file holding the database
    // password -- being served as plain text.
    for (const ext of ['env', 'ini', 'log', 'bak', 'sql', 'zip', 'tar', 'gz']) {
        assert.match(snippet, new RegExp(`\\b${ext}\\b`),
            `the shared deny list no longer covers .${ext}`);
    }
    assert.match(
        snippet,
        /\(\?:\[\._-\]\[\^\/\]\*\)\?\$/,
        'backup deny only recognizes dot suffixes; names such as '
            + 'admin_version.json.bak-20260816 remain publicly downloadable',
    );
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

test('stable admin update URLs cannot cache one half of a release set', () => {
    for (const f of VHOSTS) {
        const source = read(f);
        assert.match(source, /location\s+\^~\s+\/update\/\s*\{/,
            `${f} lets generic regex locations preempt the update release set`);
        for (const name of ['admin.apk', 'admin_version.json']) {
            const escaped = name.replace('.', '\\.');
            const match = source.match(new RegExp(
                `location\\s+=\\s+\\/update\\/${escaped}\\s*\\{[\\s\\S]*?\\}`));
            assert.ok(match, `${f} has no exact cache guard for ${name}`);
            assert.match(match[0],
            /Cache-Control\s+"no-store, no-cache, must-revalidate, max-age=0"/,
                `${f} lets ${name} retain stale bytes`);
            assert.match(match[0], /expires\s+off/,
                `${f} lets ${name} inherit an expiry`);
        }
        assert.match(source,
            /location\s+\^~\s+\/update\/\s*\{\s*access_log\s+off;\s*return\s+404;\s*\}/,
            `${f} serves non-canonical files from the update directory`);
    }
});

test('stable Client update URLs cannot cache one half of a release set', () => {
    const source = read('infra/nginx/am2-api.conf');
    assert.match(source, /location\s+\^~\s+\/update\/\s*\{/,
        'generic API proxying owns the Client update release set');
    for (const name of ['version.json', 'update.apk']) {
        const escaped = name.replace('.', '\\.');
        const match = source.match(new RegExp(
            `location\\s+=\\s+\\/update\\/${escaped}\\s*\\{[\\s\\S]*?\\}`));
        assert.ok(match, `production API has no exact cache guard for ${name}`);
        assert.match(match[0],
            /Cache-Control\s+"no-store, no-cache, must-revalidate, max-age=0"/,
            `${name} can remain stale while its release-set peer changes`);
        assert.match(match[0], /proxy_hide_header\s+Cache-Control/,
            `${name} returns conflicting upstream and edge cache policies`);
        assert.match(match[0], /expires\s+off/, `${name} inherits an expiry`);
    }
    assert.match(source,
        /location\s+\^~\s+\/update\/\s*\{\s*access_log\s+off;\s*return\s+404;\s*\}/,
        'non-canonical Client update files remain public');
});

test('every WebAdmin root redirects explicitly to login', () => {
    for (const f of VHOSTS) {
        assert.match(read(f), /location = \/\s*\{\s*return 302 \/login\.php;\s*\}/s,
            `${f} leaves / to the origin DirectoryIndex instead of the login contract`);
    }
});

test('repository and development artifacts are denied by every edge vhost', () => {
    const snippet = read(DEV_DENY);
    for (const marker of ['docs', 'infra', 'tests', '.github', '.git',
                          'package', 'composer', 'README', 'CHANGELOG',
                          'node_modules', 'struktur_am2']) {
        assert.match(snippet, new RegExp(marker.replace('.', '\\.')),
            `${DEV_DENY} no longer blocks ${marker}`);
    }
    assert.match(snippet, /return 404/,
        'development artifacts disclose their existence instead of returning 404');
    assert.match(snippet, /\^\/\(\?:WebAdmin\/\)\?/,
        'manifest/node_modules deny misses the actual document-root URL');
    for (const f of VHOSTS) {
        assert.match(read(f), /include\s+snippets\/am2-webadmin-dev-deny\.conf;/,
            `${f} does not load the development-artifact deny rules`);
    }
});

test('development deny precedes generic edge regex locations', () => {
    for (const f of VHOSTS) {
        const text = read(f);
        assert.ok(
            text.indexOf('include snippets/am2-webadmin-dev-deny.conf;')
                < text.indexOf('include snippets/am2-webadmin-security.conf;'),
            `${f} lets the generic dotfile regex preempt development 404s`,
        );
    }
});

test('the prepended file strips rendered implementation commentary', () => {
    const filter = read('infra/php/webadmin-prepend.php');
    assert.match(filter, /ob_start/);
    assert.match(filter, /preg_replace/);
    assert.match(filter, /<!--/);
    assert.match(filter, /headers_list\(\)/,
        'the output filter does not use the response Content-Type');
    assert.doesNotMatch(filter, /doctype|<html/i,
        'the output filter infers MIME type from arbitrary response bytes');
    /*
     * The directive is no longer written into the vhosts. It now lives in PHP's
     * own conf.d, installed by infra/scripts/install-webadmin-guard.sh, because
     * the same file also carries the authentication net -- and the migration
     * plan retires Apache, which would have taken a vhost directive with it
     * silently and in the direction of open.
     */
    for (const f of APACHE_VHOSTS) {
        assert.doesNotMatch(read(f), /php_value\s+auto_prepend_file/,
            `${f} still pins the prepend to Apache, which is being retired`);
    }
    assert.match(read('infra/scripts/install-webadmin-guard.sh'),
        /auto_prepend_file = \$installed/,
        'nothing installs the prepend into PHP configuration');
});

test('output filter changes HTML comments but preserves explicit non-HTML bytes', () => {
    const filter = join(ROOT, 'infra/php/webadmin-prepend.php');
    const run = (contentType, body) => execFileSync('php', [
        '-r',
        `putenv('AM2_OUTPUT_FILTER_CONTENT_TYPE=' . $argv[1]); require $argv[2]; echo $argv[3];`,
        contentType,
        filter,
        body,
    ], { encoding: 'utf8' });

    assert.equal(
        run('text/html; charset=UTF-8', '<html><!-- private -->visible</html>'),
        '<html>visible</html>',
    );
    const json = '{"fragment":"<html><!-- keep --></html>"}';
    assert.equal(run('application/json', json), json);
});

test('the Apache origin returns 404 for repository and development artifacts', () => {
    for (const f of APACHE_VHOSTS) {
        const vhost = read(f);
        assert.match(vhost, /RedirectMatch\s+404[^\n]*(?:docs|infra|tests)/,
            `${f} exposes internal directories when nginx is bypassed`);
        assert.match(vhost, /RedirectMatch\s+404[^\n]*\(WebAdmin\/\)\?[^\n]*node_modules/,
            `${f} does not block node_modules at the actual document-root URL`);
        assert.match(vhost, /RedirectMatch\s+404[^\n]*(?:package|composer|README|CHANGELOG)/,
            `${f} exposes repository manifests when nginx is bypassed`);
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
