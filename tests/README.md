# Contract tests

These lock the current behaviour of the panel and the relay so that the
dashboard redesign cannot change it by accident. They are characterization
tests: they record what the system *does*, not what it *should* do.

Source-only contract checks run in clean-room CI or on an isolated development
machine. Staging-facing checks require an explicitly approved non-production
runner. Never run tests from the runtime VPS or its co-resident operator
checkout.

No dependencies — Node's built-in test runner and `fetch`.

## First-time setup

```bash
sudo infra/scripts/contract-test-fixtures.sh
```

Creates `ct_super`, `ct_branch_a`, `ct_branch_b` and three users in
`am2_staging`, and writes `/etc/am2/contract-test.env`. It never touches
existing rows and refuses to run against any database but `am2_staging`.

## What is covered

| File | Covers |
|---|---|
| `panel-endpoints.test.mjs` | The four panel pages that are also JSON endpoints, and the session guards |
| `api-and-authz.test.mjs` | The ten `api_*.php` response shapes, the node routes, tenant scoping |
| `source-and-markup.test.mjs` | Form field dispatch names, websocket message types, `data-label` coverage, the id families queried by prefix selector, leaflet divIcon classes |

## Test execution

- Requests use the staging loopback endpoint with an explicit `Host` header; public Cloudflare endpoints may serve cached HTML.
- Protocol tests run serially because they share fixture identities and sessions.
- `app_login` authenticates a socket; tests must send `join_channel` before asserting media relay.

## Protocol harness

```bash
sudo infra/scripts/ptt-harness-fixtures.sh   # once
./tests/run-protocol.sh
```

Run the wrapper serially; all protocol files share fixture identities, and concurrent logins invalidate earlier sockets.

Two WebSocket clients sign in, join a channel, key the mic, relay a real audio
frame and release it, against the staging relay on 5001. This is the surface
`ws` sits directly under, so run it before and after any change to that package.

`app_login` authenticates but does not put a socket in a room — the client must
send `join_channel`. Without it, audio goes nowhere and every relay assertion
fails for a reason that looks like a broken relay.
