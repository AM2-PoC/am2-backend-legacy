# Phase 2A Evidence Ledger

Planning migration does not constitute application evidence.

| Task | Requirement | Source SHA | Executor | Observed | Evidence | Verdict |
|---|---|---|---|---|---|---|
| P2A-01 | R01 | backend `2037116…` | source/GitHub inspection | clean owned worktree; public Actions net cost zero to date; paid overage fail-closed; bounded four-run budget authorized by owner 2026-09-19 | P2A bounded execution record | completed |
| P2A-02 | R02 | backend `2037116…`; Admin `6a8f2a0…` | static source review + pending hosted contract | Admin API source digest and 61-file PHP/Node direct-writer tree digests recorded; opaque restore/DB-side boundaries explicit | fixtures and focused contracts | in_progress |
| P2A-03A | R03/R04 | backend `ba7d686…`; Admin `02b6abc…` | read-only source/GitHub inspection | reconciliation record accepted by owner 2026-09-19; runner/quota and inventory gaps documented, no application execution | reconciliation record below | completed — discovery only |
| P2A-03B | R03/R04 | pending PR SHA | GitHub-hosted Ubuntu 26.04 digest-pinned container | exact PHP/Composer/theme Node contract authored; Laravel/Filament locks intentionally absent | pending expected-RED run | in_progress |
| P2A-03C..D | R03/R04 | not run | not run | Laravel/Filament lock graph and GREEN/reproduction proof absent | none | blocked per tasks |
| P2A-04..18 | R05..R18 | not run | not run | not implemented by this document conversion | none | pending/blocked per tasks |

## Required Task 3 evidence template

Record exact source SHA, runner/container image digest, PHP exact patch/provenance, exact theme-build Node patch/distribution provenance, required PHP extension inventory, Composer lock hash, npm lock hash, Vite/Tailwind versions, packaged Filament/Vite manifest and asset hashes, commands, expected/observed RED, GREEN run URLs, clean second-install/build output, Composer/npm audit results, and independent exact-head reviews. Node used for the theme remains build-only and separate from relay Node 26. Do not record credentials or caches as correctness evidence.

## P2A-03A reconciliation record

Observed 2026-09-17 and reconciled 2026-09-19 by read-only source/GitHub inspection; no inventory test, dependency install, application execution, CI dispatch, or host/runtime mutation was performed.

