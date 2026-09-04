# Your first local AM2

A lesson, not a reference. Follow it start to finish and you will have the whole
system running on your own machine, will have changed something and watched the
change appear, and will have watched the panel refuse a request that should be
refused.

You need about twenty minutes, most of it waiting for the first build. You do
not need to know Docker. You do not need a server.

Nothing here touches the VPS, staging, or production. That is the point:
development belongs on your machine, and this is how it gets there.

---

## What Docker is doing for you

Skip this if you want to start; come back when the commands stop feeling like
magic.

AM2 is four programs that have to find each other: PostgreSQL, Redis, the Node
relay, and the PHP panel. Running it by hand means installing PostgreSQL 16,
Redis 7, PHP 8.3 with the right extensions, and Node 22, then configuring all
four to agree on hostnames, ports and passwords. On Windows, several of those
are painful.

Docker runs each program in its own **container** — a normal process with its
own view of the filesystem, the network and the process list. It is not a
virtual machine; there is no second operating system booting, which is why it
starts in seconds.

`docker-compose.yml` in the repository root describes all four, and how they
find each other. Read it at some point — it is commented, and it is the shortest
accurate description of the system that exists.

---

## Step 1 — install Docker (once)

**Windows:** install [Docker Desktop][dd-win]. It will ask to enable WSL2;
accept — that is the Linux kernel your containers use.

**macOS:** install [Docker Desktop][dd-mac].

**Linux:** install `docker.io` and `docker-compose-plugin` from your
distribution, then add yourself to the `docker` group and log out and back in.

Check it worked:

```sh
docker --version
docker compose version
```

Two version numbers means you are done. If `docker compose` says "is not a
docker command", you have the old standalone `docker-compose` — install the
plugin, or write `docker-compose` in place of `docker compose` everywhere below.

[dd-win]: https://docs.docker.com/desktop/install/windows-install/
[dd-mac]: https://docs.docker.com/desktop/install/mac-install/

---

## Step 2 — bring the system up

Clone the repository, then from inside it:

```sh
cp .env.example .env          # Windows: copy .env.example .env
docker compose up --build
```

Leave that terminal running. It is the system's console, and everything four
programs print goes there.

The first run takes a few minutes: it downloads PostgreSQL and Redis, builds
images for the panel and the relay, and seeds a database. Later runs take
seconds.

You will know it is ready when the log settles and stops scrolling. If you want
certainty rather than a feeling, open a second terminal and ask:

```sh
docker compose ps
```

Every service should say `running`, and `db` and `relay` should also say
`(healthy)`. Health is not the same as running: `db` reports healthy only once
PostgreSQL actually answers a query, and the relay waits for that before it
starts. That ordering is written into `docker-compose.yml` on purpose.

---

## Step 3 — look around

Open <http://localhost:8080> and sign in:

| account | password | what it sees |
|---|---|---|
| `demo_super` | `devpassword123` | everything |
| `demo_branch` | `devpassword123` | one branch: its own units and channels |

Sign in as `demo_super` first and look at the unit roster. Then sign out, sign
in as `demo_branch`, and look again. The list is shorter. Nothing in the URL
changed — the panel decides what you may see from your session, never from
anything the request asks for. That is the property the whole authorization
design rests on, and you have just watched it work.

The data is entirely invented. Two admins, two channels, three units, all named
`demo_*` or `DEMO_*` so that nothing here can ever be mistaken for real. One
unit, `DEMO_UNIT_3`, deliberately has no default channel — so the panel's "no
default channel" state has something real to look at from a fresh database.

---

## Step 4 — change something and watch it appear

Open `WebAdmin/login.php` in your editor and change the heading text. Save.
Refresh the browser.

It is already there. No rebuild, no restart. `./WebAdmin` is mounted into the
container, so the file you edited *is* the file the container serves, and PHP
reads it fresh on every request.

Now the other half. Open `server/lib/messages.js`, change one of the strings,
and save. Refresh anything. **Nothing happens** — and that is correct.

