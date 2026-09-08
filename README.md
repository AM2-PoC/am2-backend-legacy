# AM2 Backend

Backend runtime for the AM2 push-to-talk platform: Node.js HTTP/WebSocket relay, PHP WebAdmin, PostgreSQL, and Redis.

## Repository map

- `server/` — HTTP/WebSocket relay and protocol logic.
- `WebAdmin/` — operator-facing PHP application.
- `infra/` — immutable artifact, deployment, host-security, and local DEV definitions.
- `tests/` — unit, contract, and protocol verification.
- `docs/` — current tutorials, how-to guides, reference, and explanation.

## Local development

Use only an isolated development machine or ephemeral CI runner. Do not run the development stack on a production host.

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

The offline contract selector emits both Node and PHP tests; run it through the source-check workflow rather than forcing every file through one local runner.

GitHub Actions remains the authoritative clean-room gate for dependency installation, generated assets, protocol integration, and runtime artifact verification.

## Security

Report vulnerabilities privately according to [`SECURITY.md`](SECURITY.md). Do not open a public issue containing credentials, personal data, or exploit details.
