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
# still caught. The environment-owned update symlink target is part of runtime
# identity: identical source wired to staging and production channels is not
# operationally identical.

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 /absolute/relay-source-dir" >&2
    exit 64
fi

relay_dir=$1
[[ $relay_dir == /* ]] || { echo "relay source path must be absolute: $relay_dir" >&2; exit 1; }
relay_dir=$(readlink -f "$relay_dir" 2>/dev/null) \
    || { echo "cannot resolve relay source at $1" >&2; exit 1; }
[[ -d $relay_dir ]] || { echo "cannot read relay source at $relay_dir" >&2; exit 1; }
cd "$relay_dir"

source_digest=$(find . -name node_modules -prune -o -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum 2>/dev/null \
    | sha256sum \
    | cut -d' ' -f1)

update_link=$relay_dir/update
[[ -L $update_link ]] || { echo "relay update channel is not a symlink: $update_link" >&2; exit 1; }
update_target=$(readlink -f "$update_link" 2>/dev/null) \
    || { echo "cannot resolve relay update channel at $update_link" >&2; exit 1; }
[[ -d $update_target ]] || { echo "relay update channel is not a directory: $update_target" >&2; exit 1; }

printf '%s\0%s\0' "$source_digest" "$update_target" | sha256sum | cut -d' ' -f1
