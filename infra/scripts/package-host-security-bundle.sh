#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --source-root /absolute/source --sha 40-hex --output-dir /absolute/empty-directory" >&2
}

source_root=
source_sha=
output_dir=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source-root) [[ $# -ge 2 ]] || { usage; exit 64; }; source_root=$2; shift 2 ;;
        --sha) [[ $# -ge 2 ]] || { usage; exit 64; }; source_sha=$2; shift 2 ;;
        --output-dir) [[ $# -ge 2 ]] || { usage; exit 64; }; output_dir=$2; shift 2 ;;
        *) usage; exit 64 ;;
    esac
done

[[ $source_root == /* && $output_dir == /* && $source_sha =~ ^[0-9a-f]{40}$ ]] || { usage; exit 64; }
[[ -d $source_root && ! -L $source_root ]] || { echo "source root must be a regular directory" >&2; exit 1; }
[[ ! -e $output_dir && ! -L $output_dir ]] || { echo "output directory already exists" >&2; exit 1; }

git_cmd() {
    env \
        -u GIT_DIR \
        -u GIT_WORK_TREE \
        -u GIT_INDEX_FILE \
        -u GIT_OBJECT_DIRECTORY \
        -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
        -u GIT_REPLACE_REF_BASE \
        GIT_NO_REPLACE_OBJECTS=1 \
        git -C "$source_root" "$@"
}

source_root_real=$(realpath -e -- "$source_root")
source_top=$(git_cmd rev-parse --show-toplevel 2>/dev/null || true)
[[ -n $source_top && $(realpath -e -- "$source_top") == "$source_root_real" ]] || { echo "source root must be the repository worktree root" >&2; exit 1; }
source_commit=$(git_cmd rev-parse --verify "${source_sha}^{commit}" 2>/dev/null || true)
[[ $source_commit == "$source_sha" ]] || { echo "requested source SHA is not an exact commit identity" >&2; exit 1; }
checkout_commit=$(git_cmd rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)
[[ $checkout_commit == "$source_commit" ]] || { echo "source checkout HEAD does not match requested source SHA" >&2; exit 1; }
source_tree=$(git_cmd rev-parse --verify "${source_commit}^{tree}" 2>/dev/null || true)
[[ $source_tree =~ ^[0-9a-f]{40}$ ]] || { echo "requested source commit has no canonical tree" >&2; exit 1; }

git_cmd update-index --really-refresh --ignore-submodules >/dev/null || { echo "source checkout refresh failed" >&2; exit 1; }
git_cmd ls-files -v -z | python3 -c '
import sys
rows=sys.stdin.buffer.read().split(b"\0")
masked=[row for row in rows if row and row[:1] != b"H"]
if masked:
    names=", ".join(row[2:].decode("utf-8", "surrogateescape") for row in masked[:3])
    raise SystemExit(f"source checkout has masked index entries: {names}")
'
git_cmd diff --quiet --ignore-submodules -- || { echo "source checkout has unstaged tracked modifications" >&2; exit 1; }
git_cmd diff --cached --quiet --ignore-submodules -- || { echo "source checkout has staged tracked modifications" >&2; exit 1; }
if git_cmd ls-files -u | grep -q .; then
    echo "source checkout has unmerged index entries" >&2
    exit 1
fi
[[ -z $(git_cmd ls-files --others --exclude-standard) ]] || { echo "source checkout has untracked files" >&2; exit 1; }

work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP
payload=$work/payload
mkdir -p "$payload"

blob_from_tree() {
    local path=$1 expected_mode=$2 entry metadata actual_path mode type object
    mapfile -t entries < <(git_cmd ls-tree "$source_tree" -- "$path")
    [[ ${#entries[@]} -eq 1 ]] || { echo "source tree must contain exactly one host-security path: $path" >&2; return 1; }
    entry=${entries[0]}
    IFS=$'\t' read -r metadata actual_path <<< "$entry"
    read -r mode type object <<< "$metadata"
    [[ $actual_path == "$path" && $mode == "$expected_mode" && $type == blob && $object =~ ^[0-9a-f]{40}$ ]] || {
        echo "source tree host-security path has invalid mode or type: $path" >&2
        return 1
    }
    printf '%s\n' "$object"
}

contract_relative=infra/contracts/host-security-contract.json
contract_oid=$(blob_from_tree "$contract_relative" 100644)
contract=$work/contract.json
mkdir -p "$work/payload/infra/contracts"
git_cmd cat-file blob "$contract_oid" > "$contract"
install -m 0644 "$contract" "$work/payload/$contract_relative"

mapfile -t origins < <(python3 - "$contract" <<'PY'
import json, re, sys
contract=json.load(open(sys.argv[1], encoding='utf-8'))
if set(contract) != {'schema_version','application','source_binding','files','activation'}:
    raise SystemExit('host-security contract key set is not exact')
if contract['schema_version'] != 1 or contract['application'] != 'am2-host-security' or contract['source_binding'] != 'exact-source-sha':
    raise SystemExit('host-security contract identity is invalid')
if not isinstance(contract['files'], list) or not contract['files']:
    raise SystemExit('host-security contract has no files')
seen=set()
for item in contract['files']:
    if not isinstance(item, dict) or set(item) - {'id','source','target','target_kind','filename','sapis','mode','consumer'}:
        raise SystemExit('host-security contract file schema is invalid')
    if 'source' not in item:
        raise SystemExit('host-security contract file has invalid origin')
    origin=item['source']
    if not re.fullmatch(r'infra/(?:php|apache|nginx|scripts)/[A-Za-z0-9._/-]+', str(origin)) or '..' in origin.split('/'):
        raise SystemExit('host-security contract origin is invalid')
    if item.get('id') in seen or item.get('mode') != '0644' or item.get('consumer') not in {'apache2','nginx','php-sapi'}:
        raise SystemExit('host-security contract file metadata is invalid')
    seen.add(item['id'])
    print(origin)
PY
)

for origin in "${origins[@]}"; do
    origin_oid=$(blob_from_tree "$origin" 100644)
    destination=$payload/$origin
    mkdir -p "$(dirname "$destination")"
    git_cmd cat-file blob "$origin_oid" > "$destination"
    chmod 0644 "$destination"
done

printf '%s\n' "$source_sha" > "$payload/.host-security-source-sha"
chmod 0644 "$payload/.host-security-source-sha"
find "$payload" -type d -exec chmod 0755 {} +
find "$payload" -type f -exec chmod 0644 {} +
if find "$payload" -type l -print -quit | grep -q .; then
    echo "host-security payload contains a symlink" >&2
    exit 1
fi

payload_sha256=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -C "$payload" -cf - . | sha256sum | awk '{print $1}')
mkdir -p "$output_dir"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -C "$payload" -czf "$output_dir/am2-host-security.tar.gz" .
archive_sha256=$(sha256sum "$output_dir/am2-host-security.tar.gz" | awk '{print $1}')

python3 - "$contract" "$payload" "$output_dir/host-security-manifest.json" "$source_sha" "$payload_sha256" "$archive_sha256" <<'PY'
import hashlib, json, pathlib, sys
contract_path, payload_root, out, source, payload, archive = sys.argv[1:]
contract=json.load(open(contract_path, encoding='utf-8'))
files=[]
for item in contract['files']:
    origin=item['source']
    origin_path=pathlib.Path(payload_root, origin)
    if not origin_path.is_file() or origin_path.is_symlink():
        raise SystemExit(f'host-security payload origin is missing: {origin}')
    files.append({'id':item['id'], 'origin':origin, 'sha256':hashlib.file_digest(origin_path.open('rb'),'sha256').hexdigest()})
manifest={'schema_version':1,'application':'am2-host-security','source_sha':source,'payload_sha256':payload,'archive_sha256':archive,'files':files}
open(out,'w',encoding='utf-8').write(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n')
PY
(
    cd "$output_dir"
    sha256sum am2-host-security.tar.gz host-security-manifest.json > SHA256SUMS
)
printf 'host-security bundle packaged: %s %s\n' "$source_sha" "$archive_sha256"
