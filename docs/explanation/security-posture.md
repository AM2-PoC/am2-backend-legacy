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

- The six Admin Native `/api/admin/*` routes, and all ten `api_*.php` files.
- No CSRF protection anywhere. Destructive actions are bare `GET ?delete=<id>` guarded only by a
  client-side `confirm()`.
- No `session_regenerate_id()` on login, so session fixation is possible; no idle timeout; no
  explicit cookie hardening.
- No rate limiting on `login.php` or `api_login.php`. Because bcrypt is deliberately slow, the
  latter is both a credential oracle and a cheap denial-of-service vector.
- Authorization is authentication-only in most places: a logged-in branch admin can act on another
  branch's users, because the mutation paths check *that* you are logged in but not *what you own*.
- `app.use(cors())` allows any origin.
- A stored-XSS sink in `logs.php`, which renders admin-controlled free text unescaped.
