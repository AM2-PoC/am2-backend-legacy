# Security posture

Explanation of how AM2 authenticates callers today, what that leaves open, and what has been
closed so far. For the endpoint-by-endpoint contract, see `docs/reference/`.

## Three callers, three different (or absent) auth models

AM2 has one database and three ways in, and only one of them authenticates.

| Caller | Entry point | How it authenticates |
|---|---|---|
| Browser (the PHP panel) | `webadmin.am2-poc.com` → Apache → `*.php` | PHP `$_SESSION`, set only by `login.php` |
| Admin Native app | `webadmin.am2-poc.com` → `api_*.php` | The same PHP session, carried in a cookie jar, with a CSRF token on writes |
| AM2 field app | `apiapi.am2-poc.com` → Node | WebSocket `app_login` (bcrypt). The HTTP routes authenticate nothing |

The panel's session model is sound in outline — one place sets four session keys, and every page
checks `admin_logged_in`. Everything else is trust-by-assertion.

## How `api_*.php` came to have session auth after all

This section used to explain why it could not: `api_login.php` verified the password and returned
`admin_id`, `username` and `role` as plain JSON, and the app replayed those values as query
parameters on every later call. No cookie, no token, nothing to require.

Both halves have since shipped. `api_login.php` issues a session (`am2_session_login()`) and hands
back a CSRF token; Admin Native has carried a cookie jar, a CSRF interceptor and a 401 handler since
build 83. So requiring a session on `api_*.php` broke nothing and needed no handset release — the
app had been ready for months while the panel was configured not to ask.

That gap is the lesson worth keeping. The credential was built, tested and deployed on both sides,
and a single word in one env file meant none of it ran.

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

Nothing in the authentication path. The item that stood here — the Admin Native credential — is
closed; see below. Two adjacent items remain and are tracked elsewhere:

- **One session store for two lanes.** Production (`127.0.0.1:8080`) and staging (`:8081`) share
  `/var/lib/php/sessions` with no per-vhost override, so a session id obtained on staging is a valid
  session id on production. Differing cookie domains stop a browser carrying one across; nothing
  stops `curl`. `infra/scripts/install-webadmin-guard.sh --drain-sessions` splits the store, and it
  signs every operator out, so it is held for a window rather than done in passing.
  Written down as a task in
  `.hermes/plans/2026-08-19_004859-minimum-environment-separation.md`.
- **Two writers on six tables.** The relay and the panel both write `users`, `user_channels`,
  `device_tokens`, `user_app_permissions`, `ptt_logs` and `admin_activity_logs`, and they overlap on
  `users.current_channel` and `users.force_logout`. Not an authentication problem; its own scope.

## Closed since this document was first written

Everything below was listed as open here long after it had been fixed. That is worse than an
incomplete document: this is the page a reviewer reads first, and it understated the posture by six
items while sending anyone who trusted it to re-solve solved problems. Each line names the code that
settles it.

- **CSRF.** `am2_csrf_require()` runs in the `config.php` bootstrap; tokens are emitted per form and
  carried by the fetch paths.
- **Session fixation.** `session_regenerate_id(true)` on successful login, via `am2_session_login()`,
  and `session.use_strict_mode=1` in `am2_session_boot()` so a session id the caller invented is
  never adopted in the first place.
- **Claimed identity.** `am2_api_identity()` reads `$_SESSION` and nothing else. Appending
  `&role=superadmin` to a request changes nothing; a caller with no session is refused before the
  endpoint runs, by `am2_require_identity()` in the `config.php` bootstrap.
- **A control that could be switched off.** There is no auth mode, in either half. A missing or
  wrong credential is refused, always, and no environment variable changes that — asserted by
  absence across the tree in `tests/unit/auth-single-identity.test.mjs`.
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
