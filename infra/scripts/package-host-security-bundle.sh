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
actual_sha=$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)
[[ $actual_sha == "$source_sha" ]] || { echo "requested source SHA is not the checked-out source identity" >&2; exit 1; }
git -C "$source_root" diff --quiet --ignore-submodules -- || { echo "source checkout has unstaged tracked modifications" >&2; exit 1; }
git -C "$source_root" diff --cached --quiet --ignore-submodules -- || { echo "source checkout has staged tracked modifications" >&2; exit 1; }

contract=$source_root/infra/contracts/host-security-contract.json
[[ -f $contract && ! -L $contract ]] || { echo "host-security contract is missing" >&2; exit 1; }

work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP
payload=$work/payload
mkdir -p "$payload"
install -D -m 0644 "$contract" "$payload/infra/contracts/host-security-contract.json"

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
    source=$source_root/$origin
    [[ -f $source && ! -L $source ]] || { echo "host-security contract origin is missing: $origin" >&2; exit 1; }
    install -D -m 0644 "$source" "$payload/$origin"
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

python3 - "$contract" "$output_dir/host-security-manifest.json" "$source_sha" "$payload_sha256" "$archive_sha256" <<'PY'
import hashlib, json, sys
contract_path, out, source, payload, archive = sys.argv[1:]
contract=json.load(open(contract_path, encoding='utf-8'))
files=[]
for item in contract['files']:
    origin=item['source']
    files.append({'id':item['id'], 'origin':origin, 'sha256':hashlib.file_digest(open(contract_path.rsplit('/infra/contracts/',1)[0] + '/' + origin, 'rb'),'sha256').hexdigest()})
manifest={'schema_version':1,'application':'am2-host-security','source_sha':source,'payload_sha256':payload,'archive_sha256':archive,'files':files}
open(out,'w',encoding='utf-8').write(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n')
PY
(
    cd "$output_dir"
    sha256sum am2-host-security.tar.gz host-security-manifest.json > SHA256SUMS
)
printf 'host-security bundle packaged: %s %s\n' "$source_sha" "$archive_sha256"
