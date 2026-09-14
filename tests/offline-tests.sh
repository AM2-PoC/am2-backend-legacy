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
# Two declared exclusions for .mjs suites: an import of the credential helper,
# or an explicit exclude marker for a suite that must run elsewhere (reaches a
# live host, or needs root in the restart-safety job).
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
    [ -e "$f" ] || continue
    # Exclusion is declared, never guessed from text. Guessing kept offline
    # suites out of CI for good: a stubbed curl origin, a fixture network call,
    # even the coverage guard's own regex looked networked. A suite is excluded
    # when it imports or re-exports the credential helper -- on any number of
    # lines -- or says so with a `// offline-tests: exclude` marker line.
    #
    # The specifier gap stops at a quote, so a semicolon-less import cannot run
    # on to a later line that only mentions the helper. The whole file is read at
    # once, which also avoids the `sed | grep -q` pipefail race.
    status=0
    perl -0777 -ne '
        exit 1 if /^\s*(?:import|export)\s[^;\x27"]*?[\x27"]\.\/helpers\.mjs[\x27"]/m;
        exit 1 if /^\s*\/\/\s*offline-tests:\s*exclude/m;
    ' "$f" || status=$?
    case $status in
        0) basename "$f" ;;
        1) ;;
        *) echo "offline-tests.sh: cannot classify $f (perl exited $status)" >&2; exit 1 ;;
    esac
done
