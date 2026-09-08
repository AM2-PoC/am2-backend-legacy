# AM2 Backend

**Internal repository:** Not intended for public use or external contributions. Repository access and use require authorization by the repository owner.

Backend runtime for the AM2 push-to-talk platform: Node.js HTTP/WebSocket relay, PHP WebAdmin, PostgreSQL, and Redis.

## Repository map

- `server/` — HTTP/WebSocket relay and protocol logic.
- `WebAdmin/` — operator-facing PHP application.
- `infra/` — immutable artifact, deployment, host-security, and local DEV definitions.
- `tests/` — unit, contract, and protocol verification.
- `docs/` — current tutorials, how-to guides, reference, and explanation.

## Development and delivery

Use only an isolated development machine or ephemeral CI runner. Never use the production host for dependency installation, builds, tests, Docker DEV, or artifact assembly.

```bash
cp .env.example .env
docker compose up -d --wait
```

Start with [`docs/tutorial/your-first-local-am2.md`](docs/tutorial/your-first-local-am2.md). Deployment uses CI-built immutable artifacts; see [`docs/how-to/deploy-and-roll-back.md`](docs/how-to/deploy-and-roll-back.md).

## Verification

```bash
node --test tests/unit/*.test.mjs
docker compose config
```

GitHub Actions is the clean-room gate for dependencies, generated assets, protocol integration, and release-artifact verification.

## Security

This repository does not provide a public vulnerability-reporting channel. Authorized personnel must use the security process assigned to their role. Do not include credentials, personal data, production data, or exploit details in tickets, logs, or pull requests.
