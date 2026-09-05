# Use the staging environment

`https://staging-webadmin.am2-poc.com` uses the same backend artifact contract as production, with a distinct database and application writable paths. A candidate normally reaches staging first; production receives the exact digest accepted in staging.

Staging remains co-resident with production. Both lanes share the runtime VPS, Redis server process/host, and deploy account until the minimum-separation follow-up closes those explicit blockers.

| | production | staging |
|---|---|---|
| database | `am2` | `am2_staging` |
| node relay | `127.0.0.1:5000` (`am2-api`) | `127.0.0.1:5001` (`am2-api-staging`) |
| apache | `127.0.0.1:8080` | `127.0.0.1:8081` |
| document root | `/var/www/am2/current/WebAdmin` | `/var/www/am2/staging/current/WebAdmin` |
| env file | `/etc/am2/webadmin.env.production` | `/etc/am2/webadmin.env.staging` |
| redis | database 0 | database 3 |
| session store | `/var/lib/php/sessions/am2` | `/var/lib/php/sessions/am2-staging` |

Both Node ports are host-local. Nginx is the public edge. The staging WebAdmin environment resolves its database and relay through `/etc/am2/webadmin.env.staging`; relay callbacks target `127.0.0.1:5001`.

## Materialize a staging candidate

Do not refresh staging from a source checkout or environment branch. Export exact immutable identities first:

```bash
: "${SOURCE_SHA:?export the exact 40-character source SHA}"
: "${ARCHIVE_SHA:?export the exact 64-character archive SHA-256}"
CACHE=/var/lib/am2-artifacts/$SOURCE_SHA/$ARCHIVE_SHA
REL=/var/www/am2/staging/releases/artifact-$ARCHIVE_SHA

sudo -u am2release /usr/local/libexec/am2/materialize-runtime-release.sh \
  --archive "$CACHE/am2-backend-runtime.tar.gz" \
  --manifest "$CACHE/artifact-manifest.json" \
  --checksums "$CACHE/SHA256SUMS" \
  --dest "$REL" \
  --webadmin-update /var/www/am2/staging/shared/webadmin-update \
  --server-update /var/www/am2/staging/shared/server-update

sudo -u am2release /usr/local/libexec/am2/verify-current-release.sh "$REL"
sudo -u am2release /usr/local/libexec/am2/verify-materialized-artifact.sh \
  --release "$REL" --manifest "$CACHE/artifact-manifest.json"
```

Materialization does not activate the release. Use the protected staging rehearsal path documented in `deploy-and-roll-back.md`. It owns the deployment lock, verifies candidate → rollback → exact re-promotion, and writes a protected receipt.

A staging activation or restart requires explicit approval. Re-run WebAdmin login/session/CSRF, representative Admin API, WebSocket/auth, update-channel, service cwd/digest, and `NRestarts` checks after each transition.

## Data and confidentiality

Refreshing staging data is separate from code activation and requires an approved backup/restore procedure. Staging may contain production-derived personal data, so apply production-equivalent confidentiality controls even when the data is disposable.

Cloudflare proxies the staging domains. Account for edge cache behavior when checking static assets, while keeping update manifest/APK routes canonical and `no-store`.
