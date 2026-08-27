#!/usr/bin/env bash
set -euo pipefail

# What code a relay directory actually contains.
#
# Asked by two things that must not disagree: the watchdog, deciding whether a
# relay still running from an earlier release is running stale code, and a
# deploy, deciding whether restarting the relay -- and cutting whoever is
# transmitting -- is necessary at all.
#
# node_modules is excluded. It is reinstalled per release from the same
# lockfile, and hashing it every minute would cost more than it tells us;
# package-lock.json is a regular file in server/, so a dependency change is
# still caught.

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 /absolute/relay-source-dir" >&2
    exit 64
fi

cd "$1" 2>/dev/null || { echo "cannot read relay source at $1" >&2; exit 1; }

find . -name node_modules -prune -o -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum 2>/dev/null \
    | sha256sum \
    | cut -d' ' -f1