- Source/workspace: backend `HEAD == origin/main == ba7d686aa04d400317f7632dbc4df88727e519f9`; Admin `HEAD == origin/main == 02b6abcd914bca218772f88f7231e7db00ad317a`. Both worktrees were clean. These are the post-redaction/current `main` commits; the application tree was preserved while root `AGENTS.md` was removed and local agent-instruction filenames were ignored. The canonical backend checkout is `/home/am2deploy/am2-main`, owned by `am2deploy:www-data` with mode `775`; it is the sole listed backend worktree. Authoring remains this clean owned checkout; execution remains GitHub-hosted ephemeral non-production only.
- Existing exact-main source proof: backend run [35371667998](https://github.com/AM2-PoC/am2-backend-legacy/actions/runs/35371667998) succeeded at `ba7d686…`, including the offline contract job. Historical run [35235274419](https://github.com/AM2-PoC/am2-backend-legacy/actions/runs/35235274419) and former SHA `92719e0…` remain pre-redaction evidence only. Neither is Laravel/Filament toolchain evidence.
- Admin route inventory: `webadmin-api-contract.json` records 29 operations across 11 `api_*.php` paths. Current Admin `ApiService.kt` and current `WebAdmin/api_*.php` expose the same 11 path names. The fixture is historically source-bound to former pre-redaction SHA `f18dbcdd7b5873f77ccf23dbd2956a47e8fc17ea`; its rewritten release-tag target is `8199bf6745a50b70b8fa8c402bb7627392275a41`. The rewrite preserved application-tree bytes, but the fixture itself is not current-SHA-bound. The existing contract proves checked-in path/action structure but does not parse current Retrofit annotations, response model shapes, cookies/status/error semantics, or prove complete current-route mutation coverage. P2A-02 remains partial until a current-SHA fixture plus fail-closed current-source/hosted proof covers those semantics.
- Writer inventory: `webadmin-write-owners.json` names only six `public.users` session/default columns. The contract scans quoted `UPDATE users SET` statements for relay-owned columns, checks the durable `last_channel_id` exception, and checks force-logout routing. It does not inventory every PHP/Node writer by command/table/column, dynamic or multiline SQL beyond its regex shapes, inserts/deletes, transactions/audit effects, background workers, or prove mutation detection against current source. P2A-02 remains partial.
- Hosted executor: repository Actions are enabled, selected-actions policy is active, and SHA pinning is required. Existing workflows use floating `ubuntu-latest`, PHP `8.3`, and Node `20`/`22`; these are not the P2A target pins. The current Ubuntu 24.04 hosted-image manifest observed OS `24.04.5`, image `20260907.300.1`, Node `22.23.2`; P2A still requires a deliberate immutable runner/container image identity, PHP `8.5.x`, a supported exact theme-build Node patch, required PHP extensions, Composer version, and lock hashes before P2A-03B.
- Dependency metadata candidates only: Packagist exposed Laravel `v13.32.0` (`php ^8.3`) and Filament `v5.8.2` (`php ^8.2`) on inspection; Node published LTS `v24.21.0`. These are candidates, not compatible pins. Their full Composer/Livewire/Vite/Tailwind closure has not been resolved on PHP 8.5.
- Quota/budget evidence: GitHub billing usage returned discounted Actions usage with net amount `0` for the queried period, including backend Linux minutes; exact remaining included minutes/storage were not exposed. Organization Actions budget is `0` with `prevent_further_usage=true`, so paid overage is fail-closed. Recent public-repository exact-main CI ran successfully, but that does not establish a guaranteed future quota. P2A-03B dispatch remains blocked pending explicit user authorization of a bounded run budget.
- Bounded future workload after authorization: one initial pull-request run to prove the intended missing lock/runtime assertion RED; one corrected exact-head pull-request run for GREEN; one clean fresh-job reproduction; one exact-main run after merge. Stop after the first unexpected/setup failure and reconcile before consuming another run.

P2A-03A read-only reconciliation was accepted by the owner on 2026-09-19 as discovery evidence only. The later bounded authorization below closes P2A-01 and permits P2A-02 hosted inventory proof plus the P2A-03B expected-RED candidate. P2A-02 and P2A-03B remain `in_progress` until their hosted checks produce the stated evidence; no GREEN, staging, deployment, production, or host authorization follows.

## P2A bounded execution record — 2026-09-19

- Owner explicitly authorized the proposed bounded lane: one expected-RED PR run, one GREEN PR run, one fresh-job reproduction, and one exact-main run. Stop on the first unexpected/setup failure. This authorization covers ephemeral GitHub-hosted P2A CI only; it excludes VPS execution, staging, production, deployment, publication, credentials, and host mutation.
- Source boundary at authoring start: backend `2037116c5748ba22d02185f1865606da964a5586`; Admin `6a8f2a010fd855afc57100f5f6beb7e75279104a`. Backend branch `feat/p2a-toolchain-red` was created from clean current `main`.
- Inventory boundary: Admin `ApiService.kt` SHA-256 `6901f947e5ee32a255c0ee02445b6a5436eb038a3ae34557665aa03c7356d9c5`; 46 WebAdmin PHP files aggregate to `62a7509acef637ac70f8f8847ca89021231a9cecb5a83c0536ef4a442da9dd11`; 15 relay JS files aggregate to `7b5fd27553d1eca52f2507f20f45a386ad80e9df0c14cc225c17b81d2b50e525`. Static inventory covers direct source writes and records `psql` restore plus database-side effects as opaque boundaries; it does not claim deployed runtime parity.
- RED candidate pins: Ubuntu 26.04 container manifest `sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78`, PHP `8.5.10`, Composer `2.10.3` (`7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6`), and build-only Node LTS `24.21.0`. Relay Node 26 remains separate.
- Budget consumed: none at authoring time. Expected RED must be accepted only if clean-room prerequisites pass and `platform-baseline.test.mjs` fails specifically on the absent `laravel/` manifests/locks.

## 2026-09-14 stack revision evidence

Direct user decision: withdraw Inertia/Vue/Vite, return to Filament. This supersedes old custom SPA task designs but proves no application result. Dependency install, asset publication, auth/resource/query/Livewire/browser parity and deployment remain not run. Version metadata lookup is source evidence only; Composer compatibility not run. Prior SDD review PASS applies to the pre-revision document baseline, not automatic approval of this revision.

## 2026-09-14 custom-theme amendment

Direct user approval: add Vite for a Filament custom theme; UI/UX may be redesigned. Scope is planning only and build-time only. No dependency lock, theme, generated asset, visual test or approval currently exists. Inertia/Vue remain withdrawn. Record future exact npm lock hash, Node/build-image identity, clean build output hashes, browser/accessibility evidence and user UI/UX acceptance separately.

## 2026-09-14 UI-kit amendment

Direct user decision: new Filament panel does not need Preline. No dependency or application change was made. Future evidence must prove the new `laravel/` graph/artifact contains no Preline/Flux package/import/markup/runtime while legacy assets remain untouched and rollback-capable until their final consumer route retires.
