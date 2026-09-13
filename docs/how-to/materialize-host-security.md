# Materialize and audit host-security configuration

How-to. You have a sealed host-security bundle and want its bytes staged on a
host, recorded, and watched. For why the lifecycle is separate from the backend
runtime archive, see [the release boundary](../explanation/release-boundary.md).

Nothing here activates anything. Materialization stages bytes and writes a
receipt; installing into `/etc`, running `apache2ctl configtest` / `nginx -t`,
and reloading a service are separately approved operations that are not part of
these scripts.

## Get the bundle

Bundles are built by CI, never on the host. Dispatch the workflow for the exact
main commit whose host files you want:

```sh
gh workflow run publish-host-security-bundle.yml --ref main -f source_sha=<40-hex main SHA>
```

When the run succeeds, trust it only after checking the run record, fetched
separately from the artifact. A branch that edits the workflow can be
dispatched too, and its summary would say whatever it likes, so the run must be
this workflow on main:

```sh
gh run list --workflow publish-host-security-bundle.yml -L 5 \
  --json databaseId,headBranch,event,conclusion
gh run view <run-id> --json headBranch,event,workflowName,conclusion
# require: headBranch "main", event "workflow_dispatch", conclusion "success"
```

Then download into a fresh directory and bind the manifest to that run and to
the commit you meant:

```sh
gh run download <run-id> --dir /path/incoming
sha256sum /path/incoming/*/host-security-manifest.json      # must equal the run summary
jq -r .source_sha /path/incoming/*/host-security-manifest.json   # must equal your SHA
```

Stage the trusted copy as a candidate, root-owned and outside the bundle
directory. Do not write the canonical
`/etc/am2/host-security/trusted-host-security-manifest.json` or `receipt.json`:
those describe the active activation, and replacing them makes the drift audit
fail against it. They change only as part of an approved activation.

```sh
CANDIDATE=/etc/am2/host-security/candidates/<payload_sha256>
sudo install -d -o root -g root -m 0755 "$CANDIDATE"
sudo install -o root -g root -m 0644 /path/incoming/*/host-security-manifest.json \
  "$CANDIDATE/trusted-host-security-manifest.json"
```

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

## Activate and roll back

Activation and rollback are implemented as approval-bound source tools but are not run by materialization or the timer. Both operations take an exclusive host-security lock, refuse unverified or mutable trust inputs, write targets atomically, run both web-server configuration checks before reload, and keep a complete digest-bound backup—including prior session-store metadata—for exact rollback. Activation refuses to replace an existing active receipt: roll back or archive it through an approved lifecycle before activating another candidate, so a retry cannot discard the original rollback anchor.

```sh
sudo infra/scripts/activate-host-security.sh \
  --receipt /etc/am2/host-security/receipt.json \
  --expected-manifest /etc/am2/host-security/trusted-host-security-manifest.json \
  --activation-receipt /etc/am2/host-security/activation.json \
  --backup-root /var/lib/am2/host-security-backups \
  --apply --allow-reload
```

If post-activation acceptance fails, use the exact activation receipt. Rollback restores files that existed and removes targets introduced by that activation, runs `apache2ctl configtest` and `nginx -t`, reloads only after both pass, and removes the active activation receipt after success.

```sh
sudo infra/scripts/rollback-host-security.sh \
  --activation-receipt /etc/am2/host-security/activation.json \
  --apply --allow-reload
```

Running either command on the real host is a separate approval. Source tests exercise a fixture root only; they do not establish that the current host layout has been activated or rehearsed.

## Verify what is installed

After an approved activation has put the files in place:

```sh
sudo infra/scripts/verify-host-security-installed.sh \
  --receipt /etc/am2/host-security/receipt.json \
  --expected-manifest /etc/am2/host-security/trusted-host-security-manifest.json
```

Where each file belongs, and how tight its mode must be, are read from the
contract inside the materialization store — never from the receipt, and never
from an argument. Those two fields decide which file gets examined at all, so a
receipt that repointed one entry at a decoy would send this check to read
pristine bytes and report health while the live file stayed edited. Digests
cannot catch that on their own: the digest of a file nobody looked at is never
wrong. The store is bound by hashing to the payload digest the trusted manifest
names, which spans the contract too.

The trusted manifest is required on a real host, and must be the copy obtained
through a channel independent of the bundle. Without it the check reduces to
asking an unsigned file on the host whether that host is fine — the receipt's
`privileged` flag and its digests are all self-declared, so the manifest is what
makes any of it evidence.

It checks each target's bytes, owner, mode, and file type; that the receipt
itself is root-owned and no wider than root; that each Apache lane declares its
own `session.save_path` and that the two differ; and that the Cloudflare real-IP
data has a plausible shape and a generation date inside the stale-data policy.
It prints findings and exits non-zero; it never repairs.

## Audit on a timer

`infra/systemd/am2-host-security-drift.{service,timer}` run the same checks
daily. They print nothing when the host is healthy, so any mail from the unit is
news. Install and enable them as a separately approved host change.

The unit names absolute paths, so the layout has to exist before it is enabled —
otherwise it fails every day, and a unit that fails daily is the same lost signal
as a unit that says nothing:

```text
/etc/am2/host-security/
├── bin/
│   ├── audit-host-security-drift.sh
│   └── verify-host-security-installed.sh     # the audit runs this
├── contracts/
│   └── cloudflare-realip-lifecycle.json      # real-IP refresh policy
├── receipt.json                              # names the store the contract comes from
└── trusted-host-security-manifest.json       # from the independent channel
```

## When it refuses

**`receipt records an unprivileged materialization`** — the receipt came from a
`--unprivileged-store` run. It describes a fixture. Materialize as root.

**`existing materialization differs from the authenticated payload`** —
something edited the sealed store in place. Do not delete it and retry; find out
what wrote to it.

**`both lanes share one session store`** — production and staging Apache point
at the same `session.save_path`. A staging session will authenticate in
production. Fix before activating anything else.

**`cloudflare real-IP: generated N days ago`** — run
`infra/scripts/refresh-cloudflare-ranges.sh` and activate the result through the
same approved path. This is a stale-data finding, not tampering.

**`installed bytes differ from the receipt` on the real-IP file** — a refresh
was applied to the host directly. That data is not exempt from byte equality: a
single added `set_real_ip_from` line lets that address set `CF-Connecting-IP`
and present as any client, so a refresh must go through a new bundle and receipt
like everything else. Its separate lifecycle is a separate cadence and approval
path, not an exemption from integrity.
