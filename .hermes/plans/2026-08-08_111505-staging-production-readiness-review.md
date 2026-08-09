# Staging-to-Production Readiness Review Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Determine whether the exact release currently exercised in staging is safe to promote to production and whether its pull request(s) are ready to merge into `main`, with a reproducible go/no-go record.

**Architecture:** Treat this as an atomic-release gate, not a review of PR #2 alone. The proposed production release is the cumulative stack from `main` (`2a9b004`) through `feat/ui-typography-refresh` (`03be76a`): 97 commits and 118 changed files across PRs #1–#7 and #9–#11. First reconstruct a clean immutable candidate, prove it matches the deployed staging code, review the cumulative diff and infrastructure, then execute static, contract, protocol, migration, UI, security, backup, rollback, and GitHub merge gates before merging the stack into `main`.

**Tech Stack:** PHP/Apache, Node.js 22/Express/WebSocket, PostgreSQL, Redis, nginx, systemd, Cloudflare, Node built-in test runner, npm, Docker Compose, git, GitHub CLI.

---

## Current context and provisional verdict

**Provisional verdict: NO-GO. Staging is reachable, but the candidate is not yet proven ready for production and the PR stack is not ready to merge to `main`.**

Observed on 2026-08-08:

- Production health probes return HTTP 200; `nginx`, `apache2`, `postgresql`, `redis-server`, and `am2-api` are active.
- Staging internal and public login probes return HTTP 200; `am2-api-staging` is active; the public response carries `X-Robots-Tag: noindex, nofollow` and `X-Content-Type-Options: nosniff`.
- Production points to `/var/www/am2/releases/20260503175410`; staging points directly to `/var/www/am2/staging/repo`.
- The staging worktree is dirty: dozens of modified/deleted/untracked application files. Its branch says `fix/security-hardening`, is one commit behind its remote, and HEAD is `13e80ff`, while deployed key files byte-match the later `feat/ui-typography-refresh` candidate.
- Of 118 files tracked by the candidate, 78 deployed staging files match, 9 differ, and 31 are absent. The absent set includes migrations, test files, Docker files, and release documentation. Therefore no immutable commit currently identifies exactly what was tested in staging.
- The intended cumulative candidate is 97 commits / 118 files ahead of `main`.
- GitHub shows ten open chained PRs (#1–#7 and #9–#11), all mergeable/clean, but none has CI checks, requested reviewers, submitted reviews, or a direct cumulative PR to `main`.
- The repo has no `.github/workflows/` CI.
- The release is explicitly atomic (`docs/explanation/release-boundary.md`); merging or deploying isolated PR #2 would not represent the tested release.
- Staging contains a copy of production personal data and currently has no additional access control beyond normal login (`docs/how-to/use-the-staging-environment.md:69-72`). This needs an explicit accepted exception or a gate before broader review/use.
- `infra/apache/am2-webadmin-staging.conf` lacks the production vhost’s `FilesMatch` deny rules. No currently tracked sensitive setup/archive file was found under `WebAdmin`, but staging and production vhost parity still requires an explicit test.

The remaining tasks collect the evidence required to change the verdict to GO. No task may be waived silently.

## Release candidate under review

- Base: `main` at `2a9b004db6e57c1482de48299ca59d9e87d10a88`
- Intended head: `feat/ui-typography-refresh` at `03be76a0a4d08debd4d096d659b167a77ec9207a`
- Stacked PRs: #1, #2, #3, #4, #5, #6, #7, #9, #10, #11
- Deployment model: atomic release directory plus `/var/www/am2/current` symlink
- Required test target: a clean checkout/archive of exactly `03be76a`, not the current dirty staging tree

---

### Task 1: Freeze and inventory the candidate

**Objective:** Create a review record that names the exact base, head, PR stack, commit count, changed files, and current production/staging deployment identities.

**Files:**
- Create: `docs/reviews/2026-08-08-production-readiness.md`
- Reference: `docs/explanation/release-boundary.md`
- Reference: `docs/how-to/deploy-and-roll-back.md`

**Step 1: Record repository and deployment identities**

Run:

```bash
git fetch --all --prune
git rev-parse main feat/ui-typography-refresh
git rev-list --count main..feat/ui-typography-refresh
git diff --name-status main...feat/ui-typography-refresh
readlink -f /var/www/am2/current
readlink -f /var/www/am2/staging/current
```

Expected: base `2a9b004...`, head `03be76a...`, 97 candidate commits, 118 changed files, and both deployment targets recorded.

**Step 2: Record the entire PR stack and GitHub gates**

Run:

```bash
for n in 1 2 3 4 5 6 7 9 10 11; do
  gh pr view "$n" --json number,title,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviewRequests,reviews,url
 done
```

Expected: every adjacent base/head relation is documented. Any changed SHA invalidates prior evidence and restarts Tasks 2–10.

**Step 3: Write the review header and gate matrix**

Include:

```markdown
| Gate | Evidence | Result | Blocking owner |
|---|---|---|---|
| Immutable staging artifact | commit/tree identity | PENDING | release owner |
| Cumulative code review | findings by severity | PENDING | reviewer |
| Static/build checks | command transcripts | PENDING | engineering |
| Contract/protocol tests | command transcripts | PENDING | engineering |
| Migration/rollback rehearsal | restore evidence | PENDING | operations |
| Security/data isolation | probes and accepted exceptions | PENDING | security/owner |
| Manual staging acceptance | checklist with operator/time | PENDING | product/operator |
| GitHub merge gates | CI + approval + mergeability | PENDING | repository owner |
```

**Step 4: Commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): start production-readiness record"
```

---

### Task 2: Replace the dirty staging tree with an immutable candidate

**Objective:** Ensure every subsequent staging test exercises exactly `03be76a` with no untracked or patched application files.

**Files:**
- Modify operationally: `/var/www/am2/staging/current`
- Create operationally: `/var/www/am2/staging/releases/03be76a0a4d08debd4d096d659b167a77ec9207a/`
- Do not modify: `/var/www/am2/current`

**Step 1: Preserve forensic evidence of the current dirty tree**

Run:

```bash
sudo -u am2deploy git -C /var/www/am2/staging/repo status --porcelain=v1 > /tmp/am2-staging-pre-freeze.status
sudo -u am2deploy git -C /var/www/am2/staging/repo diff --binary > /tmp/am2-staging-pre-freeze.patch
```

Expected: the status file records the current drift; no cleanup occurs yet.

**Step 2: Materialize the exact candidate into a new release directory**

Run:

```bash
CANDIDATE=03be76a0a4d08debd4d096d659b167a77ec9207a
STAGE_REL=/var/www/am2/staging/releases/$CANDIDATE
sudo install -d -o am2deploy -g www-data -m 750 "$STAGE_REL"
sudo -u am2deploy bash -c "git -C /home/am2deploy/am2-main archive $CANDIDATE | tar -x -C $STAGE_REL"
sudo -u am2deploy bash -c "cd $STAGE_REL/server && npm ci --omit=dev"
```

Expected: a clean release directory containing only the candidate archive plus runtime dependencies.

**Step 3: Point staging at the candidate and restart only staging**

Run:

```bash
sudo ln -sfn "$STAGE_REL" /var/www/am2/staging/current
sudo systemctl reload apache2
sudo systemctl restart am2-api-staging
```

Expected: production symlink and `am2-api` PID remain unchanged.

**Step 4: Prove byte identity**

Run a script that compares every candidate file from `git ls-tree -r --name-only "$CANDIDATE"` with `/var/www/am2/staging/current/<path>` and fails on any changed/missing file. Exclude only generated runtime dependency directories not tracked by git.

Expected: 118 tracked candidate files match, 0 differ, 0 are missing.

**Step 5: Record the candidate identity**

Add the exact SHA, release path, comparison counts, command transcript, and time to `docs/reviews/2026-08-08-production-readiness.md`.

**Step 6: Commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): record immutable staging candidate"
```

