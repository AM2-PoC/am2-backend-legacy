#!/usr/bin/env bash
set -euo pipefail

# Periodic host-security drift audit: silent when healthy, loud when not.
#
# Silence is the whole design. An audit that prints something reassuring on
# every run trains everybody to skim past it, and the one run that mattered
# scrolls by with the rest. This prints nothing at all on a healthy host, so
# any output from it is news, and a timer can mail it without a filter.
#
# It answers one question -- do the installed bytes still match the receipt --
# by running the installed-state verifier rather than by re-deriving the checks,
# so an invariant tightened there is tightened here on the same day.
#
# It reports; it never repairs. Fixing drift means materializing the intended
# bytes and running the separately approved activation, which is a decision a
# human makes.

usage() {
    cat >&2 <<'USAGE'
Usage: audit-host-security-drift.sh
         --receipt /absolute/receipt.json
         [--root /absolute/root]        (default /)
         [--unprivileged-root]          (the root is a fixture, not the host)
         [--lifecycle /absolute/cloudflare-realip-lifecycle.json]
USAGE
}

receipt=
forwarded=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; receipt=$2; shift 2 ;;
        --root|--lifecycle) [[ $# -ge 2 ]] || { usage; exit 64; }; forwarded+=("$1" "$2"); shift 2 ;;
        --unprivileged-root) forwarded+=("$1"); shift ;;
        *) usage; exit 64 ;;
    esac
done

[[ $receipt == /* ]] || { usage; exit 64; }

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
verifier=$here/verify-host-security-installed.sh
[[ -f $verifier && ! -L $verifier ]] || { echo "host-security installed-state verifier is missing" >&2; exit 1; }

# A receipt that has gone missing is itself drift: without it there is nothing
# to hold the host to, and staying quiet would report health it cannot see.
if [[ ! -f $receipt || -L $receipt ]]; then
    echo "host-security drift: receipt is missing or not a regular file: $receipt" >&2
    exit 1
fi

# Success is discarded, failure is passed through untouched.
output=$("$verifier" --receipt "$receipt" "${forwarded[@]+"${forwarded[@]}"}" 2>&1) || {
    printf '%s\n' "$output" >&2
    exit 1
}
exit 0
