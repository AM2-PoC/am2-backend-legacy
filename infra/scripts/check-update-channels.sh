#!/usr/bin/env bash
set -uo pipefail


usage() { echo "Usage: $0 [--quiet]" >&2; }
quiet=
[[ ${1:-} == --quiet ]] && quiet=1
[[ -n ${1:-} && -z $quiet ]] && { usage; exit 64; }

failed=0

check() {
    local label=$1 dir=$2 manifest=$3 url_key=$4
    local path="$dir/$manifest"

    if ! sudo test -e "$path" 2>/dev/null && [[ ! -e $path ]]; then
        [[ -n $quiet ]] || printf '%-34s empty        (no %s)\n' "$label" "$manifest"
        return 0
    fi

    local report
    report=$(sudo python3 - "$path" "$url_key" <<'PYTHON'
import hashlib, json, os, sys
path, url_key = sys.argv[1], sys.argv[2]
try:
    manifest = json.load(open(path))
except Exception as err:
    print("INCOHERENT   does not parse: " + str(err))
    raise SystemExit(2)

url = ''
for key in (url_key, 'download_url', 'update_url'):
    candidate = str(manifest.get(key) or '').strip()
    if candidate:
        url = candidate
        break

if not str(manifest.get('version_name') or '').strip():
    print("INCOHERENT   version_name is empty; nothing can act on this")
    raise SystemExit(2)

if not url:
    print(f"nothing offered  {manifest['version_name']}  (no download url)")
    raise SystemExit(0)

name = url.rsplit('/', 1)[-1]
artefact = os.path.join(os.path.dirname(path), name)
if not os.path.exists(artefact):
    print(f"INCOHERENT   names {name}, which is not here")
    raise SystemExit(2)

declared = str(manifest.get('sha256') or '')
if declared:
    actual = hashlib.sha256(open(artefact, 'rb').read()).hexdigest()
    if actual != declared:
        print(f"INCOHERENT   {name} is {actual[:12]}, manifest says {declared[:12]}")
        raise SystemExit(2)
    print(f"coherent     {manifest['version_name']}  {name}  {actual[:12]}")
else:
    print(f"coherent     {manifest['version_name']}  {name}  (no digest declared)")
PYTHON
    )
    local status=$?
    printf '%-34s %s\n' "$label" "$report"
    [[ $status -ne 0 ]] && failed=1
    return 0
}

check "produksi/klien"  /var/www/am2/shared/server-update            version.json       update_url
check "produksi/admin"  /var/www/am2/shared/webadmin-update          admin_version.json update_url
check "staging/klien"   /var/www/am2/staging/shared/server-update    version.json       update_url
check "staging/admin"   /var/www/am2/staging/shared/webadmin-update  admin_version.json update_url

if [[ $failed -ne 0 ]]; then
    echo >&2
    echo "at least one channel advertises something it cannot deliver." >&2
    echo "an empty channel is fine; a lying one is not." >&2
    exit 1
fi
