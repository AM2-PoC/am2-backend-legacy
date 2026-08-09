# Enforce the API key

`AM2_API_AUTH_MODE` decides what happens to a request that reaches an `api_*.php` file or an
`/api/admin/*` route without a valid key and without a panel session.

| Mode | Behaviour |
|---|---|
| `log` (default) | Record `REJECT-CANDIDATE` and **let the request through** |
| `enforce` | Record it and answer `401` |

Under `log`, an anonymous caller can still claim `role=superadmin` in the request. That is the open
hole, and it is deliberate: the Admin Native app cannot present a key until it ships a build that
has one, and refusing it before then would take the field units offline.

This document is how to close it without guessing.

## Why not just flip it

Because the callers are field devices, and nobody can survey them directly. The only way to know
what would break is to watch what the switch *would* have rejected — which is exactly what `log`
mode is for.

The mistake to avoid is reading a quiet log as a safe answer. Checked on 2026-08-09, production was
serving a release from 3 May 2026 that contained no auth check at all: its error log had zero
`REJECT-CANDIDATE` lines, and that said nothing whatsoever about traffic. An empty report from a
release that cannot produce entries is not evidence.

## The sequence

**1. Ship the check in `log` mode.** Deploy a release containing `am2_api_auth()` with
`AM2_API_AUTH_MODE` unset or `log`. Nothing is refused; rejections start being recorded.

**2. Wait, and include a quiet weekend.** A device that syncs weekly will not appear in three days
of logs. Apache logs here retain about a week, so run the report before the window rotates past the
interesting period.

**3. Read the report.**

```bash
sudo infra/scripts/api-auth-report.sh              # production
sudo infra/scripts/api-auth-report.sh --env staging
```

It answers three things in order: whether the deployed release can record at all, who has been
rejected, and how recently. Read it in that order — the first line decides whether the rest means
anything.

Two things it separates for you, because both have already caused a misreading:

- **This repository's own contract suite** calls every one of these endpoints from `127.0.0.1` as
  `ua=node`. On the first run, 486 rejections turned out to be a test run from four minutes earlier.
- **Dates.** Sixty rejections of `api_dashboard_chart.php` from real browsers looked like proof
  that `enforce` would break the panel's own dashboard. They were all from before the session-aware
  path landed; browsers have called that endpoint hundreds of times since without a single new
  rejection. A count without a date cannot tell a live problem from a fixed one.

**4. Flip it, per environment, staging first.**

```
AM2_API_AUTH_MODE=enforce
```

in `/etc/am2/webadmin.env.<environment>` and `/etc/am2/api.<environment>.env`, then
`sudo systemctl reload apache2` and `sudo systemctl restart am2-api`.

Both halves read the same variable independently. Setting one and not the other leaves the other
open, which is the failure that looks like success.

**5. Watch the same report for a day.** Under `enforce` the `REJECT-CANDIDATE` lines keep being
written — they now describe requests that actually failed. Any new entry is a caller you missed.

## Rolling back

Set the variable back to `log` and reload. There is no state to unwind: the mode is read per
request, so the next request after the reload behaves the old way.

## What "ready" looks like

- The report's first line says the check is **PRESENT** in the deployed release
- No non-test caller in a window long enough to include the slowest thing that talks to this system
- The Admin Native build that presents a key is out and adopted — not merely released

The third is the one that is not visible from this server. It needs the mobile side to confirm
adoption, and a build that is shipped but not installed is the same as no build at all.
