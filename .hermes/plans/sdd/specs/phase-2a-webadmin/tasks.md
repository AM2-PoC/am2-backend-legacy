# Phase 2A Tasks

Lifecycle vocabulary: `pending`, `in_progress`, `partial`, `blocked`, `completed`, `superseded`; optional `NEXT`/`YAGNI` modifiers do not change lifecycle. `partial` means evidence exists but exit criteria remain unmet. This file is the sole lifecycle authority for this workstream. Completion requires an evidence row. Readiness is independent: ready for read-only reconciliation does not mean ready for application execution.

**P2A-03A reconciliation accepted 2026-09-19.** Owner authorized the bounded four-run P2A CI budget on 2026-09-19. P2A-01 is complete; P2A-02 current-source inventory closure and P2A-03B expected RED are in progress. This does not authorize staging, production, or host mutation.

| ID | Requirements | Original | Status | Depends on | Executor | Approval | Verification |
|---|---|---|---|---|---|---|---|
| P2A-01 | P2A-R01 | Task 1 workspace | completed | none | source authoring + GitHub-hosted ephemeral CI only | bounded four-run budget authorized 2026-09-19 | clean owned worktree, fail-closed billing, and stop conditions recorded |
| P2A-02 | P2A-R02 | Task 2 inventory | in_progress | P2A-01 | static source review/hosted CI | authorized within bounded budget | current Admin source digest plus direct PHP/Node writer inventory fail closed in CI; runtime/staging differential remains later P2A-09 evidence |
| **P2A-03A** | P2A-R01/R02/R03/R04 | Task 3 prerequisite | **completed — reconciliation only** | P2A-01/02 partial records (discovery inputs only) | read-only source/GitHub inspection; edit only this package evidence | owner accepted discovery record 2026-09-19; no CI/host action | runner/quota and exact inventory gaps recorded; execution gates remain unsatisfied |
| P2A-03B | P2A-R03/R04 | Task 3 RED | in_progress | P2A-01/02/03A | ephemeral hosted CI | bounded budget authorized 2026-09-19 | prerequisites pass, then missing locks assertion fails for intended reason |
| P2A-03C | P2A-R03/R04 | Task 3 lock graph | blocked | P2A-03B | ephemeral hosted CI | CI budget | strict Laravel13/Filament Composer + bounded theme npm resolution and exact locks |
| P2A-03D | P2A-R04 | Task 3 reproduction | blocked | P2A-03C | fresh ephemeral job | CI budget | clean Composer/npm install, audits, theme build, PHP/Livewire/browser/package-asset verification repeat |
| P2A-04 | P2A-R05 | Task 4 health | pending | P2A-03D | ephemeral CI | CI budget | 404 RED then read-only GREEN |
| P2A-05 | P2A-R06 | Task 5 Filament panel (replaces shell) | pending | P2A-04 | ephemeral CI | CI budget | panel guard/config, custom-theme tokens/Vite build, hashed assets, deep-link/browser and approved UI/UX proof |
| P2A-06 | P2A-R07 | Task 6 Filament/Livewire lifecycle (replaces Vue/Preline migration) | pending | P2A-05 | ephemeral CI | CI budget | navigation/focus/backdrop/handler cleanup + no new-panel Preline/Flux/runtime bundle |
| P2A-07 | P2A-R08 | Task 7 reads | pending | P2A-02/05 | isolated PG16/18 CI | CI budget | tenant/schema/query/normalized parity |
| P2A-08 | P2A-R09 | Task 8 auth | pending | P2A-05/07 | isolated CI | CI budget | session/CSRF/policy/rate-limit suite |
| P2A-09 | P2A-R10 | Task 9 adapter | pending | P2A-02/08 | isolated CI | CI budget | exact APK transport/auth differential parity |
| P2A-10 | P2A-R11 | Task 10 command | pending | P2A-07/08 | isolated CI | schema if needed | transactional rename/audit/conflict tests |
| P2A-11 | P2A-R12 | Task 11 handoff | pending | P2A-09/10 | isolated DEV | explicit write-owner | concurrent freeze/drain/rollback proof |
| P2A-12 | P2A-R13 | Task 12 outbox | pending/YAGNI | P2A-10; proven async need | isolated CI | migration approval | crash/retry/dedupe/stale-event proof |
| P2A-13 | P2A-R14 | Task 13 pages | pending | accepted first slice | isolated CI | per slice | page/aggregate-specific parity and writer owner |
| P2A-14 | P2A-R15 | Task 14 Node/TS | pending | Node 26 lifecycle gate | ephemeral CI | CI budget | exact patch/type/protocol/load proof |
| P2A-15 | P2A-R15 | Task 15 Fastify | pending | P2A-14 | isolated CI | CI budget | Express differential + raw ws/lifecycle proof |
| P2A-16 | P2A-R16/R17 | Task 16 package | pending | accepted components | ephemeral CI | publication gate | existing artifact manifest and no runtime install |
| P2A-17 | P2A-R17/R18 | Task 17 staging | blocked | P2A-16 + SEP-09 + PLAT-07 | qualified staging | staging mutation | `/next` coexistence/rollback/physical affected surface |
| P2A-18 | P2A-R18 | Task 18 production | blocked | P2A-17 | production | separate production gates | same accepted artifact, soak, rollback, owner signoff |

