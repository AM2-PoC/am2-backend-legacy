// Shared helpers for the contract suite.
//
// These tests are characterization tests: they record what the system does
// today so that a redesign cannot change it by accident. They are not a
// statement that today's behaviour is correct. Where it is known to be wrong,
// the test says so and names the release that will change it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ENV_FILE = process.env.CT_ENV_FILE || '/etc/am2/contract-test.env';

function loadEnv() {
    if (!fs.existsSync(ENV_FILE)) {
        throw new Error(
            `Missing ${ENV_FILE}. Run infra/scripts/contract-test-fixtures.sh on the staging host first.`
        );
    }
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const [k, ...rest] = t.split('=');
        out[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

export const env = loadEnv();

// Requests go straight to the staging Apache, with the vhost selected by a Host
// header. Going through the public hostname means going through Cloudflare,
// which caches HTML: a mutated page keeps returning its cached copy and the
// suite reports green against code that no longer exists.
export const BASE = env.CT_ORIGIN_URL || 'http://127.0.0.1:8081';
export const HOST = env.CT_HOST || 'staging-webadmin.am2-poc.com';
// Only for assertions about the edge itself (the nginx deny rules).
export const EDGE = env.CT_BASE_URL;
export const NODE_URL = env.CT_NODE_URL;

// The staging document root, for the static source assertions.
export const SRC = process.env.CT_SRC_DIR || '/var/www/am2/staging/current/WebAdmin';
export const SERVER_JS = process.env.CT_SERVER_JS || '/var/www/am2/staging/current/server/server.js';

export function readSrc(file) {
    return fs.readFileSync(path.join(SRC, file), 'utf8');
}

/** A session, as a cookie string. Throws if the credentials do not work. */
export async function login(user, pass) {
    const res = await fetch(`${BASE}/login.php`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: HOST },
        body: new URLSearchParams({ username: user, password: pass }),
    });
    const raw = res.headers.getSetCookie?.() ?? [];
    // session_regenerate_id(true) emits two PHPSESSID cookies: one expiring the
    // old id, then the new one. The last wins, which is what a browser stores.
    const sid = raw.map((c) => c.split(';')[0])
                   .filter((c) => c.startsWith('PHPSESSID='))
                   .pop();
    if (!sid) {
        throw new Error(`login failed for ${user}: status ${res.status}, no session cookie`);
    }
    // A successful login redirects; a rejected one re-renders the form with 200.
    if (res.status !== 302) {
        const body = await res.text();
        if (!/dashboard\.php/.test(res.headers.get('location') ?? '')) {
            throw new Error(`login rejected for ${user} (status ${res.status})` +
                (/Akses Ditolak|dinonaktifkan/.test(body) ? ' — credentials refused' : ''));
        }
    }
    return sid;
}

export const asSuper = () => login(env.CT_SUPER_USER, env.CT_SUPER_PASS);
export const asBranchA = () => login(env.CT_BRANCH_A_USER, env.CT_BRANCH_A_PASS);
export const asBranchB = () => login(env.CT_BRANCH_B_USER, env.CT_BRANCH_B_PASS);

export function get(pathname, cookie, opts = {}) {
    return fetch(`${BASE}${pathname}`, {
        redirect: 'manual',
        headers: { Host: HOST, ...(cookie ? { Cookie: cookie } : {}) },
        ...opts,
    });
}

// One token per session, read out of a rendered form. Cached because every
// mutation in the suite needs it.
const csrfCache = new Map();
export async function csrfToken(cookie) {
    if (csrfCache.has(cookie)) return csrfCache.get(cookie);
    const html = await (await get('/users.php', cookie)).text();
    const m = html.match(/name="_csrf" value="([a-f0-9]+)"/);
    if (!m) throw new Error('no CSRF token in the rendered page');
    csrfCache.set(cookie, m[1]);
    return m[1];
}

export async function postForm(pathname, cookie, fields) {
    // Panel POSTs are rejected without the token, so send it unless the caller
    // is deliberately testing its absence.
    if (cookie && !('_csrf' in fields) && fields._csrf !== null) {
        fields = { ...fields, _csrf: await csrfToken(cookie) };
    }
    if (fields._csrf === null) delete fields._csrf;
    return fetch(`${BASE}${pathname}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Host: HOST,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: (() => {
            const p = new URLSearchParams();
            for (const [k, v] of Object.entries(fields)) {
                if (Array.isArray(v)) {
                    for (const item of v) p.append(k, item);
                } else {
                    p.append(k, v);
                }
            }
            return p;
        })(),
    });
}

export async function json(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`expected JSON, got ${res.status}: ${text.slice(0, 200)}`);
    }
}

/**
 * Read the staging database directly.
 *
 * Some invariants have no HTTP surface that reveals them -- whether a
 * membership is RX, which row is the default, whether users.last_channel_id
 * still names a channel the unit holds. Those are exactly the invariants the
 * three editing surfaces used to break, so the tests go to the source.
 *
 * execFileSync without a shell: the queries contain quotes, and building them
 * into a command line is how a test ends up asserting against a syntax error.
 */
export function sql(query, db = process.env.CT_DB || 'am2_staging') {
    const out = execFileSync(
        'sudo',
        ['-u', 'postgres', 'psql', '-d', db, '-tAF', '|', '--no-align', '-c', query],
        { encoding: 'utf8' }
    );
    return out.split('\n').filter((l) => l.trim() !== '').map((l) => l.split('|'));
}

/** The single row a query is expected to return, or null. */
export function sqlOne(query, db) {
    const rows = sql(query, db);
    return rows.length ? rows[0] : null;
}


/**
 * Staging carries a copy of production. Every fixture account is prefixed
 * `ct_`; everything else is somebody's real account.
 *
 * A probe that hardcoded `admin_id=1` overwrote the real superadmin's password
 * hash: the probe was written to assert a 403, but it was run against a build
 * where the guard did not exist yet, so it did what it was asking permission
 * to do. An assertion is not a safety mechanism -- it runs after the request.
 *
 * These resolve fixtures by name and refuse anything else, before the request.
 */
export function ctAdminId(username) {
    guardCtTarget(username);
    const row = sqlOne(`SELECT id FROM public.admin WHERE username = '${username}'`);
    if (!row) throw new Error(`fixture admin ${username} is missing; run contract-test-fixtures.sh`);
    return row[0];
}

/** Throw unless this names a fixture. Call it before mutating, not after. */
export function guardCtTarget(value) {
    const v = String(value ?? '');
    if (!/^ct_/i.test(v)) {
        throw new Error(
            `refusing to target "${v}": staging holds production data and only ct_* rows may be mutated`
        );
    }
    return v;
}

/** The stored hash, so a probe can put it back whatever the outcome. */
export function adminPasswordHash(username) {
    guardCtTarget(username);
    const row = sqlOne(`SELECT password_hash FROM public.admin WHERE username = '${username}'`);
    return row ? row[0] : null;
}

export function restoreAdminPasswordHash(username, hash) {
    guardCtTarget(username);
    if (!hash) return;
    sql(`UPDATE public.admin SET password_hash = '${hash}' WHERE username = '${username}'`);
}

/** Assert an object has exactly these keys — catches additions and removals. */
export function hasExactKeys(obj, keys) {
    return JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
}
