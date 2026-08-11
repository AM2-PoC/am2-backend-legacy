# Deploy a restart-safe release, and roll it back

Production is an immutable release directory selected by `/var/www/am2/current`. Apache and `am2-api` both resolve that symlink, so every selected release must be runnable by both services even when a change appears PHP-only. Never edit a release in place.

```text
/var/www/am2/
├── current -> releases/<stamp>-<sha12>
├── releases/<stamp>-<sha12>/
├── shared/
└── staging/
```

## Non-negotiable invariants

- Build from an exact 40-character commit SHA, never an implicit moving branch.
- Do not move `/current` until dependency preflight and isolated cold start pass on the exact candidate.
- Validate the rollback release before cutover.
- A healthy old PID is not candidate evidence: compare `/proc/<pid>/cwd` with `/current/server`.
- Restarting the relay drops every WebSocket. Require a quiet window or explicit session-drain approval.
- Invalid candidates stay outside `/current`; failed builds are discarded, not repaired in place.
- Runtime secrets stay in protected `/etc/am2/*.env` files and are represented in documentation as `[REDACTED]`.

## One-time host containment

Install source-controlled policy and health artifacts. This does not restart `am2-api`:

```bash
sudo install -D -m 0644 infra/needrestart/am2-realtime.conf \
  /etc/needrestart/conf.d/am2-realtime.conf
sudo install -D -m 0755 infra/scripts/check-relay-health.sh \
  /usr/local/libexec/am2/check-relay-health.sh
sudo install -D -m 0755 infra/scripts/send-relay-alert.sh \
  /usr/local/libexec/am2/send-relay-alert.sh
sudo install -D -m 0644 infra/systemd/am2-relay-watchdog.service \
  /etc/systemd/system/am2-relay-watchdog.service
sudo install -D -m 0644 infra/systemd/am2-relay-watchdog.timer \
  /etc/systemd/system/am2-relay-watchdog.timer
sudo install -D -m 0644 infra/systemd/am2-relay-alert@.service \
  /etc/systemd/system/am2-relay-alert@.service
sudo systemctl daemon-reload
sudo systemctl enable --now am2-relay-watchdog.timer
```

Configure an absolute executable `AM2_ALERT_COMMAND` in `/etc/am2/relay-watchdog.env`. The command receives one message argument and must notify the on-call operator. Without it, the fallback is local journald only and the two-minute operator-notification acceptance criterion is not met.

The needrestart override defers only the exact `am2-api.service` and `am2-api-staging.service` names. A controlled maintenance window must later restart them when required by package updates.

## Pre-deploy evidence

Take and validate a database dump:

```bash
sudo systemctl start am2-backup.service
DUMP=$(ls -1t /var/backups/am2/postgres/*.dump | head -1)
sudo -u postgres pg_restore -l "$DUMP" | grep -c 'TABLE DATA'
```

Record live identity and sessions before cutover:

```bash
OLD_REL=$(readlink -f /var/www/am2/current)
OLD_PID=$(systemctl show am2-api -p MainPID --value)
OLD_RESTARTS=$(systemctl show am2-api -p NRestarts --value)
sudo readlink -f "/proc/$OLD_PID/cwd"
sudo ss -Htn state established 'sport = :5000' | wc -l
```

If PID cwd differs from `$OLD_REL/server`, record the hybrid state. Do not use that old PID as evidence that `$OLD_REL` or a new candidate can cold-start.

## Build exact immutable candidates

Fetch, pin, and build production with runtime links already sealed into the candidate:

```bash
sudo -u am2deploy git -C /home/am2deploy/am2-main fetch origin
SHA=$(git -C /home/am2deploy/am2-main rev-parse origin/main^{commit})
STAMP=$(date +%Y%m%d%H%M%S)
REL=/var/www/am2/releases/${STAMP}-${SHA:0:12}

sudo -u am2deploy /home/am2deploy/am2-main/infra/scripts/build-release.sh \
  --repo /home/am2deploy/am2-main \
  --sha "$SHA" \
  --dest "$REL" \
  --webadmin-update /var/www/am2/shared/webadmin-update \
  --server-update /var/www/am2/shared/server-update
```

The builder uses `git archive`, writes `.release-sha`, runs `npm ci --omit=dev`, validates JavaScript syntax and every declared production dependency, then atomically publishes the directory. It refuses an existing destination and removes failed temporary output.

Build staging separately from the same SHA:

```bash
STAGING_REL=/var/www/am2/staging/releases/${STAMP}-${SHA:0:12}
sudo -u am2deploy /home/am2deploy/am2-main/infra/scripts/build-release.sh \
  --repo /home/am2deploy/am2-main \
  --sha "$SHA" \
  --dest "$STAGING_REL" \
  --webadmin-update /var/www/am2/staging/shared/webadmin-update \
  --server-update /var/www/am2/staging/shared/server-update
```

If staging shared paths differ, inspect existing links and pass those exact absolute directories. Do not guess or reuse production data.

## Preflight, smoke, migration

Validate candidate and rollback target:

