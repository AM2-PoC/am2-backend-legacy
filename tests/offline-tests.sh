#!/bin/bash
#
# Print the contract tests that run anywhere -- no credentials, no network.
#
# CI has neither. Most of this suite needs both: helpers.mjs reads
# /etc/am2/contract-test.env at module scope, and several files talk to the
# staging relay or the panel over HTTP. Those belong on the VPS, run by hand
# before a release.
#
# Computed rather than listed. A hand-maintained list is a list that goes stale
# the first time somebody adds a test and forgets, and the failure is silent in
# the worst direction: a test that never runs looks exactly like a test that
# passes.
#
# Two disqualifiers, and the second is the one that is easy to miss -- a file
# can be credential-free and still be useless in CI because it fetches from
# apiapi.am2-poc.com.
#
# Matching is deliberately on real import statements, not on the text
# "helpers.mjs" anywhere in the file: every offline test in this suite carries a
# header comment promising it must never import that module, and matching the
# promise instead of the import marked all but one file as credential-bound.
set -euo pipefail

DIR="${OFFLINE_TEST_DIR:-$(cd "$(dirname "$0")/contract" && pwd)}"

for f in "$DIR"/*.test.mjs; do
    # Credential-bound: pulls in the helper that reads the protected env file.
    grep -qE "^[[:space:]]*import .*['\"]\./helpers\.mjs" "$f" && continue

    # Network-bound: reaches a running relay, panel or edge. Avoid
    # `sed | grep -q` here: with pipefail, grep can exit early and give sed
    # SIGPIPE on a large file, incorrectly selecting a network test. The small
    # lexer below ignores // comments while preserving :// inside string URLs.
    if ! perl -ne '
        s{//.*$}{} unless /https?:\/\//;
        exit 1 if /fetch\(|https?:\/\/|new WebSocket/;
    ' "$f"; then
        continue
    fi

    basename "$f"
done
