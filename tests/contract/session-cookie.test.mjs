// One session cookie per login.
//
// A login that issues two PHPSESSID cookies is legal HTTP and a browser copes:
// RFC 6265 replaces by (name, domain, path) in order, so the last one wins and
// the first is forgotten. A hand-written cookie store need not, and the Admin
// Native app's did not -- it kept both, replayed both, and PHP honoured the
// first, which is the id session_regenerate_id() had just deleted. The app was
// then anonymous for the life of that login, at roughly one login in two.
//
// The whole contract suite stayed green through it because helpers.mjs did what
// a browser does and took the last cookie. That is the right thing for a test
// client and the reason this file asserts on the wire instead: what is issued,
// not what a well-behaved client makes of it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, HOST, env } from './helpers.mjs';

/** Every PHPSESSID cookie a response issues, in the order the server sent them. */
function sessionCookies(res) {
    return (res.headers.getSetCookie?.() ?? [])
        .filter((c) => c.startsWith('PHPSESSID='))
        .map((c) => c.split(';')[0]);
}

const formLogin = (path, body) => fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: HOST },
    body: new URLSearchParams(body),
});

const creds = { username: env.CT_SUPER_USER, password: env.CT_SUPER_PASS };

/** Signed in, decided by a page that redirects when it is not. */
async function signedIn(cookieHeader) {
    const res = await fetch(`${BASE}/dashboard.php`, {
        redirect: 'manual',
        headers: { Host: HOST, Cookie: cookieHeader },
    });
    return res.status === 200;
}

describe('the login response', () => {
    for (const path of ['/api_login.php', '/login.php']) {
        test(`${path} issues exactly one session cookie`, async () => {
            const issued = sessionCookies(await formLogin(path, creds));
            assert.equal(issued.length, 1,
                `${path} issued ${issued.length} PHPSESSID cookies: ${issued.join(' | ')}`);
        });

        test(`${path} signs the caller in whichever issued cookie is replayed first`, async () => {
            // The failure this reproduces: a client that keeps every cookie the
            // login issued and replays them all. PHP reads the first PHPSESSID
            // in the header, so an order that puts a dead id first must not be
            // able to exist -- which it cannot once only one is issued.
            const issued = sessionCookies(await formLogin(path, creds));
            assert.ok(issued.length > 0, `${path} issued no session cookie at all`);

            for (const order of [issued, [...issued].reverse()]) {
                assert.ok(await signedIn(order.join('; ')),
                    `${path}: replaying ${order.join('; ')} was not signed in`);
            }
        });
    }
});
