# Internal contribution workflow

This repository is not intended for public contributions. Access and contribution require authorization by the repository owner.

## Workflow

1. Work only in the access scope approved for your role.
2. Create a short-lived `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `ci/`, or `chore/` branch from current `main`.
3. Keep one coherent change per pull request and use Conventional Commits.
4. Add or update the smallest test that proves the behavior.
5. Obtain the required review and all required checks before merge.
6. Do not push directly to `main`, grant access, alter repository visibility, weaken security controls, or share source/artifacts outside approved channels.
7. Never commit credentials, personal data, customer data, APKs, keystores, database dumps, generated dependencies, or local editor/AI state.

Production is a runtime target, not a development machine. Dependency installation, builds, tests, Docker DEV, and artifact assembly run only on isolated developer systems or ephemeral CI.

## Verification

Run the narrowest relevant check first. GitHub Actions is authoritative for the clean-room gate.

```bash
node --test tests/unit/*.test.mjs
docker compose config
git diff --check
```

Authentication, authorization, release tooling, workflows, schemas, update channels, and host/runtime boundaries need focused regression coverage and independent review.

## Security reports

Use the approved internal security-reporting channel. Do not place undisclosed vulnerability details, credentials, personal data, customer data, or destructive proof-of-concept payloads in issues, pull requests, logs, or fixtures.
