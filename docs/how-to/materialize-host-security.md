# Materialize and audit host-security configuration

How-to. You have a sealed host-security bundle and want its bytes staged on a
host, recorded, and watched. For why the lifecycle is separate from the backend
runtime archive, see [the release boundary](../explanation/release-boundary.md).

Nothing here activates anything. Materialization stages bytes and writes a
receipt; installing into `/etc`, running `apache2ctl configtest` / `nginx -t`,
and reloading a service are separately approved operations that are not part of
these scripts.

## Materialize

Needs the bundle, its checksums, and the expected manifest obtained through a
channel independent of the bundle itself — that independence is the whole point,
so do not copy it out of the bundle directory.

```sh
sudo infra/scripts/materialize-host-security.sh \
  --archive           /path/am2-host-security.tar.gz \
  --manifest          /path/host-security-manifest.json \
  --checksums         /path/SHA256SUMS \
  --expected-manifest /path/trusted-host-security-manifest.json \
  --store-root        /var/lib/am2/host-security \
  --receipt           /etc/am2/host-security/receipt.json
```

The store is digest-addressed: bytes land in `<store-root>/<payload_sha256>`,
sealed read-only. Re-running with the same bundle is a no-op. If the store
already holds that digest but its bytes have changed, the run refuses rather
than overwriting — investigate before you retry.

Without root it refuses. Pass `--unprivileged-store` to materialize into a
scratch directory for testing; the receipt then records `"privileged": false`
and no verifier will accept it as evidence about a real host.

## Verify what is installed

After an approved activation has put the files in place:

```sh
sudo infra/scripts/verify-host-security-installed.sh \
  --receipt /etc/am2/host-security/receipt.json
```

It checks each target's bytes, owner, mode, and file type; that each Apache lane
declares its own `session.save_path` and that the two differ; and that the
Cloudflare real-IP data still has a plausible shape and a generation date inside
the stale-data policy. It prints findings and exits non-zero; it never repairs.

## Audit on a timer

`infra/systemd/am2-host-security-drift.{service,timer}` run the same checks
daily. They print nothing when the host is healthy, so any mail from the unit is
news. Install and enable them as a separately approved host change.

## When it refuses

**`receipt records an unprivileged materialization`** — the receipt came from a
`--unprivileged-store` run. It describes a fixture. Materialize as root.

**`existing materialization differs from its manifest`** — something edited the
sealed store in place. Do not delete it and retry; find out what wrote to it.

**`both lanes share one session store`** — production and staging Apache point
at the same `session.save_path`. A staging session will authenticate in
production. Fix before activating anything else.

**`cloudflare real-IP: generated N days ago`** — run
`infra/scripts/refresh-cloudflare-ranges.sh` and activate the result through the
same approved path. This is a stale-data finding, not tampering.
