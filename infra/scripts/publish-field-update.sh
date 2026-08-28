#!/usr/bin/env bash
set -euo pipefail

# Put the field app's APK and its manifest in place, together, or not at all.
#
# The channel is one file and one APK: server/update/version.json is what a
# handset fetches, and the APK it names is what a handset downloads. Publishing
# them as two separate copies is the one remaining way to end up with a manifest
# that describes bytes other than the ones beside it -- the handset verifies the
# digest and would refuse the install, reporting nothing an operator could act
# on.
#
# So this does both, from one artifact, after checking that the manifest
# actually describes the APK it shipped with. The table public.app_versions is
# not touched: nothing reads it any more, and it was a second hand-written copy
# of this channel that drifted three builds behind the published one.

usage() {
    echo "Usage: $0 --artifact /absolute/ci-artifact-dir [--update-dir /absolute/server/update]" >&2
}

artifact=
update_dir=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --artifact)   [[ $# -ge 2 ]] || { usage; exit 64; }; artifact=$2; shift 2 ;;
        --update-dir) [[ $# -ge 2 ]] || { usage; exit 64; }; update_dir=$2; shift 2 ;;
        *) usage; exit 64 ;;
    esac
done

[[ -n $artifact && $artifact == /* ]] || { usage; exit 64; }
update_dir=${update_dir:-/var/www/am2/current/server/update}
[[ $update_dir == /* ]] || { usage; exit 64; }

manifest=$artifact/version.json
[[ -r $manifest ]] || { echo "no version.json in $artifact" >&2; exit 1; }

read_field() {
    python3 -c "
import json, sys
try:
    value = json.load(open('$manifest')).get('$1')
except Exception as err:
    sys.exit(f'unreadable manifest: {err}')
print('' if value is None else value)
"
}

version_code=$(read_field version_code)
version_name=$(read_field version_name)
update_url=$(read_field update_url)
declared_sha=$(read_field sha256)
signer=$(read_field signer_sha256)

for pair in "version_code:$version_code" "version_name:$version_name" \
            "update_url:$update_url" "sha256:$declared_sha" "signer_sha256:$signer"; do
    [[ -n ${pair#*:} ]] || { echo "manifest is missing ${pair%%:*}" >&2; exit 1; }
done
[[ $version_code =~ ^[1-9][0-9]*$ ]] || { echo "version_code is not a positive integer" >&2; exit 1; }
printf '%s' "$declared_sha" | grep -Eq '^[0-9a-f]{64}$' \
    || { echo "sha256 is not a digest" >&2; exit 1; }
printf '%s' "$signer" | grep -Eq '^[0-9a-f]{64}$' \
    || { echo "signer_sha256 is not a digest" >&2; exit 1; }

# The name the manifest itself publishes, so the file that lands is the file the
# URL promises rather than whatever the artifact happened to call it.
target_name=${update_url##*/}
[[ $target_name == *.apk ]] || { echo "update_url does not name an APK: $update_url" >&2; exit 1; }

# Exactly one APK in the artifact. Two would make this a choice, and a choice
# made here is a choice nobody reviewed.
mapfile -t candidates < <(find "$artifact" -maxdepth 1 -type f -name '*.apk' ! -name '*androidTest*' -print)
[[ ${#candidates[@]} -eq 1 ]] \
    || { echo "expected one APK in $artifact, found ${#candidates[@]}" >&2; exit 1; }
apk=${candidates[0]}

actual_sha=$(sha256sum "$apk" | cut -d' ' -f1)
[[ $actual_sha == "$declared_sha" ]] || {
    echo "the manifest does not describe this APK: declares $declared_sha, bytes are $actual_sha" >&2
    exit 1
}

# Never sideways or backwards. A handset compares version codes, so republishing
# an older build makes the channel permanently answer "already current" for
# everyone who took the newer one.
current=$update_dir/version.json
if [[ -r $current ]]; then
    published=$(python3 -c "
import json
try:
    print(json.load(open('$current')).get('version_code') or 0)
except Exception:
    print(0)
")
    (( version_code > published )) || {
        echo "build $version_code does not advance past the published $published" >&2
        exit 1
    }
fi

install -d -m 0750 "$update_dir"
# The APK first and the manifest second, both through a temporary name so a
# reader never sees a half-written file. In the instant between them the
# manifest still describes the previous build, which is the safe direction: a
# handset is offered something older, never something whose digest will not
# match.
install -m 0640 "$apk" "$update_dir/.$target_name.incoming"
mv -f "$update_dir/.$target_name.incoming" "$update_dir/$target_name"
install -m 0640 "$manifest" "$update_dir/.version.json.incoming"
mv -f "$update_dir/.version.json.incoming" "$update_dir/version.json"

echo "published $version_name (build $version_code) as $update_dir/$target_name"
