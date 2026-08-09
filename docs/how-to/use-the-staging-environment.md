# Use the staging environment

`https://staging-webadmin.am2-poc.com` runs the same code as production against a copy of the data,
on the same host, sharing nothing writable with it.

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

Code:

```bash
sudo -u am2deploy git -C /var/www/am2/staging/repo fetch --all
sudo -u am2deploy git -C /var/www/am2/staging/repo checkout <branch>
sudo -u am2deploy git -C /var/www/am2/staging/repo reset --hard origin/<branch>
sudo systemctl restart am2-api-staging      # only if server/ changed
```

Data, from the newest production dump:

```bash
sudo systemctl stop am2-api-staging
sudo -u postgres dropdb --if-exists am2_staging
sudo -u postgres createdb -O admin --template=template0 --encoding=UTF8 \
     --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 am2_staging
sudo -u postgres pg_restore -d am2_staging /var/backups/am2/postgres/<newest>.dump
sudo systemctl start am2-api-staging
```

Keep the collation flags. Production is `en_US.UTF-8`; a staging database created without them lands
on `C.UTF-8` and sorts text differently, which turns into bug reports that do not reproduce.

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
