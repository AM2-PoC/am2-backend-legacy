#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --release /absolute/release --manifest /absolute/artifact-manifest.json" >&2
}

release=
manifest=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release) [[ $# -ge 2 ]] || { usage; exit 64; }; release=$2; shift 2 ;;
        --manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; manifest=$2; shift 2 ;;
        *) usage; exit 64 ;;
    esac
done
[[ $release == /* && -d $release && ! -L $release ]] || { echo "release must be an absolute non-symlink directory" >&2; exit 64; }
[[ $manifest == /* && -f $manifest && ! -L $manifest ]] || { echo "manifest must be an absolute regular file" >&2; exit 64; }

readarray -t identity < <(python3 - "$manifest" <<'PYTHON'
import json, re, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
for key, width in (('source_sha', 40), ('archive_sha256', 64), ('payload_sha256', 64)):
    item = str(value.get(key, ''))
    if not re.fullmatch(f'[0-9a-f]{{{width}}}', item):
        raise SystemExit(f'manifest {key} is invalid')
    print(item)
PYTHON
)
source_sha=${identity[0]}
archive_sha256=${identity[1]}
payload_sha256=${identity[2]}
[[ $(tr -d '\r\n' < "$release/.release-sha") == "$source_sha" ]] || { echo "release source marker mismatch" >&2; exit 1; }

python3 - "$release/.artifact-identity.json" "$source_sha" "$archive_sha256" "$payload_sha256" <<'PYTHON'
import json, sys
path, source, archive, payload = sys.argv[1:]
value = json.load(open(path, encoding='utf-8'))
expected = {'source_sha': source, 'archive_sha256': archive, 'payload_sha256': payload}
if value != expected:
    raise SystemExit('release artifact identity does not match trusted manifest')
PYTHON

for link in WebAdmin/update server/update; do
    [[ -L $release/$link ]] || { echo "approved environment link is missing: $link" >&2; exit 1; }
done
unexpected=$(find "$release" -type l ! -path "$release/WebAdmin/update" ! -path "$release/server/update" -print -quit)
[[ -z $unexpected ]] || { echo "unexpected release symlink: $unexpected" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT INT TERM HUP
mkdir "$work/payload"
cp -a "$release/." "$work/payload/"
rm -f "$work/payload/.artifact-identity.json" "$work/payload/WebAdmin/update" "$work/payload/server/update"
# The materializer deliberately closes the release root to 0750 and the setgid
# releases parent adds g+s to nested directories. Restore only those two known
# publication effects before hashing; retain all other permission mutations as
# integrity-relevant metadata.
chmod 0755 "$work/payload"
chmod g-s "$work/payload"
find "$work/payload" -mindepth 1 -type d -exec chmod g-s {} +
actual=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$work/payload" -cf - . | sha256sum | awk '{print $1}')
[[ $actual == "$payload_sha256" ]] || { echo "materialized release payload digest mismatch" >&2; exit 1; }
printf 'materialized artifact verified: %s %s\n' "$source_sha" "$archive_sha256"
