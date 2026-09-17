# AM2 Backend

Backend services for the AM2 push-to-talk platform.

## Components

- `server/`: Node.js HTTP/WebSocket relay and protocol logic
- `WebAdmin/`: PHP operator console
- `infra/`: development, packaging, deployment, and host configuration
- `tests/`: unit, contract, protocol, and release checks
- `docs/`: developer and operator documentation

## Local development

Use an isolated development machine or ephemeral CI runner.

```bash
cp .env.example .env
docker compose up -d --wait
```

See [Your first local AM2](docs/tutorial/your-first-local-am2.md) for setup and [Deploy and roll back](docs/how-to/deploy-and-roll-back.md) for delivery procedures.

## Tests

```bash
node --test tests/unit/*.test.mjs
docker compose config
```

Additional checks run in GitHub Actions. Do not run dependency installation, builds, tests, or artifact assembly on a runtime host.
