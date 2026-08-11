#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 /absolute/release-root" >&2
}

if [[ $# -ne 1 ]]; then
    usage
    exit 64
fi

release_root=$1
if [[ $release_root != /* ]]; then
    echo "release root must be an absolute path" >&2
    exit 64
fi
if [[ ! -d $release_root ]]; then
    echo "release directory is missing: $release_root" >&2
    exit 1
fi

for required in \
    "$release_root/.release-sha" \
    "$release_root/server/package.json" \
    "$release_root/server/package-lock.json" \
    "$release_root/server/server.js" \
    "$release_root/infra/scripts/verify-release-runtime.sh"
do
    if [[ ! -f $required ]]; then
        echo "required release file is missing: $required" >&2
        exit 1
    fi
done

marker=$(tr -d '\r\n' < "$release_root/.release-sha")
if [[ ! $marker =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid release marker: $release_root/.release-sha" >&2
    exit 1
fi

exec "$release_root/infra/scripts/verify-release-runtime.sh" "$release_root" "$marker"
