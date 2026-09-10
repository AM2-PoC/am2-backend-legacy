# WebAdmin UI implementation notes

Current component versions and durable UI behavior are documented in
[`docs/reference/preline-component-map.md`](../reference/preline-component-map.md).

Builds and source-only tests run only in ephemeral non-production CI or an
isolated development machine. The runtime VPS and its co-resident operator
checkout are not build or test environments.

Deployment uses the immutable artifact procedure in
[`docs/how-to/deploy-and-roll-back.md`](../how-to/deploy-and-roll-back.md).
Do not copy a checkout into staging, run dependency installers on the runtime
host, or bypass artifact verification and materialization.
