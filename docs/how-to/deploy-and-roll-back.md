# Deploy and roll back an immutable backend artifact

Production consumes a CI-built runtime artifact. Deployment and rollback do not fetch source, install dependencies, or build on the runtime host.

## Required identity

Record before any staging or production activation:

```text
source SHA
GitHub Actions artifact ID
archive_sha256 and payload_sha256 from artifact-manifest.json
candidate, current, and rollback release paths
service PID, cwd, NRestarts, and established session count
```

A branch and tag are review/label boundaries, not deployment inputs. Activation selects one verified archive digest.

## Artifact bundle

The private cache entry is addressed by:

```text
<source_sha>/<archive_sha256>/
```

It contains exactly:

```text
am2-backend-runtime.tar.gz
artifact-manifest.json
SHA256SUMS
lockfiles/server-package-lock.json
lockfiles/webadmin-package-lock.json
```

GitHub Actions is only a bounded handoff. Accepted and rollback bytes stay in the private cache.

## Before materialization

1. Confirm exact-main source checks for the source SHA succeeded.
2. Confirm the CI artifact is not expired, then verify the cache copy:

```bash
CACHE=/var/lib/am2-artifacts/<source_sha>/<archive_sha256>
/usr/local/libexec/am2/verify-runtime-artifact.sh \
  --archive "$CACHE/am2-backend-runtime.tar.gz" \
  --manifest "$CACHE/artifact-manifest.json" \
  --checksums "$CACHE/SHA256SUMS"
```

3. Record and preflight the current rollback release:

```bash
OLD_REL=$(readlink -f /var/www/am2/current)
OLD_PID=$(systemctl show am2-api -p MainPID --value)
OLD_RESTARTS=$(systemctl show am2-api -p NRestarts --value)
sudo readlink -f "/proc/$OLD_PID/cwd"
sudo ss -Htn state established 'sport = :5000' | wc -l
sudo /usr/local/libexec/am2/verify-current-release.sh "$OLD_REL"
```

4. Take and inventory a fresh database backup. A destructive migration requires a separately approved data rollback plan.

## Materialize without source

The bounded release identity may read one immutable cache digest and create a new release. It cannot read the operator checkout or write shared update storage.

```bash
SOURCE_SHA=<40-lowercase-hex>
ARCHIVE_SHA=<64-lowercase-hex>
CACHE=/var/lib/am2-artifacts/$SOURCE_SHA/$ARCHIVE_SHA
REL=/var/www/am2/releases/artifact-$ARCHIVE_SHA

sudo -u am2release /usr/local/libexec/am2/materialize-runtime-release.sh \
  --archive "$CACHE/am2-backend-runtime.tar.gz" \
  --manifest "$CACHE/artifact-manifest.json" \
  --checksums "$CACHE/SHA256SUMS" \
  --dest "$REL" \
  --webadmin-update /var/www/am2/shared/webadmin-update \
  --server-update /var/www/am2/shared/server-update

sudo /usr/local/libexec/am2/verify-current-release.sh "$REL"
sudo /usr/local/libexec/am2/verify-materialized-artifact.sh \
  --release "$REL" --manifest "$CACHE/artifact-manifest.json"
sudo /usr/local/libexec/am2/smoke-release.sh \
  "$REL" "$SOURCE_SHA" /etc/am2/api.env
```

Materialization leaves `current` untouched. `smoke-release.sh` starts on a random loopback port, checks migrations, and must print `isolated release smoke OK`.

If an artifact contains unapplied additive migrations, apply them before any pointer switch:

```bash
"$REL/infra/scripts/apply-migrations.sh" --db am2 --dry-run
"$REL/infra/scripts/apply-migrations.sh" --db am2
# guarded activation performs: ln -sfn "$REL" /var/www/am2/current
```

## Update channels

Backend activation does not publish an Android APK. Publish a separately accepted Client artifact only through its validating publisher:

```bash
"$REL/infra/scripts/publish-field-update.sh" \
  --artifact /path/to/client-ci-artifact \
  --update-dir /var/www/am2/shared/server-update
```

Admin uses its independent `publish-admin-update.sh` channel. Never copy an APK and manifest independently.

## Required staging rehearsal

Before production, staging must run the same source SHA and exact archive and payload digests. Do not sequence pointer changes manually. The host-owned rehearsal holds the deployment lock, verifies candidate bytes, performs candidate → rollback → same-digest re-promotion, requires three stable PID/cwd/HTTP/NRestarts samples per transition, and atomically records root-owned evidence.

```bash
STAGING_REL=/var/www/am2/staging/releases/artifact-$ARCHIVE_SHA
/usr/local/libexec/am2/rehearse-staging-artifact.sh \
  --release "$STAGING_REL" \
  --manifest "$CACHE/artifact-manifest.json" \
  --allow-relay-restart
```

It prints a receipt under:

```text
/var/www/am2/staging/shared/rehearsals/
```

The receipt binds the source SHA, archive SHA-256, payload SHA-256, candidate/rollback paths, and activation/rollback/re-promotion PIDs. Run staging protocol, contract, physical-device, and update-channel acceptance after the final re-promotion.

## Production approval gate

Production promotion requires all of these:

- exact staging rehearsal receipt for the same archive digest;
- candidate and rollback host-owned preflight success;
- verified cache and materialized-byte identity;
- valid backup inventory;
- separately approved disruptive relay restart, when required;
- explicit production approval naming the source SHA, archive digest, old/new paths, session count, and rollback target.

Use the source-controlled gate rather than a hand-run checklist:

```bash
REHEARSAL_RECEIPT=/var/www/am2/staging/shared/rehearsals/<verified-receipt>
/usr/local/libexec/am2/promote-to-production.sh \
  --release "$REL" \
  --archive-sha256 "$ARCHIVE_SHA" \
  --staging-rehearsal-receipt "$REHEARSAL_RECEIPT" \
  --dry-run

# After separate production approval, rerun without --dry-run.
# Add --allow-relay-restart only when reconnect disruption is approved.
```

The gate owns `/var/lib/am2-relay-watchdog/deploy.lock`, compares canonical relay digests against the running PID cwd, requires stable readiness, writes an immutable receipt, and automatically restores the verified previous release if post-cutover validation fails.

## Post-activation verification

Require all of these before declaring success:

```text
/current resolves to the approved release
.release-sha and materialized payload match the verified manifest
running PID cwd / canonical relay digest match current runtime
am2-api is active with stable NRestarts
API root answers 200 with the PTT Server marker
WebAdmin login answers 200
anonymous protected WebAdmin APIs answer 401
Client/Admin canonical update pairs remain coherent
production database and Redis are healthy
```

Inspect service and watchdog journals for startup, dependency, authentication, or HTTP 502 errors during the bounded soak. Retain at least the accepted release and one independently verified rollback release.

## Rollback

Rollback selects retained verified bytes; rollback never rebuilds. Keep the deployment lock held, preflight the recorded rollback release, atomically restore `current`, restart only if canonical relay bytes differ, and re-run the same identity, HTTP, WebSocket/auth, database, Redis, and update-channel checks. Record both source/archive identities, paths, PIDs, timestamps, and outcome.

## Transitional operator checkout

The co-resident operator checkout may temporarily remain for chat-assisted coding and `git`/`gh` branch–PR–merge work. Deployment and rollback must not read or use that checkout, its dependencies, or source credentials. The final transition task relocates operator work and removes the VPS exception only after artifact delivery, production rollback, runbook, and drift prevention are proven.