```bash
"$REL/infra/scripts/verify-release-runtime.sh" "$REL" "$SHA"
OLD_SHA=$(tr -d '\r\n' < "$OLD_REL/.release-sha")
"$OLD_REL/infra/scripts/verify-release-runtime.sh" "$OLD_REL" "$OLD_SHA"
```

Cold-start the exact candidates using protected environment files and random loopback ports:

```bash
"$REL/infra/scripts/smoke-release.sh" "$REL" "$SHA" /etc/am2/api.env
"$STAGING_REL/infra/scripts/smoke-release.sh" \
  "$STAGING_REL" "$SHA" /etc/am2/api.staging.env
```

Smoke must return `isolated release smoke OK`. It traps and removes its child relay. It never prints protected environment values.

Dry-run migrations first, apply to staging, then production before code swap:

```bash
"$REL/infra/scripts/apply-migrations.sh" --db am2 --dry-run
"$STAGING_REL/infra/scripts/apply-migrations.sh" --db am2_staging
"$REL/infra/scripts/apply-migrations.sh" --db am2
```

Current migrations are additive. A future destructive migration requires a separate database rollback plan and cannot rely on symlink rollback.

## Required staging restart and rollback rehearsal

```bash
STAGING_OLD=$(readlink -f /var/www/am2/staging/current)
sudo ln -sfn "$STAGING_REL" /var/www/am2/staging/current
sudo systemctl reset-failed am2-api-staging
sudo systemctl restart am2-api-staging
curl -fsS http://127.0.0.1:5001/ | grep -F 'PTT Server'
systemctl show am2-api-staging -p ActiveState -p NRestarts -p MainPID
```

Rehearse rollback, then re-promote candidate:

```bash
sudo ln -sfn "$STAGING_OLD" /var/www/am2/staging/current
sudo systemctl restart am2-api-staging
curl -fsS http://127.0.0.1:5001/ | grep -F 'PTT Server'

sudo ln -sfn "$STAGING_REL" /var/www/am2/staging/current
sudo systemctl restart am2-api-staging
curl -fsS http://127.0.0.1:5001/ | grep -F 'PTT Server'
```

Run staging contract/protocol tests after the final candidate restart. Do not proceed if any restart, dependency, protocol, or HTTP check fails.

## Production cutover

First determine whether `server/`, systemd, or relay scripts changed:

```bash
git -C /home/am2deploy/am2-main diff --quiet "$OLD_SHA" "$SHA" -- \
  server infra/systemd infra/scripts infra/needrestart
```

For a WebAdmin-only change, swap and reload Apache; verify the relay PID is unchanged:

```bash
BEFORE_PID=$(systemctl show am2-api -p MainPID --value)
sudo ln -sfn "$REL" /var/www/am2/current
sudo systemctl reload apache2
AFTER_PID=$(systemctl show am2-api -p MainPID --value)
test "$BEFORE_PID" = "$AFTER_PID"
```

When relay-related files changed, require the approved quiet window and verify established session count is at the agreed drain threshold. Then:

```bash
sudo install -m 0644 "$REL/infra/systemd/am2-api.service" \
  /etc/systemd/system/am2-api.service
sudo systemctl daemon-reload
sudo ln -sfn "$REL" /var/www/am2/current
sudo systemctl reload apache2
sudo systemctl reset-failed am2-api
sudo systemctl restart am2-api
```

The service preflight validates the exact `/current` release before Node executes. The unit permits no more than three failed starts in five minutes.

## Verify and automatic rollback decision

Within 60 seconds:

```bash
systemctl is-active am2-api nginx apache2 postgresql redis-server
curl -fsS http://127.0.0.1:5000/ | grep -F 'PTT Server'
sudo /usr/local/libexec/am2/check-relay-health.sh
NEW_PID=$(systemctl show am2-api -p MainPID --value)
sudo readlink -f "/proc/$NEW_PID/cwd"
readlink -f /var/www/am2/current
systemctl show am2-api -p NRestarts
```

Also verify public login/API probes, one authenticated read, one safe write, WebSocket login, channel join, heartbeat, and one PTT transmit/release path.

Rollback immediately if health is not green within 60 seconds, startup fatals appear, restart count grows, PID cwd differs from `/current/server`, or client protocol checks fail. Target rollback completion is five minutes:

```bash
sudo ln -sfn "$OLD_REL" /var/www/am2/current
sudo systemctl reload apache2
sudo systemctl reset-failed am2-api
sudo systemctl restart am2-api
sudo /usr/local/libexec/am2/check-relay-health.sh
```

## Soak and evidence retention

For at least 15 minutes after cutover, record:

```bash
systemctl show am2-api -p NRestarts -p MainPID -p ActiveEnterTimestamp
sudo journalctl -u am2-api --since '<cutover timestamp>' --no-pager
sudo journalctl -u am2-relay-watchdog --since '<cutover timestamp>' --no-pager
```

Confirm zero new dependency errors, startup fatals, restart growth, watchdog failures, and HTTP 502 responses. Preserve candidate SHA, release path, rollback path, dump path, session count, PID/cwd, test output, and cutover/rollback timestamps in the deployment record.

Keep at least the last three validated runnable releases. Never delete the last known-good rollback target while production restart closure is unproven.
