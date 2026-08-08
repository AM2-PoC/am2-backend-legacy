# Security posture

Explanation of how AM2 authenticates callers today, what that leaves open, and what has been
closed so far. For the endpoint-by-endpoint contract, see `docs/reference/`.

## Three callers, three different (or absent) auth models

AM2 has one database and three ways in, and only one of them authenticates.

| Caller | Entry point | How it authenticates |
|---|---|---|
| Browser (the PHP panel) | `webadmin.am2-poc.com` → Apache → `*.php` | PHP `$_SESSION`, set only by `login.php` |
| Admin Native app | `webadmin.am2-poc.com` → `api_*.php` | **Nothing.** `admin_id` and `role` are ordinary request parameters |
| AM2 field app | `apiapi.am2-poc.com` → Node | WebSocket `app_login` (bcrypt). The HTTP routes authenticate nothing |

The panel's session model is sound in outline — one place sets four session keys, and every page
checks `admin_logged_in`. Everything else is trust-by-assertion.

## Why `api_*.php` cannot simply be given session auth

The obvious fix — require a session on `api_*.php` — breaks the Admin Native app, because
`api_login.php` never issues one. It verifies the password and returns `admin_id`, `username` and
`role` as plain JSON; the app then replays those values as query parameters on every later call.
There is no session cookie and no token to present. Closing this therefore requires issuing a
credential *and* updating the app, which is why it is scheduled as its own release rather than
folded into the UI work.

## What was exposed at the edge, and what changed

`server.js` defines ten `/api/admin/*` routes and checks no credential on any of them. That was
survivable only if they were unreachable from outside — and they were not. The nginx vhost for
`apiapi.am2-poc.com` proxied every path to Node with no exclusions:

```nginx
location / {
    proxy_pass http://am2_node_api;   # 127.0.0.1:5000
}
```

The UFW rule denying port 5000 gave no protection here: nginx is the front door, and it forwarded
everything. One unauthenticated POST could disconnect any user from the PTT network, change
permissions, reassign channels, or force-refresh an entire branch.

The nginx access logs on the production host show **no external requests to `/api/admin/` at any
point in the retained window**, so there is no evidence this was ever exercised.

Four of the ten routes are only ever called by the PHP panel, which reaches Node directly over
`http://localhost:5000` rather than through nginx. Denying those at the edge therefore removes the
remote attack surface at no functional cost, and that is now in place:

```nginx
location ~* ^/api/admin/(sync-channels|refresh-branch-permissions|force-logout|update-permissions)/?$ {
    deny all;
}
```

The regex is case-insensitive and tolerates a trailing slash on purpose. Express routing defaults to
`caseSensitive: false` and `strict: false`, so `/api/admin/Force-Logout/` reaches the same handler as
`/api/admin/force-logout`; a stricter pattern would have been trivially bypassable.

The remaining six routes — `set-app-version`, `update-user-profile`, `update-channel`,
`assign-channel`, `remove-channel`, `set-permission` — are used by the Admin Native app and stay
reachable until that app can present a credential.

## Still open

One item, and it is a decision rather than an oversight.

**The Admin Native credential.** `AM2_API_AUTH_MODE` defaults to `log` in both halves
(`WebAdmin/config.php`, `server/server.js`), so an unauthenticated caller reaching the six remaining
`/api/admin/*` routes or the `api_*.php` files is recorded and then allowed through — and, having no
session, is free to claim `role=superadmin` in the request body. The mechanism that closes this is
already built and tested: key check, identity resolution, superadmin gate, structured rejection
logging, and an immediate refusal for anyone presenting a session instead.

What is missing is the switch, and flipping it is blocked outside this repository: the Admin Native
app has to ship a build that presents a key first. `tests/contract/identity.test.mjs` marks this
`KNOWN OPEN` and asserts both halves of it — the hole as it exists today, and the refusal that must
appear under `enforce`. Treat it as an accepted risk with a named owner and a release it is waiting
on, not as a bug nobody has got to.

## Closed since this document was first written

Everything below was listed as open here long after it had been fixed. That is worse than an
incomplete document: this is the page a reviewer reads first, and it understated the posture by six
items while sending anyone who trusted it to re-solve solved problems. Each line names the code that
settles it.

- **CSRF.** `am2_csrf_require()` runs in the `config.php` bootstrap; tokens are emitted per form and
  carried by the fetch paths.
- **Session fixation.** `session_regenerate_id(true)` on successful login in `login.php`.
- **Idle timeout.** `am2_expire_idle_session()`, invoked from the same bootstrap.
- **Cookie hardening.** `WebAdmin/session_boot.php` sets `HttpOnly`, `SameSite=Lax`, and `Secure`
  whenever the request arrived over HTTPS — including through nginx, via `X-Forwarded-Proto`. Every
  entry point that opens a session goes through it.
- **Login rate limiting.** In the application (`am2_login_blocked()` / `am2_login_failed()` /
  `am2_login_succeeded()`, keyed per client over a fifteen-minute window) and at the edge
  (`limit_req zone=am2_webadmin_login`, now on staging as well as production).
- **Cross-tenant authorization.** `am2_admin_owns_user()` guards the mutation paths, so a branch
  admin can no longer act on another branch's units.
- **CORS.** `server/server.js` takes an allowlist and answers `false` for anything else, replacing
  the bare `app.use(cors())`.
- **Stored XSS in the log view.** `logs.php` builds every row with `textContent`; a contract test
  fails the build if `innerHTML` returns to that file.
- **API key comparison.** Constant-time on both sides now — `hash_equals()` in PHP,
  `crypto.timingSafeEqual` in Node.
