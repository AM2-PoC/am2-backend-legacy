import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The relay's admin surface, and why it is this small.
 *
 * These routes take an id straight out of the request and write it:
 *
 *     const { userId, channelId, permission } = req.body;
 *     await pool.query(`INSERT INTO public.user_channels ...`, [uid, channelId, ...]);
 *
 * Nothing checks that the caller is entitled to that user or that channel. The
 * relay has no notion of who is asking at all -- it holds one shared key, and
 * whoever presents it may act on any user in any branch.
 *
 * That is a defensible layering only because the panel does the scoping before
 * it calls: `am2_admin_owns_user()` compares the target against the *session's*
 * admin, and the relay is reached over localhost with a key that never leaves
 * the server. The layering, not the route, is what makes it safe -- so every
 * route on this surface has to be one the panel actually calls.
 *
 * Six were not. They were dead code with an unauthenticated write path into the
 * database, reachable from the internet until the key was enforced, and the
 * panel had never called any of them: it manages user_channels directly, with
 * the ownership check the relay lacks.
 *
 * Enforcing a key on a route nobody calls only moves the risk to "do not leak
 * the key". Deleting it removes the risk.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const routes = readFileSync(join(ROOT, 'server', 'lib', 'routes.js'), 'utf8');
const server = readFileSync(join(ROOT, 'server', 'server.js'), 'utf8');

/**
 * The whole /api/admin guard, however long its reasoning grows.
 *
 * Sliced by its own braces rather than a character count, because a comment
 * added inside it should not be able to push an assertion out of view -- which
 * is exactly what happened the first time this was written.
 */
function adminMiddleware() {
    const start = server.indexOf("app.use('/api/admin'");
    const end = server.indexOf('\n});', start);
    return server.slice(start, end);
}

/** Every /api/admin/* route the relay still exposes. */
function adminRoutes() {
    return [...routes.matchAll(/app\.(?:get|post)\('\/api\/admin\/([a-z-]+)'/g)].map((m) => m[1]);
}

test('the surface is exactly what the panel calls', () => {
    // WebAdmin reaches the relay through node_client.php and nowhere else.
    // These four are what it sends; anything beyond them has no caller.
    const called = ['sync-channels', 'force-logout', 'refresh-branch-permissions', 'update-permissions'];
    const exposed = adminRoutes().sort();
    assert.deepEqual(
        exposed, [...called].sort(),
        'the relay exposes an admin route the panel never calls: an unscoped '
        + 'write path kept alive by a key rather than by a purpose',
    );
});

test('no route writes a channel assignment', () => {
    // The panel owns this, with the branch check the relay cannot make.
    assert.doesNotMatch(routes, /INSERT INTO public\.user_channels/,
        'the relay writes channel membership without knowing who asked');
    assert.doesNotMatch(routes, /DELETE FROM public\.user_channels/,
        'the relay removes channel membership without knowing who asked');
});

test('the key is not accepted in a query string', () => {
    /*
     * A query string is not a private place. It lands in the access log of
     * every proxy in front of it, in browser history, and in the Referer of the
     * next request. A credential that travels there is a credential that has
     * been written down in several places nobody is guarding.
     *
     * The header is the only way in, and the only caller already uses it.
     */
    const middleware = adminMiddleware();
    assert.doesNotMatch(
        middleware,
        /req\.query\.api_key/,
        'the admin key may be presented in a URL, where it will be logged',
    );
    assert.match(middleware, /X-AM2-Api-Key/);
});

test('the surviving routes still fail closed without a key', () => {
    const middleware = adminMiddleware();
    assert.match(middleware, /401/, 'an unauthenticated caller is not refused');
    assert.match(middleware, /sameKey/, 'the key is not compared in constant time');
    assert.match(server, /timingSafeEqual/, 'the comparison is not constant time');
});