Do not start later rows merely because planning is complete. No automatic schedule exists.

## P2A-03A — runnable handoff scope (no application execution)

Source checkout: `/home/am2deploy/am2-main`. Read current `HEAD`, `origin/main`, owned worktrees and dirty status without reset/cleanup. Canonical repo: `AM2-PoC/am2-backend-legacy`.

Read existing files (paths relative to checkout):
- `tests/fixtures/webadmin-api-contract.json`
- `tests/fixtures/webadmin-write-owners.json`
- `tests/contract/webadmin-route-inventory.test.mjs`
- `tests/contract/webadmin-write-ownership.test.mjs`
- `infra/contracts/platform-baseline.json`
- `.github/workflows/source-checks.yml`
- Admin `/home/am2deploy/am2-android-admin/app/src/main/java/com/am2/admin/data/api/ApiService.kt` (confirm current path before reading; no assumed SHA).

Required output: edit only `evidence.md`, section `P2A-03A reconciliation record`. Record source-bound inventory gaps, approved authoring/worktree owner, hosted provider/class (`GitHub-hosted ephemeral non-production`), available minutes/storage/quota evidence, bounded planned runs, and exact pending executor image/runtime pins. Unknown account quota is a blocker for dispatch; ask the repository/account owner (user) for budget evidence and explicit authorization, not a guessed entitlement.

Do not run inventory tests locally on this VPS. Read their assertions/fixtures and current PHP/Node/APK callers. Execution and mutation proof belongs to the future approved hosted gate. No Git fetch/commit/push, CI dispatch, credentials, runtime edits, or installs are part of this reconciliation action.

Exit to P2A-03B: P2A-01 workspace/quota boundary satisfied; P2A-02 current route/writer exit criteria satisfied with source-bound evidence (including hosted proof when required); runner image digest/PHP, theme-build Node, Laravel13/Filament/Vite compatibility candidates resolved; user authorizes bounded hosted CI budget. If any remain unknown, leave RED execution blocked. P2A-03A only completes its discovery record, not those missing proofs.

## Withdrawn implementation tasks / retained IDs

P2A-03C/03D now resolve/reproduce PHP/Filament closure, not npm Vue/Inertia/Vite. P2A-05/06 retain IDs for panel and lifecycle outcomes but supersede the old custom SPA implementation. No old JS task is treated as completed. P2A-14/15 remain the independent relay lane; Node26 is not a prerequisite for PHP-only panel assets. P2A-16 extends the existing publisher with Filament vendor/published asset closure, no second build pipeline. Vite is approved only for the bounded Filament custom-theme graph under `plan.md`; it does not authorize Vue/Inertia, Preline, Flux, animation libraries, a Node runtime, or arbitrary frontend packages. Legacy Preline remains only on untouched legacy routes until their independently proven retirement.
