#!/usr/bin/env bash
# Protocol tests share staging users, channels, and a single relay. Running the
# files concurrently makes one file's permission/session mutation race another.
set -euo pipefail

cd "$(dirname "$0")/.."
exec node --test --test-concurrency=1 tests/protocol/*.test.mjs