# Contributing

## Workflow

1. Create a short-lived `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `ci/`, or `chore/` branch from current `main`.
2. Keep one coherent change per pull request and use Conventional Commits.
3. Add or update the smallest test that proves the behavior.
4. Open a pull request and wait for every required check and review.
5. Never push directly to `main`, force-push shared branches, or commit generated dependencies, secrets, credentials, APKs, keystores, database dumps, or local AI/editor state.

Production is a runtime target, not a development machine. Dependency installation, builds, tests, Docker DEV, and artifact assembly run only on an isolated developer machine or ephemeral CI.

## Verification

Run the narrowest relevant local check first. GitHub Actions is authoritative for the complete clean-room gate.

```bash
node --test tests/unit/*.test.mjs
docker compose config
git diff --check
```

Changes to authentication, authorization, release tooling, workflows, schemas, update channels, or runtime/host boundaries require focused regression coverage and independent review.

## Security reports

Follow [`SECURITY.md`](SECURITY.md). Never include secrets or personal data in issues, pull requests, logs, or fixtures.
