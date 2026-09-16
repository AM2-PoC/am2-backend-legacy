# Backend contracts

Current contracts are defined by source and executable checks:

- [Security posture](../explanation/security-posture.md) documents authentication, authorization, session, CSRF, edge, and host-security boundaries.
- [Channel access contract](channel-access-contract.md) documents membership invariants and the sole writer.
- [Android environments](android-environments.md) defines package and endpoint identities.
- `tests/fixtures/webadmin-api-contract.json` inventories WebAdmin API routes.
- `tests/fixtures/webadmin-write-owners.json` records write ownership.
- `tests/contract/webadmin-route-inventory.test.mjs` and `tests/contract/webadmin-write-ownership.test.mjs` reject route and writer drift.
- `tests/contract/api-and-authz.test.mjs`, `panel-endpoints.test.mjs`, and `source-and-markup.test.mjs` cover request, response, authorization, form, and markup compatibility.

Do not duplicate line-number inventories here. Inspect the current source and contract tests when changing an endpoint or browser workflow.