---

### Task 3: Review the cumulative application and infrastructure diff

**Objective:** Find correctness, security, compatibility, performance, and operability defects across the whole atomic candidate rather than approving each stacked delta in isolation.

**Files:**
- Review: every path from `git diff --name-only main...feat/ui-typography-refresh`
- Prioritize: `WebAdmin/config.php`
- Prioritize: `WebAdmin/api_*.php`
- Prioritize: `WebAdmin/admin_panel.php`
- Prioritize: `WebAdmin/channels.php`
- Prioritize: `WebAdmin/user_access.php`
- Prioritize: `WebAdmin/users.php`
- Prioritize: `WebAdmin/settings.php`
- Prioritize: `server/server.js`
- Prioritize: `server/lib/*.js`
- Prioritize: `infra/apache/*.conf`
- Prioritize: `infra/nginx/*.conf`
- Prioritize: `infra/systemd/*.service`
- Prioritize: `infra/migrations/*.sql`
- Update: `docs/reviews/2026-08-08-production-readiness.md`
- Test findings in: `tests/contract/*.test.mjs` or `tests/protocol/*.test.mjs`

**Step 1: Partition the review**

Review independently by domain:

1. PHP authentication, identity, authorization, CSRF, sessions, file upload/restore.
2. Tenant/channel/user data integrity and destructive actions.
3. Node HTTP routes, WebSocket protocol, state, database and Redis behavior.
4. UI runtime, generated assets, accessibility, responsive behavior and i18n.
5. nginx/Apache/systemd isolation, TLS, headers, writable paths and restart behavior.
6. Database migrations, indexes, lock duration and backward compatibility.
7. Deployment, backup, rollback, observability and failure recovery.

