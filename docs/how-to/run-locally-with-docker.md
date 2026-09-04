# Run AM2 locally with Docker

How-to: you know what you want, this is where the ports, volumes and reset
paths are. Never used Docker before? Start with
[the tutorial](../tutorial/your-first-local-am2.md) and come back here.

For why this exists at all, see the explanation linked at the bottom.

## Bring it up

```sh
cp .env.example .env
docker compose up --build
```

First boot pulls `postgres:16-alpine` and `redis:7-alpine`, builds the panel
and relay images, and seeds the database — schema from staging structure,
rows that are entirely synthetic (see `infra/docker/seed/02-seed.sql`).

- Panel: <http://localhost:8080> — sign in as `demo_super` / `devpassword123`
  (superadmin) or `demo_branch` / `devpassword123` (a branch admin who owns
  the seeded units and channels).
- Relay: `ws://localhost:5000` for the WebSocket protocol,
  `http://localhost:5000/api/check-update` etc. for the HTTP surface.
- Postgres: `localhost:5433` (`am2` / `am2` / the password in `.env`).
- Redis: `localhost:6380`.

Ports are on the host side only, to stay out of the way of whatever else you
run locally; change them in `.env` if any of the defaults collide.

## What's seeded

Two admins, two channels, three units — all named `demo_*` / `DEMO_*` so
nothing from this database is ever mistaken for staging or production data.
`DEMO_UNIT_1` and `DEMO_UNIT_2` have a default channel and can sign in as a
field app would; `DEMO_UNIT_3` deliberately has none, so the panel's "no
default channel" state has something real to look at from a fresh database
instead of an empty list.

## Editing

`./WebAdmin` and `./server` are bind-mounted into their containers, so
changes on the host show up immediately — PHP on the next request, the relay
on its next restart (`docker compose restart relay`; it does not hot-reload).
`node_modules` and the `update/` upload directories live in named volumes,
not on the host, so a container built for one platform never collides with
whatever `npm install` would produce on yours.

CSS and JS bundles are not rebuilt by the container — `am2-tailwind.css` and
`am2-ui.min.js` are committed output, same as they are on a real deploy. Run
`npm run build` in `WebAdmin/` the normal way if you changed a Tailwind class
or the bundle's source.

## Resetting

```sh
docker compose down -v   # -v also drops the database volume
docker compose up --build
```

Postgres only runs the seed scripts on a database's first boot. Editing
`infra/docker/seed/*.sql` and restarting does nothing until the volume is
gone.

## Regenerating the schema

`infra/docker/seed/01-schema.sql` is `pg_dump --schema-only` against staging
— structure only, zero rows, which is why it is safe to keep in the repo.
Refresh it from the VPS, where the database actually is:

```sh
bash infra/scripts/refresh-docker-schema.sh
```

## What this is not

This does not replace staging, and is not meant to. Local answers "does the
code work"; staging answers "does it work in the real conditions" — the
Cloudflare cache, the proxy-built `X-Forwarded-For`, OPcache, TLS, real data
volume, a real handset. Every one of those has produced a real defect during
this project's work, and none of them reproduce in Docker. Before a release,
staging is still where it gets proven — see
[`use-the-staging-environment.md`](use-the-staging-environment.md).

See also: [`docs/explanation/`](../explanation/) for why development moved
off the VPS in the first place.
