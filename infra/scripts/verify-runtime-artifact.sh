#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --archive /absolute/archive.tar.gz --manifest /absolute/artifact-manifest.json --checksums /absolute/SHA256SUMS" >&2
}

archive=
manifest=
checksums=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            archive=$2
            shift 2
            ;;
        --manifest)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            manifest=$2
            shift 2
            ;;
        --checksums)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            checksums=$2
            shift 2
            ;;
        *)
            usage
            exit 64
            ;;
    esac
done

if [[ -z $archive || -z $manifest || -z $checksums ]]; then
    usage
    exit 64
fi
for f in "$archive" "$manifest" "$checksums"; do
    if [[ $f != /* ]]; then
        echo "artifact inputs must be absolute paths" >&2
        exit 64
    fi
    if [[ ! -f $f || -L $f ]]; then
        echo "required regular artifact input is missing: $f" >&2
        exit 1
    fi
done

work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP

archive_base=$(basename "$archive")
checksum_dir=$(dirname "$checksums")
sealed_manifest="$checksum_dir/artifact-manifest.json"
if [[ $(dirname "$archive") != "$checksum_dir" ]]; then
    echo "archive and checksum file must share a directory" >&2
    exit 1
fi
if [[ $(realpath -e -- "$manifest") != $(realpath -e -- "$sealed_manifest") ]]; then
    echo "manifest must be the checksum directory's sealed artifact-manifest.json" >&2
    exit 1
fi
for expected in \
    "$archive_base" \
    "$(basename "$manifest")" \
    lockfiles/server-package-lock.json \
    lockfiles/webadmin-package-lock.json
do
    if ! grep -Eq "^[0-9a-f]{64}  \*?$(printf '%s' "$expected" | sed 's/[][\\.^$*+?{}|()]/\\&/g')$" "$checksums"; then
        echo "checksum file does not seal required artifact input: $expected" >&2
        exit 1
    fi
done
(
    cd "$checksum_dir"
    sha256sum -c "$checksums"
) || {
    echo "artifact checksum verification failed" >&2
    exit 1
}

python3 - "$manifest" "$archive" <<'PYTHON'
import hashlib
import json
import re
import sys

manifest_path, archive_path = sys.argv[1:]
with open(manifest_path, encoding='utf-8') as handle:
    value = json.load(handle)
required = {'schema_version', 'application', 'source_sha', 'payload_sha256', 'archive_sha256', 'runtime', 'lockfiles'}
if set(value) != required:
    raise SystemExit('artifact manifest key set is not exact')
if value['schema_version'] != 1 or value['application'] != 'am2-backend':
    raise SystemExit('artifact manifest schema or application is invalid')
runtime = value.get('runtime')
if not isinstance(runtime, dict) or set(runtime) != {'node', 'php'}:
    raise SystemExit('artifact manifest runtime key set is not exact')
if not re.fullmatch(r'[0-9]+', str(runtime.get('node', ''))):
    raise SystemExit('artifact manifest runtime node is invalid')
if not re.fullmatch(r'[0-9]+\.[0-9]+', str(runtime.get('php', ''))):
    raise SystemExit('artifact manifest runtime php is invalid')
lockfiles = value.get('lockfiles')
if not isinstance(lockfiles, dict) or set(lockfiles) != {'server_package_lock_sha256', 'webadmin_package_lock_sha256'}:
    raise SystemExit('artifact manifest lockfile key set is not exact')
for field in ('source_sha',):
    if not re.fullmatch(r'[0-9a-f]{40}', str(value.get(field, ''))):
        raise SystemExit(f'artifact manifest {field} is invalid')
for field in ('payload_sha256', 'archive_sha256'):
    if not re.fullmatch(r'[0-9a-f]{64}', str(value.get(field, ''))):
        raise SystemExit(f'artifact manifest {field} is invalid')
for field in ('server_package_lock_sha256', 'webadmin_package_lock_sha256'):
    if not re.fullmatch(r'[0-9a-f]{64}', str(value.get('lockfiles', {}).get(field, ''))):
        raise SystemExit(f'artifact manifest lockfile field {field} is invalid')
with open(archive_path, 'rb') as handle:
    actual = hashlib.file_digest(handle, 'sha256').hexdigest()
if actual != value['archive_sha256']:
    raise SystemExit('artifact archive SHA-256 does not match manifest')
PYTHON

python3 - "$manifest" "$checksum_dir" <<'PYTHON'
import hashlib
import json
import pathlib
import sys

manifest_path, artifact_dir = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding='utf-8'))
for relative, key in (
    ('lockfiles/server-package-lock.json', 'server_package_lock_sha256'),
    ('lockfiles/webadmin-package-lock.json', 'webadmin_package_lock_sha256'),
):
    path = pathlib.Path(artifact_dir, relative)
    if not path.is_file():
        raise SystemExit(f'artifact detached lockfile is missing: {relative}')
    actual = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    if actual != manifest['lockfiles'][key]:
        raise SystemExit(f'artifact detached lockfile digest mismatch: {relative}')
PYTHON

# List before extraction. Reject absolute paths, traversal, development residue,
# and all symlinks. A release may only receive environment links during Task 7.
tar -tzf "$archive" | sed 's#^\./##' > "$work/paths"
if [[ ! -s $work/paths ]]; then
    echo "artifact archive is empty" >&2
    exit 1
fi
if grep -Eq '(^/|(^|/)\.\.?(/|$))' "$work/paths"; then
    echo "artifact contains absolute or traversal path" >&2
    exit 1
fi
if grep -Eq '(^|/)(\.git|\.github|\.hermes|\.bin|test|tests|docs)(/|$)|(^|/)\.env([^/]*|/|$)|^WebAdmin/(package(-lock)?\.json|asset/css/tailwind\.src\.css|asset/js/src/)' "$work/paths"; then
    echo "artifact contains forbidden repository residue" >&2
    exit 1
fi

mkdir -p "$work/payload"
tar -xzf "$archive" -C "$work/payload"
if find "$work/payload" -type l -print -quit | grep -q .; then
    echo "artifact contains a symlink" >&2
    exit 1
fi
for required in \
    .release-sha \
    server/server.js \
    server/package.json \
    server/package-lock.json \
    server/node_modules \
    WebAdmin/login.php \
    WebAdmin/asset/js/am2-ui.min.js \
    infra/scripts/smoke-release.sh
do
    if [[ ! -e $work/payload/$required ]]; then
        echo "artifact required runtime path is missing: $required" >&2
        exit 1
    fi
done
actual_payload=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$work/payload" -cf - . | sha256sum | awk '{print $1}')
expected_payload=$(python3 - "$manifest" <<'PYTHON'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['payload_sha256'])
PYTHON
)
if [[ $actual_payload != "$expected_payload" ]]; then
    echo "artifact payload SHA-256 does not match manifest" >&2
    exit 1
fi

printf 'runtime artifact verified: %s\n' "$archive_base"
