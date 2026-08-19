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

# Restart-closure contracts are explicit CI invariants. Keeping these names in
# the selector also makes their absence visible to the integration contract.
RESTART_SAFETY_TESTS=(
    needrestart-policy.test.mjs
    release-runtime.test.mjs
    release-smoke.test.mjs
    relay-watchdog.test.mjs
    systemd-relay-safety.test.mjs
)

# PHP contract tests, selected the same way and for the same reason. They were
# left out when this selector was written, which meant neither of them had ever
# run: one was calling a function that was never implemented, and the suite
# stayed green throughout. The disqualifiers differ by language -- a bare
# "https://" in PHP here is fixture data for URL validation, not a request --
# so the network markers below match calls, not strings.
for f in "$DIR"/*.test.php; do
    [ -e "$f" ] || continue
    grep -qE "file_get_contents\([[:space:]]*['\"]https?:|curl_[a-z_]+\(|fsockopen\(|fopen\([[:space:]]*['\"]https?:|getenv\(" "$f" && continue
    basename "$f"
done

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