```sh
docker compose restart relay
```

Now it applies. The relay is a Node process that loaded its code into memory
when it started; changing the file on disk does not change what is running. The
panel and the relay behave differently here, and the difference is not a
Docker quirk — it is the same reason a production deploy changes the panel
instantly and needs a relay restart that disconnects every radio.

You have just learned, in ten seconds and with nothing at stake, a fact that
otherwise gets learned during a deployment.

---

## Step 5 — watch it refuse you

The panel authenticates every request from one place. There is no setting that
turns that off — not in development either, deliberately, because a permissive
local panel would teach you something untrue.

Ask it for data without signing in. In a second terminal:

```sh
curl -i -H 'Accept: application/json' http://localhost:8080/api_get_users.php
```

```
HTTP/1.1 401 Unauthorized
{"success":false,"code":"unauthenticated","message":"..."}
```

Now ask the same thing the way a browser asks for a page:

```sh
curl -i -H 'Accept: text/html' -H 'Sec-Fetch-Dest: document' \
     http://localhost:8080/dashboard.php
```

```
HTTP/1.1 302 Found
Location: login.php
```

Same refusal, two shapes. A `fetch()` needs a status it can act on; a person
navigating needs to arrive at the login page. Answering the first with a
redirect is how a signed-out session used to surface in the Admin app as
"feature failed" — the request followed the redirect, received a login page with
status 200, and nothing could tell it had been signed out.

One more. Try a file nobody thinks of as an endpoint:

```sh
curl -i -H 'Accept: application/json' http://localhost:8080/config.php
```

Also 401. `config.php` is a library — it defines things, it renders no page —
but it sits in the document root, so it can be requested like anything else.
Before this guard existed it answered 200 and ran: loading the environment,
connecting to the database, opening a session, for anybody who asked.

---

## Step 6 — stop, and start again

`Ctrl+C` in the first terminal stops everything. Then:

```sh
docker compose down       # remove the containers, keep the database
docker compose up         # back in seconds; your data is still there
```

When you want a clean database — you changed the seed, or you want the tutorial
state back:

```sh
docker compose down -v    # -v also deletes the database volume
docker compose up --build
```

`-v` is the only thing that re-seeds. PostgreSQL runs the seed scripts **only**
when its data directory is empty, so editing `infra/docker/seed/*.sql` and
restarting does nothing at all. That surprises everyone once.

---

## When it does not work

**`port is already allocated`** — something on your machine already uses 8080,
5000, 5433 or 6380. Change it in `.env`, not in `docker-compose.yml`; the
compose file reads your `.env`.

**A PHP change does not appear** — hard-refresh the browser before suspecting
Docker. It is nearly always the browser cache.

**The relay restarts in a loop** — `docker compose logs relay`. Usually the seed
failed, so `db` never became healthy and the relay never got a database.

**Everything is very slow on Windows** — keep the repository inside the WSL2
filesystem (`\\wsl$\...`), not on `C:\`. Crossing that boundary for every file
read is the single biggest performance difference on Windows.

---

## What this is not

Local answers *"does the code work"*. Staging answers *"does it work in real
conditions"* — the Cloudflare cache, the `X-Forwarded-For` a proxy builds,
OPcache serving the previous bytecode for a second after a deploy, TLS, real
data volume, a real handset with a real radio.

Every one of those has produced a real defect in this project, and **none of
them reproduce here**. This is a place to build and to be wrong quickly. It is
not evidence.

---

## Where to go next

- [`../how-to/run-locally-with-docker.md`](../how-to/run-locally-with-docker.md)
  — the same stack as a reference: every port, volume and reset path.
- [`../how-to/use-the-staging-environment.md`](../how-to/use-the-staging-environment.md)
  — where a change gets proven before it reaches anyone.
- [`../explanation/security-posture.md`](../explanation/security-posture.md)
  — why the refusals in step 5 are shaped the way they are.