**Step 2: Require full-context review**

For each changed file, inspect both:

```bash
git diff main...feat/ui-typography-refresh -- path/to/file
git show feat/ui-typography-refresh:path/to/file
```

Do not accept a diff-only review for security-sensitive or stateful code.

**Step 3: Scan added lines for known-dangerous patterns**

Run checks for hardcoded secrets, `eval`/`exec`, shell execution, SQL interpolation, path traversal, unsafe upload/restore handling, debug statements, conflict markers, production host/port literals, and unauthenticated mutations.

Expected: every match is manually classified and recorded; critical/high findings are blockers.

**Step 4: Add a regression test before fixing each blocker**

For each confirmed bug:

1. Add a failing test under the exact relevant test file.
2. Run the focused test and capture the expected failure.
3. Apply the minimal code/config fix.
4. Run the focused test and capture PASS.
5. Re-run the domain suite.

**Step 5: Record findings in severity order**

Use:

```markdown
### Critical
- `path:line` — impact, exploit/failure path, required fix, test.

### High
...

### Medium / Low
...

### Accepted risk
- owner, rationale, expiry/revisit condition.
```

**Step 6: Independent review**

Send the cumulative diff and static-scan results to a fresh reviewer. Require separate verdicts for security and logic. Unparseable review output fails closed.

**Step 7: Commit fixes and review record in small units**

```bash
git add <test> <implementation> docs/reviews/2026-08-08-production-readiness.md
git commit -m "fix(<scope>): <specific reviewed blocker>"
```

Any fix changes the candidate SHA; update Task 1 and redeploy through Task 2.

---

### Task 4: Validate generated assets, syntax, dependencies, and local runtime

**Objective:** Prove the immutable candidate can be rebuilt and parsed from lockfiles without relying on files hand-built in staging.

**Files:**
- Verify: `WebAdmin/package.json`
- Verify: `WebAdmin/package-lock.json`
- Verify: `WebAdmin/asset/css/am2-tailwind.css`
- Verify: `WebAdmin/asset/js/am2-ui.min.js`
- Verify: `server/package.json`
- Verify: `server/package-lock.json`
- Verify: `docker-compose.yml`
- Verify: `infra/docker/*`
- Update: `docs/reviews/2026-08-08-production-readiness.md`

**Step 1: Install from lockfiles in a clean worktree**

Run:

```bash
npm --prefix WebAdmin ci
npm --prefix server ci
```

Expected: zero install errors and no lockfile modifications.

**Step 2: Rebuild frontend assets**

Run:

```bash
npm --prefix WebAdmin run build
git diff --exit-code -- WebAdmin/asset/css/am2-tailwind.css WebAdmin/asset/js/am2-ui.min.js
```

Expected: generated assets are reproducible; `git diff --exit-code` exits 0.

**Step 3: Syntax-check all application sources**

Run:

```bash
find WebAdmin -maxdepth 1 -name '*.php' -print0 | xargs -0 -n1 php -l
find server -path '*/node_modules' -prune -o -name '*.js' -print0 | xargs -0 -n1 node --check
```

Expected: every PHP and JavaScript file parses successfully.

**Step 4: Audit production dependencies**

Run:

```bash
npm --prefix WebAdmin audit --omit=dev
npm --prefix server audit --omit=dev
```

Expected: no known critical/high vulnerability without an explicitly documented exception.

**Step 5: Exercise the clean local stack**

Run:

