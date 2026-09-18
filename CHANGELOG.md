# Changelog

Notable operator- and user-facing changes are recorded here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- Deployment commands reject unknown arguments instead of ignoring them or falling through.

## 1.1.0 - 2026-09-17

### Added

- Verified host-security materialization and activation, staging rehearsal, production promotion, rollback, and artifact-boundary checks.

### Changed

- WebAdmin assets use content-digest URLs, with immutable caching limited to versioned assets.

### Fixed

- Release promotion verifies payload identity, runtime Node identity, required page assets, and the active PHP release path.
- Admin clients receive the server's actual duplicate-unit response.

## 1.0.0 - 2026-09-04

- First recorded immutable backend release baseline.
