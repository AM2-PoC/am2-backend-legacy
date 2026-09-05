# Backend release boundary

The AM2 backend is built once in ephemeral CI and promoted by immutable archive digest. Staging and production attach different protected configuration and writable storage to the same verified runtime bytes.

## Four identities

1. **Source identity** — the exact reviewed Git commit used only by a developer or ephemeral CI runner.
2. **Artifact identity** — the sealed runtime archive, addressed by `archive_sha256` and carrying its source SHA, payload digest, lockfile digests, and `SHA256SUMS`.
3. **Release identity** — an immutable directory materialized from that verified artifact with environment-owned update links attached afterward.
4. **Activation identity** — the atomic `current` pointer plus the service PID, cwd, release marker, and restart count.

A branch is a change/review boundary. A release tag is an optional human-readable label bound to the accepted source and artifact identity. Neither is a mutable deployment pointer.

## Build once and promote the same bytes

```text
short-lived branch → PR → main → ephemeral CI build
→ immutable archive digest → private cache
→ staging activation/rollback/re-promotion
→ production approval → same archive digest
```

Staging acceptance applies to one exact artifact. A rebuild from the same source SHA is a different artifact until its bytes and digest are proven identical. Production must activate the same archive digest accepted in staging.

Runtime configuration, secrets, databases, Redis, logs, and update stores remain outside the archive. Materialization may attach only the environment-owned writable links defined by the release contract; it must not modify sealed payload files.

## Host-security release boundary

PHP `auto_prepend_file`, PHP SAPI configuration, Apache/Nginx virtual-host configuration, lane session stores, and Cloudflare real-IP configuration are host state. They must not be folded into the backend runtime archive merely to make deployment verification convenient.

The static Git-owned subset has a separate release contract:

```text
exact reviewed source SHA
→ deterministic `am2-host-security.tar.gz`
→ `host-security-manifest.json`
→ independent trusted channel for the expected manifest
→ root-owned materializer
→ syntax/config checks
→ protected receipt
→ installed-state verifier and drift audit
→ separately approved activation/reload and rollback
```

The source contract and deterministic bundle/verifier, the root-owned materializer, protected receipt, installed-state verifier, and drift audit are implemented. Activation, reload, and rollback are not implemented yet and remain separately approved host operations.

Materialization is digest-addressed and immutable: authenticated bytes are unpacked under their own payload digest, sealed read-only, and never overwritten. It reads no source checkout, so a bounded identity with no Git credential and no build tooling can run it. A receipt records a materialization that happened, names the store it produced, and states whether the run was privileged; an unprivileged receipt is a fixture and the verifier refuses to read it as evidence about a host.

Existing host files may protect live traffic correctly without proving that their installed bytes came from the current source contract; behavior health and provenance are separate gates. The installed-state verifier closes that gap by reading the bytes that are actually in place — their content, owner, mode, and file type — and by checking that the two Apache lanes still keep separate session stores, because when they shared one a staging session authenticated in production.

Cloudflare real-IP data is externally refreshed rather than fully Git-static, so `infra/contracts/cloudflare-realip-lifecycle.json` governs it separately from the reviewed application source SHA. Binding it to a byte-identical app release would turn every legitimate Cloudflare change into a false alarm and make refreshing the list wait on an unrelated code review. The drift audit therefore judges those bytes by shape and provenance — range counts, required directives, and the generation marker against a stale-data policy — rather than by equality with the release. Rollback and a refresh receipt for that data are not implemented yet.

## Runtime host boundary

Deployment and rollback must not read or use the operator checkout. They require no Git source credential, `git clone/fetch/pull`, dependency installation, compiler, bundler, or CI runner. The deploy identity reads one approved private-cache digest, creates a new immutable release, verifies it, and performs only the separately approved activation/service operation.

A runtime release must contain no `.git`, `.github`, `.hermes`, tests, plans, developer docs, local environment files, build caches, or development dependencies.

## Rollback

Rollback never rebuilds. It selects a retained, preflighted immutable release derived from a previously verified artifact, switches `current` atomically, and runs the same identity and health checks as forward promotion. Accepted and rollback artifacts remain in durable private storage.

## Atomic release scope

WebAdmin and relay runtime files form one release. Partial file-level rollback is unsupported because authentication, session, endpoint, and UI contracts can change together. Move only between complete release identities; never copy individual files into an active release.

## Runtime boundary audit

A root-owned runtime boundary audit runs periodically and immediately before a new bounded deployment transition. It alerts only on actionable drift: source/build commands or source-credential references in deployment automation, active CI runners, forbidden developer metadata in active releases, active release/PID identity mismatch, or missing retained artifact bytes. Healthy runs are silent; the deploy gate runs a fresh audit so stale timer state cannot block forever.

## Transitional operator exception

The co-resident operator checkout is an approved expiring exception. It may remain temporarily for chat-assisted coding and `git`/`gh` branch–PR–merge work, but it is never deployment input and is unreadable to bounded cache/materialization identities. Task 14 relocates operator work and removes source credentials, checkout, and build-only tooling from the runtime VPS only after a non-production operator destination is approved.