```bash
cp .env.example .env
docker compose config --quiet
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:8080/login.php >/dev/null
curl -fsS http://127.0.0.1:5000/ >/dev/null
docker compose down -v
```

Expected: all services become healthy, both probes pass, and teardown succeeds.

**Step 6: Record results and commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): record build and static verification"
```

---

### Task 5: Run the complete staging contract and protocol suites

**Objective:** Prove behavior, authorization, UI source contracts, sessions, and real WebSocket relay behavior against the exact candidate.

**Files:**
- Test: `tests/contract/activity-log.test.mjs`
- Test: `tests/contract/api-and-authz.test.mjs`
- Test: `tests/contract/api-auth.test.mjs`
- Test: `tests/contract/channel-access.test.mjs`
- Test: `tests/contract/csrf.test.mjs`
- Test: `tests/contract/dead-code.test.mjs`
- Test: `tests/contract/i18n.test.mjs`
- Test: `tests/contract/identity.test.mjs`
- Test: `tests/contract/panel-endpoints.test.mjs`
- Test: `tests/contract/session-order.test.mjs`
- Test: `tests/contract/session.test.mjs`
- Test: `tests/contract/settings-authz.test.mjs`
- Test: `tests/contract/source-and-markup.test.mjs`
- Test: `tests/contract/table.test.mjs`
- Test: `tests/contract/typography.test.mjs`
- Test: `tests/contract/ui-runtime.test.mjs`
- Test: `tests/protocol/ptt-protocol.test.mjs`
- Verify: `tests/mutation-check.sh`
- Update: `docs/reviews/2026-08-08-production-readiness.md`

**Step 1: Refresh guarded fixtures**

Run:

```bash
sudo infra/scripts/contract-test-fixtures.sh
sudo infra/scripts/ptt-harness-fixtures.sh
```

Expected: scripts positively identify `am2_staging` and refuse production.

**Step 2: Run the full contract suite against direct staging Apache**

Run:

```bash
CT_SRC_DIR=/var/www/am2/staging/current/WebAdmin \
CT_SERVER_JS=/var/www/am2/staging/current/server/server.js \
node --test tests/contract/*.test.mjs
```

Expected: all tests pass against `http://127.0.0.1:8081` with the staging Host header, not a Cloudflare-cached public page.

**Step 3: Run the protocol harness**

Run:

```bash
node --test tests/protocol/*.test.mjs
```

Expected: two clients authenticate, join, key/release PTT, and relay audio on port 5001 with no contact to production port 5000.

**Step 4: Prove the test suite detects mutations**

Run:

```bash
sudo tests/mutation-check.sh
```

Expected: every mutation reports `caught`; any `ESCAPED` result blocks release.

**Step 5: Repeat each suite once**

Expected: no order-dependent or flaky failures. Keep both transcripts.

**Step 6: Record exact pass counts and commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): record staging test evidence"
```

---

### Task 6: Rehearse migrations, backup restoration, and rollback

**Objective:** Prove the data and release rollback paths, including both candidate migrations, before production is touched.

**Files:**
- Verify: `infra/migrations/001_ptt_logs_channel_time_index.sql`
- Verify: `infra/migrations/002_admin_activity_logs_structured.sql`
- Verify: `docs/how-to/deploy-and-roll-back.md`
- Verify: `docs/how-to/use-the-staging-environment.md`
- Update: `docs/reviews/2026-08-08-production-readiness.md`

**Step 1: Create and validate a fresh production dump**

Run:

```bash
sudo systemctl start am2-backup.service
NEWEST=$(ls -1t /var/backups/am2/postgres/*.dump | head -1)
sudo -u postgres pg_restore -l "$NEWEST" | grep -c 'TABLE DATA'
```

Expected: 10 table-data entries as documented. A file’s existence or size alone does not pass.

**Step 2: Restore the dump into a disposable rehearsal database**

Create a dedicated `am2_release_rehearsal` database with production collation (`en_US.UTF-8`), restore the dump, and verify restore exit status is 0.

Expected: no ownership/default-privilege errors and representative row counts match the source dump.

**Step 3: Apply migrations in candidate order**

Run each migration once, validate schema/index/event columns, then run it a second time only if documented as idempotent. If not idempotent, record that the release automation must track migration state.

Expected: first application succeeds; lock time and affected rows are measured; compatibility with the pre-swap code is explicitly established or a maintenance window is required.

**Step 4: Run the complete suites against migrated rehearsal/staging data**

Expected: Tasks 5 tests remain green after migrations.

**Step 5: Rehearse code rollback**

Swap staging from candidate to the prior clean release and back using symlinks, reload Apache, and restart only `am2-api-staging`.

Expected: both transitions pass login/read/write/protocol smoke tests.

**Step 6: Rehearse data rollback**

Restore the pre-migration dump to the disposable rehearsal database using the exact documented command and verify post-restore behavior.

Expected: rollback returns schema and row counts to the pre-migration state.

**Step 7: Record measured durations and commit**

Record backup, restore, migration, service restart, and rollback durations, plus the required maintenance window.

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): record migration and rollback rehearsal"
```

---

### Task 7: Verify staging/production isolation and edge hardening

**Objective:** Prove staging cannot mutate or signal production, and close or explicitly accept the exposure of production-derived personal data.

**Files:**
- Verify/possibly modify: `infra/apache/am2-webadmin-staging.conf`
- Verify/possibly modify: `infra/apache/am2-webadmin-internal.conf`
- Verify/possibly modify: `infra/nginx/am2-webadmin-staging.conf`
- Verify/possibly modify: `infra/nginx/am2-webadmin.conf`
- Verify/possibly modify: `infra/systemd/am2-api-staging.service`
- Verify/possibly modify: `WebAdmin/config.php`
- Test: `tests/contract/api-auth.test.mjs`
- Test: `tests/contract/channel-access.test.mjs`
- Create if needed: `tests/contract/deployment-isolation.test.mjs`
- Update: `docs/reviews/2026-08-08-production-readiness.md`

**Step 1: Compare sanitized environments without printing secrets**

Verify only names/targets:

- staging DB is `am2_staging`; production DB is `am2`
- staging node port is 5001; production node port is 5000
- staging Redis database is 3; production is 0
- API keys are present and environments use the intended auth mode
- writable paths do not overlap

Expected: no shared writable application, upload, log, DB, or Redis namespace.

**Step 2: Add an automated isolation test**

Write `tests/contract/deployment-isolation.test.mjs` to assert effective vhost/service/environment targets without emitting credential values. Include a probe that performs a fixture-only staging mutation and proves no corresponding production fixture/state change occurs.

Expected initial result: FAIL until every isolation assertion is observable and correct.

**Step 3: Verify relay isolation**

Temporarily observe access/log counters on both relay units, perform staging force-logout/sync/update fixture actions, and assert only `am2-api-staging` receives them.

Expected: zero production relay calls caused by staging actions.

**Step 4: Verify edge and Apache parity**

Probe dotfiles, `.env`, `.ini`, `.log`, `.bak`, `.sql`, archives, and setup/installer names on both hosts. Confirm staging cannot serve a class of sensitive file that production denies.

Expected: 403/404 on both environments. If the staging Apache vhost fails parity, add the same `FilesMatch` rules or factor shared rules into one included config, then test nginx and Apache configurations:

```bash
sudo apache2ctl configtest
sudo nginx -t
```

**Step 5: Decide the production-data exposure gate**

Choose and document one:

1. Put staging behind Cloudflare Access/VPN/IP allowlisting before release validation continues.
2. Replace copied personal fields with a deterministic sanitization process and verify row-level masking.
3. Accept the risk explicitly with named owner, access audit, and expiry date.

No implicit acceptance.

**Step 6: Run security probes**

Verify TLS, secure cookie flags, HSTS/CSP/frame/referrer policies as intended, direct ports blocked externally, admin routes denied or authenticated, rate limiting, CSRF, tenant isolation, upload/restore boundaries, and absence of sensitive response/log disclosure.

**Step 7: Re-run all affected tests and commit**

```bash
node --test tests/contract/deployment-isolation.test.mjs tests/contract/api-auth.test.mjs tests/contract/channel-access.test.mjs
git add infra tests docs/reviews/2026-08-08-production-readiness.md
git commit -m "test(infra): enforce staging and production isolation"
```

---

### Task 8: Perform manual staging acceptance on the immutable candidate

**Objective:** Validate real browser/device workflows that source and contract tests cannot prove.

**Files:**
- Update: `docs/reviews/2026-08-08-production-readiness.md`
- Reference: `docs/explanation/webadmin-rebuild.md`
- Reference: `docs/reference/backend-contract.md`
- Reference: `docs/reference/channel-access-contract.md`

**Step 1: Record test matrix**

Cover:

- superadmin and branch-admin roles
- desktop and mobile breakpoints
- dark and light themes
- Indonesian and English
- login, idle timeout, logout and failed-login throttling
- dashboard, channels, units, user access, admin panel, activity log, live tracking, settings
- create/update/delete/restore/backup actions using only `ct_*` fixtures
- Admin Native API compatibility
- real handset PTT join/transmit/release/reconnect

**Step 2: Run read-only flows first**

Expected: no console errors, broken assets, stale Cloudflare content, overflow, inaccessible controls, or cross-tenant data.

**Step 3: Run fixture-only write flows**

Expected: successful mutation, correct audit event, correct tenant scoping, correct staging relay notification, and no production effect.

**Step 4: Verify operational behavior**

Check nginx/Apache/Node/PostgreSQL/Redis logs during the matrix. Record error counts, slow requests, unexpected restarts, and WebSocket reconnect time.

**Step 5: Obtain named acceptance**

Record tester, timestamp, candidate SHA, browsers/devices, and explicit PASS/FAIL. Screenshots may support evidence but do not replace test steps.

**Step 6: Commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): record manual staging acceptance"
```

---

### Task 9: Establish a mergeable GitHub release boundary

**Objective:** Make GitHub represent the atomic candidate that was actually reviewed and tested.

**Files:**
- Create/modify: `.github/workflows/production-readiness.yml`
- Modify: PR structure/metadata on GitHub
- Update: `docs/reviews/2026-08-08-production-readiness.md`

**Step 1: Decide how the stack lands**

Preferred: create one release PR from the frozen candidate branch to `main`, preserving the exact tested tree. Alternative: retarget and merge stacked PRs bottom-up only if each merge preserves the final tested tree and the release PR remains blocked until all predecessors land.

Expected: there is exactly one GitHub object whose diff to `main` equals the tested candidate.

**Step 2: Add CI for deterministic repository gates**

The workflow should:

1. install Node dependencies with `npm ci`
2. rebuild WebAdmin assets and fail on generated diff
3. run PHP and Node syntax checks
4. run local/source-only tests that do not require staging secrets
5. validate Docker Compose
6. scan dependencies and secrets
7. validate nginx/Apache/systemd configuration in suitable containers or test hosts
8. upload command logs/test reports

Do not put staging credentials or production-derived data in GitHub Actions.

**Step 3: Require review and green checks**

Configure/request:

- at least one independent approving review
- all required CI checks successful
- no unresolved review threads
- branch up to date with `main`
- candidate SHA unchanged since staging acceptance

**Step 4: Re-run GitHub status checks**

Run:

```bash
gh pr checks <release-pr-number>
gh pr view <release-pr-number> --json headRefOid,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews
```

Expected: checks green, `mergeable=MERGEABLE`, clean merge state, approval present, and head SHA equals the accepted staging SHA.

**Step 5: Commit CI and update evidence**

```bash
git add .github/workflows/production-readiness.yml docs/reviews/2026-08-08-production-readiness.md
git commit -m "ci: enforce production-readiness gates"
```

A changed head SHA requires redeploying that exact SHA and repeating affected gates.

---

### Task 10: Issue final go/no-go and execute the production runbook

**Objective:** Promote only after every blocker is closed and verify production with a timed rollback threshold.

**Files:**
- Finalize: `docs/reviews/2026-08-08-production-readiness.md`
- Follow: `docs/how-to/deploy-and-roll-back.md`

**Step 1: Apply the release checklist**

GO requires all of:

- immutable staging tree equals release PR head
- no open critical/high review finding
- builds, syntax, dependency gates, and local stack pass
- complete contract/protocol/mutation suites pass twice
- migrations and data rollback rehearsed
- staging/production isolation proven
- personal-data exposure controlled or explicitly accepted
- manual staging acceptance recorded
- fresh validated production backup exists
- independent GitHub approval and required checks are green
- rollback target and operator are named

Anything else is NO-GO.

**Step 2: Merge the atomic release**

Merge only the tested release PR to `main`; do not deploy a mixed set of files or isolated PR #2.

**Step 3: Verify merged tree identity**

Run:

```bash
git fetch origin
git diff --exit-code <accepted-candidate-sha>^{tree} origin/main^{tree}
```

Expected: tree objects are identical, or any merge-only metadata difference is explained while file contents remain identical.

**Step 4: Take and validate the pre-deploy backup**

Use the commands in `docs/how-to/deploy-and-roll-back.md:14-30`; record backup path and table-data count.

**Step 5: Deploy as a new immutable release directory**

Use `git archive origin/main`, install server dependencies, create shared runtime symlinks, syntax-check, swap `/var/www/am2/current`, reload Apache, and restart `am2-api` only because `server/` changed.

**Step 6: Run production smoke tests**

Verify:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/login.php -H 'Host: webadmin.am2-poc.com'
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/ -H 'Host: apiapi.am2-poc.com'
systemctl is-active nginx apache2 postgresql redis-server am2-api
```

Then run one read, one controlled write, one Admin Native API path, and one real handset PTT cycle. Watch service and application logs.

**Step 7: Enforce rollback criteria**

Immediately roll back the symlink (and database if required) for authentication failure, authorization/tenant breach, migration error, elevated 5xx rate, failed PTT relay, unrecoverable UI path, or smoke-test failure. Do not patch individual production files.

**Step 8: Finalize the review record**

Record final verdict, merged PR, accepted SHA, deployed release path, backup path, start/end time, smoke results, incidents, and rollback status.

**Step 9: Commit**

```bash
git add docs/reviews/2026-08-08-production-readiness.md
git commit -m "docs(release): finalize production deployment evidence"
```

---

## Files likely to change

- `.github/workflows/production-readiness.yml`
- `docs/reviews/2026-08-08-production-readiness.md`
- `infra/apache/am2-webadmin-staging.conf` if parity probes expose gaps
- `infra/apache/am2-webadmin-internal.conf` if shared hardening is factored
- `infra/nginx/am2-webadmin-staging.conf` if access/security policy changes
- `tests/contract/deployment-isolation.test.mjs`
- Any application/test file implicated by cumulative review findings; every such change must have a focused regression test

## Tests and validation summary

- Exact tree comparison between release PR head and deployed staging
- Cumulative diff review with independent reviewer
- `npm ci`, reproducible frontend build, PHP lint, Node syntax checks
- npm production dependency audit
- Docker Compose clean-stack smoke
- all `tests/contract/*.test.mjs`, twice
- all `tests/protocol/*.test.mjs`, twice
- `tests/mutation-check.sh`
- migration apply/validate/rehearse rollback
- backup archive listing and full disposable restore
- nginx/Apache/systemd validation
- staging-to-production isolation test
- manual browser/device/role/language/theme matrix
- GitHub CI, independent approval, merge-state and SHA identity gates
- post-deploy production read/write/API/PTT smoke and log watch

## Risks and tradeoffs

- **Largest risk:** staging currently serves a hand-mutated tree, so its successful behavior cannot yet be attributed to a commit.
- **Atomic release risk:** 97 commits and 118 files cross security, UI, relay, data, and operations boundaries. Per-PR mergeability is not cumulative release readiness.
- **No CI/review risk:** GitHub currently provides neither automated nor independent human gates.
- **Personal-data risk:** staging contains production-derived personal data without an extra access layer.
- **Migration risk:** code rollback is instant, but schema rollback requires a validated dump and service downtime.
- **Connection risk:** restarting production `am2-api` drops live WebSocket clients; deploy in a quiet window and measure reconnects.
- **Cache risk:** Cloudflare can make public staging tests observe stale assets/pages; contract tests must use direct Apache.
- **Reviewability tradeoff:** one release PR is large, but it accurately represents the project’s documented atomic release boundary. The existing chained PRs remain useful as review slices, not as independent production units.

## Open questions requiring named decisions

1. Is `feat/ui-typography-refresh` (`03be76a`) the intended release head, or is another branch/commit the actual candidate?
2. Who accepts or remediates staging’s production-derived personal-data exposure?
3. Who is the independent approving reviewer?
4. What is the production maintenance window and rollback decision timeout?
5. Are migrations 001 and 002 already applied to production or staging, and where is migration state recorded?
6. Should the PR stack be represented by a new direct release PR to `main`, or merged bottom-up with an exact-tree verification gate?
7. What quantitative thresholds trigger rollback (5xx rate, latency, reconnect time, error count)?

## Final decision rule

Do not promote or merge to `main` based only on HTTP 200, service activity, clean GitHub mergeability, or a subset of stacked PRs. Mark GO only when the exact tested tree is immutable and equal to the release PR head, every mandatory gate above is evidenced, and no blocking finding remains.
