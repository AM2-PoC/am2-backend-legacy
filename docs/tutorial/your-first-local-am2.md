# Your first local AM2

A lesson, not a reference. Follow it from start to finish on your own development
machine. You will run AM2, make a harmless local change, verify its effect, and
see the panel refuse an unauthenticated request.

Allow roughly twenty minutes for the first image pull and build. You need Docker
but do not need a separate server or local PostgreSQL/PHP/Redis installation.

> **Development boundary:** do not follow this tutorial on a staging or
> production workload host. Docker containers do not make development on a
> production host safe. Use a workstation or an approved disposable
> non-production runner. The included rows and credentials are synthetic and
> must never be replaced with production data or secrets.

---

## What Docker is doing

AM2 currently needs four cooperating services:

```text
PostgreSQL 16 ← durable synthetic development data
Redis 7       ← development runtime state
Node relay    ← HTTP control routes and raw WebSocket/PTT protocol
PHP panel     ← current WebAdmin
```

`docker-compose.yml` defines their network, health checks, named volumes and
host ports. This Compose stack represents the current development baseline; it
does not contain any planned replacement stack until that implementation lands.

---

## Step 1 — install Docker once

Use Docker Desktop on Windows or macOS. On Linux, install Docker Engine and the
Compose plugin according to the official Docker documentation for your
distribution.

Check both commands from a terminal:

```sh
docker --version
docker compose version
```

Both must print a version. If only the old `docker-compose` executable exists,
install the current Compose plugin rather than silently mixing both syntaxes.

Official installation pages:

- Windows: <https://docs.docker.com/desktop/setup/install/windows-install/>
- macOS: <https://docs.docker.com/desktop/setup/install/mac-install/>
- Linux: <https://docs.docker.com/engine/install/>

---

## Step 2 — clone and identify your environment

Clone the repository onto the workstation, enter it, and verify the checkout:

```sh
git clone https://github.com/AM2-PoC/am2-backend-legacy.git
cd am2-backend-legacy
git status --short --branch
```

The repository may require GitHub access. If HTTPS authentication is not
configured, use your organization-provided SSH clone URL instead.

Do not continue if the checkout is on a production workload host or if `.env`
contains real credentials. Ask an operator if you cannot positively identify
the environment.

---

## Step 3 — create local configuration

Copy the example configuration:

```sh
cp .env.example .env
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
```

The defaults are development-only. Change host ports in `.env` if another local
service already uses them:

```dotenv
DB_PORT=5433
REDIS_PORT=6380
RELAY_PORT=5000
WEBADMIN_PORT=8080
```

Do not copy an environment file from staging or production.

The current Compose file publishes its four host ports on every workstation
interface. Its demo database password, API key and panel credentials are known
development values. Run it only on a trusted workstation network with a local
firewall; never on public Wi-Fi without isolation, a publicly reachable host,
or a shared server. Binding the Compose ports to loopback is tracked as a
separate hardening change because this tutorial must describe current `main`,
not pretend the binding is already safe.

Validate the fully resolved Compose model before starting anything:

```sh
docker compose config --quiet
```

Expected: no output and exit status 0.

---

## Step 4 — start the local stack

```sh
docker compose up --build
```

Leave this terminal open. The first run pulls PostgreSQL and Redis, builds the
relay and WebAdmin images, and seeds a new PostgreSQL volume.

In a second terminal, inspect readiness:

```sh
docker compose ps
docker compose logs --tail=100 db redis relay webadmin
```

Expected:

- all four services are running;
- `db`, `redis`, and `relay` become healthy;
- the relay does not restart repeatedly;
- there are no schema or authentication bootstrap errors.

A quiet log is not sufficient evidence by itself; use the health/status output.

---

## Step 5 — sign in using synthetic accounts

Open <http://localhost:8080>.

| Account | Password | Expected scope |
|---|---|---|
| `demo_super` | `devpassword123` | all synthetic rows |
| `demo_branch` | `devpassword123` | its own synthetic branch |

Sign in as `demo_super`, inspect the unit roster, then sign out and sign in as
`demo_branch`. The branch account must see a smaller tenant-scoped result.

The human-facing `demo_*` subset contains two admins, two channels, and three
units. The seed directory also adds isolated `ct_*` accounts, channels and
units for the protocol/contract harness; a fresh volume therefore has at least
four admins, five channels and seven units in total. `DEMO_UNIT_3` deliberately
has no default channel so the empty/default-channel edge case remains visible.

If these accounts fail on a fresh volume, stop and inspect seed/container logs;
do not point the application at another database as a shortcut.

