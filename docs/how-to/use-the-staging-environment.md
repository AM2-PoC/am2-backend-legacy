# Use the staging environment

`https://staging-webadmin.am2-poc.com` runs the same backend artifact as production against a distinct database and application writable paths. It is still co-resident with production: both lanes share the runtime VPS, Redis server process/host, and deploy account until the minimum-separation follow-up closes those explicit blockers.

| | production | staging |
|---|---|---|
| database | `am2` | `am2_staging` |
| node relay | `127.0.0.1:5000` (`am2-api`) | `127.0.0.1:5001` (`am2-api-staging`) |
| apache | `127.0.0.1:8080` | `127.0.0.1:8081` |
| document root | `/var/www/am2/current/WebAdmin` | `/var/www/am2/staging/current/WebAdmin` |
| env file | `/etc/am2/webadmin.env.production` | `/etc/am2/webadmin.env.staging` |
| redis | database 0 | database 3 |

Both node ports are denied at the firewall and reachable only through nginx or from the host itself.

## How the split actually works

`config.php` reads two variables that default to production values, so an unconfigured deployment
behaves exactly as it did before staging existed:

```php
$envFile = getenv('AM2_ENV_FILE') ?: '/etc/am2/webadmin.env.production';
define('AM2_NODE_BASE', rtrim(getenv('AM2_NODE_URL') ?: 'http://localhost:5000', '/'));
```

The staging Apache vhost sets the first one:

```apache
SetEnv AM2_ENV_FILE /etc/am2/webadmin.env.staging
```

which loads the staging env file, which sets `AM2_DB_NAME=am2_staging` and
`AM2_NODE_URL=http://localhost:5001`.

`AM2_NODE_BASE` matters more than it looks. The panel notifies the relay on force-logout, channel
sync and permission changes. Before this indirection existed those URLs were hardcoded to
`localhost:5000` in eleven places across eight files — so a force-logout clicked on staging would
have disconnected a real user from the live PTT network. Staging is only safe because that constant
resolves to 5001.

## Refresh staging

Staging code is delivered from the same verified backend artifact contract as production, with distinct configuration and writable paths. Do not refresh staging from a source checkout or environment branch.

```bash
SOURCE_SHA=<40-lowercase-hex>
ARCHIVE_SHA=<64-lowercase-hex>
CACHE=/var/lib/am2-artifacts/$SOURCE_SHA/$ARCHIVE_SHA
REL=/var/www/am2/staging/releases/artifact-$ARCHIVE_SHA

sudo -u am2release /usr/local/libexec/am2/materialize-runtime-release.sh \
  --archive "$CACHE/am2-backend-runtime.tar.gz" \
  --manifest "$CACHE/artifact-manifest.json" \
  --checksums "$CACHE/SHA256SUMS" \
  --dest "$REL" \
  --webadmin-update /var/www/am2/staging/shared/webadmin-update \
  --server-update /var/www/am2/staging/shared/server-update

sudo /usr/local/libexec/am2/verify-current-release.sh "$REL"
sudo /usr/local/libexec/am2/verify-materialized-artifact.sh \
  --release "$REL" --manifest "$CACHE/artifact-manifest.json"
```

Materialization does not activate the release. Use the protected staging rehearsal path from `deploy-and-roll-back.md`; it verifies candidate → rollback → exact re-promotion under the deployment lock and records a protected receipt.

Refreshing staging data is a separate, approval-bound operation. It must use an approved backup/restore procedure, preserve confidentiality controls, and must not be coupled to code activation.

## Things worth knowing

**Staging holds real personal data.** It is a copy of production: real names, real coordinates, real
password hashes. It is served over HTTPS behind Cloudflare and carries `X-Robots-Tag: noindex`, but
it has no additional access control beyond the ordinary login. Treat it as production for
confidentiality even though its data is disposable.

**Cloudflare caches it.** `staging-webadmin` is proxied. When iterating on CSS or JS, turn on
Development Mode in the Cloudflare dashboard or you will spend time debugging a cached stylesheet.

**Restarting `am2-api-staging` is free**; restarting `am2-api` is not. Check which unit you are
about to touch.

**The certificate is separate** (`staging-webadmin.am2-poc.com`, ECDSA, renewed by the same certbot
timer as the others). It was issued over HTTP-01 through the Cloudflare proxy, which works because
nginx serves `/.well-known/acme-challenge/` from `/var/www/letsencrypt` on port 80 before the HTTPS
redirect.
