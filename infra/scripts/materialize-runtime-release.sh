#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --archive /absolute/archive.tar.gz --manifest /absolute/artifact-manifest.json --checksums /absolute/SHA256SUMS --dest /absolute/new-release --webadmin-update /absolute/shared-dir --server-update /absolute/shared-dir" >&2
}

archive=
manifest=
checksums=
destination=
webadmin_update=
server_update=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive|--manifest|--checksums|--dest|--webadmin-update|--server-update)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            case "$1" in
                --archive) archive=$2 ;;
                --manifest) manifest=$2 ;;
                --checksums) checksums=$2 ;;
                --dest) destination=$2 ;;
                --webadmin-update) webadmin_update=$2 ;;
                --server-update) server_update=$2 ;;
            esac
            shift 2
            ;;
        *) usage; exit 64 ;;
    esac
done

if [[ -z $archive || -z $manifest || -z $checksums || -z $destination || -z $webadmin_update || -z $server_update ]]; then
    usage
    exit 64
fi
for path in "$archive" "$manifest" "$checksums" "$destination" "$webadmin_update" "$server_update"; do
    [[ $path == /* ]] || { echo "all paths must be absolute" >&2; exit 64; }
done
if [[ -e $destination || -L $destination ]]; then
    echo "release destination already exists: $destination" >&2
    exit 1
fi
releases_root=$(dirname "$destination")
environment_root=$(dirname "$releases_root")
expected_webadmin_update="$environment_root/shared/webadmin-update"
expected_server_update="$environment_root/shared/server-update"
if [[ $webadmin_update != "$expected_webadmin_update" || $server_update != "$expected_server_update" ]]; then
    echo "shared update paths must belong to this environment root" >&2
    exit 1
fi
for update in "$webadmin_update" "$server_update"; do
    [[ -d $update && ! -L $update ]] || { echo "shared update directory is missing or a symlink: $update" >&2; exit 1; }
done
webadmin_update_real=$(realpath -e -- "$webadmin_update")
server_update_real=$(realpath -e -- "$server_update")
if [[ $webadmin_update_real != "$webadmin_update" || $server_update_real != "$server_update" ]]; then
    echo "shared update directories must be canonical, non-symlink paths" >&2
    exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ingress=$(dirname "$archive")
if [[ $(basename "$archive") != am2-backend-runtime.tar.gz || $(basename "$manifest") != artifact-manifest.json || $(basename "$checksums") != SHA256SUMS || $(dirname "$manifest") != "$ingress" || $(dirname "$checksums") != "$ingress" ]]; then
    echo "artifact input names and ingress directory must be canonical" >&2
    exit 64
fi

parent=$(dirname "$destination")
base=$(basename "$destination")
mkdir -p -- "$parent"
snapshot=$(mktemp -d "$parent/.${base}.input.XXXXXX")
temporary=$(mktemp -d "$parent/.${base}.tmp.XXXXXX")
cleanup() {
    for path in "${temporary:-}" "${snapshot:-}"; do
        if [[ -n $path && -d $path ]]; then
            rm -rf -- "$path"
        fi
    done
}
trap cleanup EXIT INT TERM HUP
python3 "$script_dir/snapshot-artifact-input.py" --ingress "$ingress" --destination "$snapshot"
"$script_dir/verify-runtime-artifact.sh" \
    --archive "$snapshot/am2-backend-runtime.tar.gz" \
    --manifest "$snapshot/artifact-manifest.json" \
    --checksums "$snapshot/SHA256SUMS"

source_sha=$(python3 - "$snapshot/artifact-manifest.json" <<'PYTHON'
import json
import re
import sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
sha = value['source_sha']
if not re.fullmatch(r'[0-9a-f]{40}', sha):
    raise SystemExit('verified manifest has invalid source SHA')
print(sha)
PYTHON
)

tar -xzf "$snapshot/am2-backend-runtime.tar.gz" -C "$temporary"
for link in "$temporary/WebAdmin/update" "$temporary/server/update"; do
    [[ ! -e $link && ! -L $link ]] || { echo "sealed artifact unexpectedly contains runtime update path: $link" >&2; exit 1; }
done
ln -s "$webadmin_update_real" "$temporary/WebAdmin/update"
ln -s "$server_update_real" "$temporary/server/update"
"$script_dir/verify-release-runtime.sh" "$temporary" "$source_sha"
chmod 0750 "$temporary"
python3 "$script_dir/atomic-rename-no-replace.py" --source "$temporary" --destination "$destination"
temporary=
printf 'artifact release materialized: %s -> %s\n' "$source_sha" "$destination"