---

## Step 6 — verify fail-closed authentication

From another terminal, call a JSON endpoint without a session:

```sh
curl -i -H 'Accept: application/json' \
  http://localhost:8080/api_get_users.php
```

Expected:

```text
HTTP/1.1 401 Unauthorized
```

Then request an authenticated browser page without a session:

```sh
curl -i -H 'Accept: text/html' -H 'Sec-Fetch-Dest: document' \
  http://localhost:8080/dashboard.php
```

Expected:

```text
HTTP/1.1 302 Found
Location: login.php
```

Finally, verify that a library accidentally reachable through the document root
is also guarded:

```sh
curl -i -H 'Accept: application/json' \
  http://localhost:8080/config.php
```

Expected: HTTP 401. Do not weaken authentication locally to make these commands
return data; local development must not teach behavior that production rejects.

---

## Step 7 — make and revert a harmless local edit

Create a temporary branch before editing:

```sh
git switch -c tutorial/local-edit
```

Open `WebAdmin/login.php`, change only the `<title>` text, save, and refresh the
browser. The PHP source is bind-mounted, so the change appears on the next
request without rebuilding the image.

Revert the tutorial edit immediately:

```sh
git restore WebAdmin/login.php
git status --short
```

Expected: no modified file from the exercise.

Node source is also bind-mounted but is loaded into memory at process start. A
change under `server/` requires:

```sh
docker compose restart relay
```

Do not edit relay behavior just for this tutorial: restarting it disconnects
local sockets, and the same lifecycle consequence matters during a real rollout.

---

## Step 8 — stop, preserve, and reset

Stop containers while preserving the database volume:

```sh
docker compose down
docker compose up
```

Use a destructive local reset only when you intentionally want the original
synthetic seed again:

```sh
docker compose down -v
docker compose up --build
```

`-v` deletes this Compose project's named volumes, including its local database.
Before running it, confirm `docker compose ls` and `docker compose ps` identify
the expected local project. Never adapt `down -v` into a production command.

PostgreSQL executes `infra/docker/seed/*.sql` only when the data directory is
empty. Editing a seed file and restarting existing containers does not reseed.

---

## Troubleshooting

### A host port is already allocated

Choose unused host ports in `.env`; do not edit the shared Compose defaults just
for one workstation.

### The panel does not reflect a PHP edit

Confirm the file is saved, hard-refresh the browser, then check:

```sh
docker compose ps webadmin
docker compose logs --tail=100 webadmin
```

### The relay restarts repeatedly

```sh
docker compose ps relay db redis
docker compose logs --tail=200 relay db redis
```

Look for an unhealthy dependency, failed schema seed, or invalid local config.
Do not mask the failure with production credentials.

### Seed changes do not appear

Reset the local volumes with `docker compose down -v`, after confirming the
project identity as described above.

### File access is slow on Windows

When using WSL2, keep the repository inside the Linux filesystem rather than
under `C:\` to avoid expensive cross-filesystem bind mounts.

### You need CSS or JavaScript bundle changes

The current containers serve committed generated assets. Run the documented
WebAdmin build on the development workstation, then confirm generated files are
the only intended output. Never perform that build on staging or production.

---

## What local Docker proves — and what it does not

Local Docker is a fast development feedback loop. It can prove that current
source starts against synthetic data and that focused local behavior works.
It does **not** prove production readiness.

Staging still owns evidence for:

- immutable release bytes and host permissions;
- Nginx/Apache or PHP-FPM behavior and OPcache;
- TLS and edge/CDN/proxy headers;
- environment-specific secrets and state separation;
- realistic data volume;
- deploy/restart/rollback behavior;
- physical handset and PTT/reconnect acceptance.

The delivery contract remains:

```text
workstation/ephemeral DEV
→ reviewed source and CI
→ one immutable artifact
→ staging acceptance of that digest
→ explicit production approval
→ promotion of the same digest
```

A local success is useful evidence, but it is never permission to deploy.

---

## Next references

- [`../how-to/run-locally-with-docker.md`](../how-to/run-locally-with-docker.md)
  — ports, volumes, editing, reset, and schema-refresh reference.
- [`../how-to/use-the-staging-environment.md`](../how-to/use-the-staging-environment.md)
  — staging verification and environment boundaries.
- [`../explanation/security-posture.md`](../explanation/security-posture.md)
  — why unauthenticated requests fail closed.
- [`../explanation/release-boundary.md`](../explanation/release-boundary.md)
  — immutable artifact and runtime/host-security separation.
