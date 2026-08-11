# Relay outage after unattended service restart — 2026-08-11

## Status

- Severity: P0
- Impact window: 2026-08-11 06:45:53–12:15:46 WIB
- User-visible failure: relay/WebSocket API unavailable; Nginx returned HTTP 502
- Recovery: a complete release was prepared and `am2-api` was restarted manually
- Follow-up owner: AM2 operations/backend

No credential values are included in this record. Runtime secrets remain `[REDACTED]`.

## Impact

During the outage window:

- Nginx recorded 13,540 HTTP 502 responses from 62 unique source IPs.
- `am2-api` logged 3,771 `Cannot find module 'dotenv'` failures.
- systemd logged 3,771 main-process exits and reached restart counter 3,770 before manual recovery.
- Android clients could not recover through force-stop, uninstall, reinstall, or retry because the upstream relay was unavailable.
- Clients whose reconnect loop remained active could return online automatically after the relay recovered, making reinstall appear causally related when it was only coincident in time.

The source-IP count is an infrastructure observation, not a count of affected users or devices.

## Timeline

All timestamps are Asia/Jakarta (WIB).

| Time | Event |
|---|---|
| 06:45:38 | `/usr/bin/unattended-upgrade` started upgrading the systemd package family from `255.4-1ubuntu8.16` to `.17`. |
| 06:45:52 | Package upgrade completed. |
| 06:45:53 | systemd stopped and restarted `am2-api.service`. |
| 06:45:53 | The new process resolved `/var/www/am2/current/server/server.js` to release `20260811004104-0840a77ac77b` and exited with `Cannot find module 'dotenv'`. |
| 06:45:58 | `Restart=on-failure` began retrying every five seconds. |
| 06:45:55–12:15:44 | Nginx returned 13,540 HTTP 502 responses. |
| 12:15:44 | The last failed start exited; systemd restart counter reached 3,770. |
| 12:15:46 | Operator restarted `am2-api` after preparing a release with runtime dependencies. Relay startup, Redis, and PostgreSQL connections succeeded. |
| 12:17 onward | WebSocket clients began reconnecting without reinstall. |

## Exact failure chain

The outage required all of these conditions:

1. The deploy mechanism moved the mutable `/var/www/am2/current` symlink for a WebAdmin-only release.
2. The active Node process continued running from the previous immutable release, so immediate HTTP checks did not prove the new `/current` target was restart-safe.
3. Release `20260811004104-0840a77ac77b` contained `server/package.json` but no `server/node_modules` production dependency closure.
4. A later unattended package operation restarted the service through `/var/www/am2/current`.
5. `server/server.js` imports `dotenv` at startup, so the process exited before binding its listener.
6. The unit had `Restart=on-failure` and `RestartSec=5` but no start-rate limit.
7. No runnable-artifact gate, isolated cold-start check, or actionable outage alert stopped the failure within minutes.

At the time of this record, the live relay PID still has:

```text
/proc/<pid>/cwd -> /var/www/am2/releases/20260810221100-650024b239c1/server
/var/www/am2/current -> /var/www/am2/releases/20260811121812-0840a77ac77b
```

That hybrid identity is direct evidence that a healthy running PID does not prove restart closure of `/current`.

## Root cause

The primary root cause was an unsafe release boundary: `/current` was allowed to reference an artifact that was valid for PHP/WebAdmin serving but incomplete for the Node service that also resolves code and dependencies through that symlink.

The unattended restart was the trigger, not the sole root cause. A crash, host reboot, operator restart, or any future package maintenance would have produced the same failure.

## Contributing factors

- The runbook documented `npm ci --omit=dev`, but deployment was not enforced by one fail-closed executable.
- Verification checked the already-running process rather than cold-starting the exact candidate path.
- WebAdmin and relay shared one release symlink despite independent restart needs.
- systemd had no `ExecStartPre` artifact validation.
- systemd had no `StartLimitIntervalSec`/`StartLimitBurst` guard.
- `needrestart` had no exact override for the realtime relay.
- Health checks and logs existed, but no bounded operator alert path was attached.
- Presence rows can remain stale after abrupt relay death; database `online` is not proof of a live authenticated socket.

## Five whys

1. **Why was PTT unavailable?** The relay process never reached its listening state.
2. **Why did it never listen?** Node could not resolve `dotenv` from the selected release.
3. **Why was an incomplete release selected?** Promotion did not enforce production dependency closure for every service behind `/current`.
4. **Why did the problem appear hours after deploy?** The old PID retained the previous release until unattended maintenance restarted it through the new symlink.
5. **Why did the outage last hours?** Unlimited five-second restart attempts produced no recovery, and no alert/automatic rollback gate bounded MTTR.

## Corrective actions and acceptance criteria

P0 is complete only when evidence proves all of the following:

- An invalid release cannot become `/current` through the supported deploy command.
- Missing production dependencies fail before symlink swap.
- The exact candidate passes an isolated cold start on a loopback port before promotion.
- The rollback target is validated before any cutover.
- systemd performs a read-only preflight and attempts no more than three starts in five minutes.
- unattended maintenance defers relay restart to a controlled maintenance window.
- An operator receives an actionable alert within two minutes of health failure or restart growth.
- Staging restart and rollback rehearsal pass for the exact candidate SHA.
- A controlled production restart either becomes healthy within 60 seconds or rolls back within five minutes.
- WebAdmin-only deployment leaves the relay PID unchanged.
- Post-cutover soak shows no new HTTP 502, startup fatal, dependency error, or restart growth.

## Immediate guardrails

Until the corrective-action PR is merged and staged:

- Do not move `/var/www/am2/current` without proving relay dependency closure in the candidate.
- Do not restart production `am2-api` while established sessions are nonzero unless an explicit disruption window is approved.
- Do not mutate an immutable failed release in place; create a new release directory.
- Do not treat successful PHP/login-page probes or the old running PID as proof that the candidate relay can restart.
- Keep the known runnable rollback release until production restart closure is proven.

## Evidence commands

These are read-only except where explicitly used later in the controlled runbook:

```bash
sudo journalctl -u am2-api \
  --since '2026-08-11 06:45:30' --until '2026-08-11 12:16:00' --no-pager
sudo zgrep -h -A5 -B2 'Start-Date: 2026-08-11  06:45:38' /var/log/apt/history.log*
readlink -f /var/www/am2/current
systemctl show am2-api -p MainPID -p NRestarts -p ExecMainStartTimestamp
sudo readlink -f /proc/"$(systemctl show am2-api -p MainPID --value)"/cwd
```

## Scope boundary

This incident confirms one server-side cause for devices that remained offline through reinstall and recovered after several hours. It does not prove that every historical update-related offline case has the same cause. APK package-replacement, service lifecycle, authentication state, backup restore, and reconnect diagnostics remain a separate P1 investigation after restart-safe server containment.
