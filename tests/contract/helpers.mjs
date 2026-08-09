// Shared helpers for the contract suite.
//
// These tests are characterization tests: they record what the system does
// today so that a redesign cannot change it by accident. They are not a
// statement that today's behaviour is correct. Where it is known to be wrong,
// the test says so and names the release that will change it.
import fs from 'node:fs';
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
    const sid = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('PHPSESSID='));
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

export function postForm(pathname, cookie, fields) {
    return fetch(`${BASE}${pathname}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Host: HOST,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(fields),
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

/** Assert an object has exactly these keys — catches additions and removals. */
export function hasExactKeys(obj, keys) {
    return JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
}
