# Deploy a release, and roll it back

Production runs from a symlink, so a release is a directory swap and a rollback is the same swap in
reverse. Nothing is edited in place.

```
/var/www/am2/
├── current -> releases/<stamp>     the symlink Apache and systemd follow
├── releases/<stamp>/               one directory per release, never modified after creation
├── shared/                         runtime data that survives releases (upload targets)
└── staging/                        the staging tree, independent of all of the above
```

## Before you start

Take a database dump. The backup timer runs at 02:30 daily, which is not close enough to a deploy.

```bash
sudo systemctl start am2-backup.service
ls -lh /var/backups/am2/postgres/ | tail -3
```

Confirm the newest dump actually restores, rather than assuming it does:

```bash
sudo -u postgres pg_restore -l /var/backups/am2/postgres/<newest>.dump | grep -c 'TABLE DATA'
```

A healthy dump lists 10 tables with data. A file that exists but lists nothing is the failure mode
that went unnoticed for three months before it was fixed — check the number, not the file size.

## Deploy

```bash
STAMP=$(date +%Y%m%d%H%M%S)
REL=/var/www/am2/releases/$STAMP

sudo -u am2deploy git -C /home/am2deploy/am2-main fetch --all
sudo install -d -o am2deploy -g www-data -m 750 "$REL"
sudo -u am2deploy bash -c "git -C /home/am2deploy/am2-main archive main | tar -x -C $REL"

# Runtime symlinks live outside the release and are recreated each time.
sudo -u am2deploy ln -sfn /var/www/am2/shared/webadmin-update "$REL/WebAdmin/update"
sudo -u am2deploy ln -sfn /var/www/am2/shared/server-update   "$REL/server/update"

sudo -u am2deploy bash -c "cd $REL/server && npm ci --omit=dev"

# Syntax-check before anything is swapped.
for f in "$REL"/WebAdmin/*.php; do php -l "$f" >/dev/null || echo "SYNTAX: $f"; done
node --check "$REL/server/server.js"
```

## Migrate

Before the swap, never after. Migrations that run afterwards leave a window — however short — where
the new code is live against the old schema, and on this application that window is a broken
Activity Log: `fetch_logs.php` selects `event_code`, and `am2_log()` swallows its own write failures
by design, so the trail goes quietly empty rather than erroring.

```bash
# What would run, without running it.
"$REL"/infra/scripts/apply-migrations.sh --db am2 --dry-run

# Apply.
"$REL"/infra/scripts/apply-migrations.sh --db am2
```

`applied 0, already present N` is the normal result and means there was nothing to do. The runner
records each file with its checksum in `public.schema_migrations` and refuses to continue if a file
that was already applied has since been edited — write a new migration rather than changing an old
one.

Rehearse on staging first, against a database restored from the same dump production will be running
on:

```bash
sudo -u am2deploy /var/www/am2/staging/current/infra/scripts/apply-migrations.sh --db am2_staging
```

**Rolling back:** the migrations here only add — a column, an index, a function — so the previous
release runs unchanged against the migrated schema, and a code rollback needs no schema rollback.
That is a property of these migrations, not a rule; a future migration that drops or renames
anything breaks it, and the way to keep a rollback possible is to write the destructive half as a
separate migration shipped a release later.

Swap, then restart only what needs it:

```bash
sudo ln -sfn "$REL" /var/www/am2/current
sudo systemctl reload apache2      # PHP picks up the new path immediately
sudo systemctl restart am2-api     # only if server/ changed
```

`reload apache2` is enough for PHP-only changes and drops no connections. Restarting `am2-api` drops
every live WebSocket session; the field apps reconnect within about ten seconds, but do it in a quiet
window rather than mid-shift.

## Verify

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/login.php -H 'Host: webadmin.am2-poc.com'
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/         -H 'Host: apiapi.am2-poc.com'
systemctl is-active nginx apache2 postgresql redis-server am2-api
```

Then log in and exercise one read path and one write path. A 200 on the login page only proves PHP
parsed.

## Roll back

The previous release directory is untouched, so rollback is one symlink and one reload:

```bash
ls -1dt /var/www/am2/releases/*/ | head -3      # pick the one you were on before
sudo ln -sfn /var/www/am2/releases/<previous> /var/www/am2/current
sudo systemctl reload apache2
sudo systemctl restart am2-api                  # only if you restarted it on the way in
```

This restores code only. **A schema migration is not rolled back by the symlink** — if the release
included one, restore the pre-deploy dump as well, and expect to drop the database to do it:

```bash
sudo systemctl stop am2-api apache2
sudo -u postgres dropdb am2
sudo -u postgres createdb -O admin --template=template0 --encoding=UTF8 \
     --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 am2
sudo -u postgres pg_restore -d am2 /var/backups/am2/postgres/<pre-deploy>.dump
sudo systemctl start apache2 am2-api
```

The `--lc-collate` flag is not optional. A cluster created without it defaults to `C.UTF-8`, and
every text `ORDER BY` then sorts differently from production with no error anywhere.

Restore as the `postgres` superuser and **without** `--no-owner --role=admin`. The dump already
carries `OWNER TO admin`; passing `--role` makes two `ALTER DEFAULT PRIVILEGES` statements fail and
turns a good restore into a non-zero exit.

## Housekeeping

Keep at least the last three releases. Note that the Android sources under `APK AM2/` and
`APK Admin_Native/` exist only inside the May 2026 release directory and are not in the repository —
do not delete that release until they are archived somewhere else.
