# Contract tests

These lock the current behaviour of the panel and the relay so that the
dashboard redesign cannot change it by accident. They are characterization
tests: they record what the system *does*, not what it *should* do.

Run them on the staging host, as root (the credentials file is mode 600):

```bash
cd /home/am2deploy/am2-main
node --test tests/contract/*.test.mjs
```

No dependencies — Node 22's built-in test runner and `fetch`.

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

## Two things that will bite you

**Requests go to `http://127.0.0.1:8081` with a `Host` header, not to the public
hostname.** `staging-webadmin` is proxied by Cloudflare, which caches HTML. Point
the suite at the public name and it will happily report green against a cached
copy of code you already deleted. Only the assertion about the nginx deny rules
uses the public URL, because the edge is what it is testing.

**mod_php caches compiled bytecode.** With `opcache.revalidate_freq=2`, a file
edited less than two seconds ago is still served from the old bytecode. If you
change something and the suite does not react, wait two seconds or
`systemctl reload apache2` before concluding the test is broken.

## The `KNOWN BROKEN` block

`api-and-authz.test.mjs` has a describe block that asserts behaviour which is
wrong: unauthenticated access to `api_*.php`, a tenant filter that does nothing,
a search that is a SQL syntax error, mutations with no ownership check.

Those tests exist so the security release has to change them **on purpose**, and
so nothing else changes them quietly in the meantime. When that release lands,
update the assertions. Do not delete them.

## Proving the suite works

A suite that has never failed is not evidence of anything:

```bash
sudo tests/mutation-check.sh
```

Breaks one thing at a time in the staging tree, checks a test notices, and puts
it back. Every mutation should be reported as `caught`. Anything reported as
`ESCAPED` is a gap — the first version of this suite escaped three of ten.
