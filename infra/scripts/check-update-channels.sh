#!/usr/bin/env bash
set -uo pipefail

# Is each distribution channel telling the truth?
#
# Every contract test in this repo targets staging -- tests/contract/helpers.mjs
# defaults CT_HOST to staging-webadmin.am2-poc.com -- so production was never
# checked by anything. Its client channel has advertised version_code 1 with a
# download_url that 404s since 3 May, and its admin manifest has held three
# empty strings since 16 August. Both survived every green build.
#
# The assertions there are consistency-shaped too: they compare the panel card
# against the endpoint, so two things that are consistently empty agree and pass.
#
# This asks a different question, and asks it of every channel:
#
#   empty            no manifest at all. Honest. Nothing is published here.
#   nothing offered  a manifest that names a release and offers no download.
#                    Also honest: "this is what you have, there is nothing here",
#                    which is the truthful state of a channel that cannot ship.
#   coherent         manifest parses, names an artefact that exists, digest matches.
#   INCOHERENT   manifest exists and lies -- malformed, or names an artefact
#                that is not there. This is the state that must never be quiet.
#
# An intentionally empty channel is not a failure. A channel that advertises
# something it cannot deliver is, and that is the only thing this exits non-zero
# for -- so it can run on a timer without crying wolf.

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

# Two shapes are in the field: the current manifests use update_url, and the
# 3 May production one still uses download_url. Naming the wrong key would make
# this report the wrong reason for a real breakage.
url = ''
for key in (url_key, 'download_url', 'update_url'):
    candidate = str(manifest.get(key) or '').strip()
    if candidate:
        url = candidate
        break

# A manifest with no version name is malformed: nothing can act on it.
if not str(manifest.get('version_name') or '').strip():
    print("INCOHERENT   version_name is empty; nothing can act on this")
    raise SystemExit(2)

# A manifest that names a release and offers no download is honest. It says
# "this is what you have and there is nothing here", which is exactly the
# truthful state of a channel that has nothing it can ship. Not a failure.
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
