# Contributing

Repository access and contributions require authorization. Do not change visibility, grant access, weaken repository controls, or distribute source or release artifacts outside approved channels.

## Workflow

1. Branch from current `main` using `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `ci/`, or `chore/`.
2. Keep each pull request focused on one change.
3. Use Conventional Commits.
4. Add the smallest regression test that proves changed behavior.
5. Update documentation when a contract or operator procedure changes.
6. Merge only after review and required checks pass.

Do not push directly to `main`. Deployment, restart, publication, signing, and environment changes require separate approval.

## Local checks

Run the narrowest relevant checks first:

```bash
node --test tests/unit/*.test.mjs
docker compose config
git diff --check
```

GitHub Actions performs clean-room dependency, asset, protocol, and release checks. Development commands run only on an isolated development system or ephemeral CI runner, never a runtime host.

## Repository hygiene

Do not commit credentials, personal or production data, database dumps, generated dependencies, local editor state, or assistant workspaces. Keep comments focused on current contracts, non-obvious constraints, and failure behavior.

Security-sensitive changes require focused regression coverage and independent review. Report vulnerabilities through the team's security channel; do not place undisclosed details in issues or pull requests.
