#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --archive /absolute/am2-host-security.tar.gz --manifest /absolute/host-security-manifest.json --checksums /absolute/SHA256SUMS --expected-manifest /absolute/trusted-host-security-manifest.json" >&2
}

archive=
manifest=
checksums=
expected_manifest=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive) [[ $# -ge 2 ]] || { usage; exit 64; }; archive=$2; shift 2 ;;
        --manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; manifest=$2; shift 2 ;;
        --checksums) [[ $# -ge 2 ]] || { usage; exit 64; }; checksums=$2; shift 2 ;;
        --expected-manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; expected_manifest=$2; shift 2 ;;
        *) usage; exit 64 ;;
    esac
done

[[ $archive == /* && $manifest == /* && $checksums == /* && $expected_manifest == /* ]] || { usage; exit 64; }
for path in "$archive" "$manifest" "$checksums" "$expected_manifest"; do
    [[ -f $path && ! -L $path ]] || { echo "required host-security bundle input is missing: $path" >&2; exit 1; }
done
bundle_dir=$(dirname "$archive")
bundle_dir_real=$(realpath -e -- "$bundle_dir")
[[ $(dirname "$manifest") == "$bundle_dir" && $(dirname "$checksums") == "$bundle_dir" ]] || { echo "bundle inputs must share a directory" >&2; exit 1; }
[[ $(dirname "$(realpath -e -- "$expected_manifest")") != "$bundle_dir_real" ]] || { echo "trusted expected manifest must be outside the bundle directory" >&2; exit 1; }
[[ $(realpath -e -- "$expected_manifest") != $(realpath -e -- "$manifest") ]] || { echo "trusted expected manifest must be independent of the bundle manifest" >&2; exit 1; }
[[ $(basename "$archive") == am2-host-security.tar.gz && $(basename "$manifest") == host-security-manifest.json && $(basename "$checksums") == SHA256SUMS ]] || { echo "bundle input names are not canonical" >&2; exit 1; }
for expected in am2-host-security.tar.gz host-security-manifest.json; do
    grep -Eq "^[0-9a-f]{64}  \*?${expected}$" "$checksums" || { echo "host-security checksums do not seal required input: $expected" >&2; exit 1; }
done
(
    cd "$bundle_dir"
    sha256sum -c "$checksums"
) >/dev/null || { echo "host-security checksum verification failed" >&2; exit 1; }

work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP

tar -tzf "$archive" | sed 's#^\./##' > "$work/paths"
[[ -s $work/paths ]] || { echo "host-security bundle is empty" >&2; exit 1; }
if grep -Eq '(^/|(^|/)\.\.?(/|$)|(^|/)(\.git|\.github|\.hermes|docs|tests)(/|$))' "$work/paths"; then
    echo "host-security bundle contains unsafe or non-host path" >&2
    exit 1
fi
mkdir -p "$work/payload"
tar -xzf "$archive" -C "$work/payload"
if find "$work/payload" -type l -print -quit | grep -q .; then
    echo "host-security bundle contains a symlink" >&2
    exit 1
fi

python3 - "$manifest" "$expected_manifest" "$archive" "$work/payload" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
manifest_path, expected_path, archive_path, payload_root = map(pathlib.Path, sys.argv[1:])
manifest=json.load(open(manifest_path,encoding='utf-8'))
expected=json.load(open(expected_path,encoding='utf-8'))
if manifest != expected:
    raise SystemExit('host-security manifest does not match trusted expected manifest')
if set(manifest) != {'schema_version','application','source_sha','payload_sha256','archive_sha256','files'}:
    raise SystemExit('host-security manifest key set is invalid')
if manifest['schema_version'] != 1 or manifest['application'] != 'am2-host-security':
    raise SystemExit('host-security manifest identity is invalid')
for field, width in [('source_sha',40),('payload_sha256',64),('archive_sha256',64)]:
    if not re.fullmatch(r'[0-9a-f]{%d}' % width, str(manifest.get(field,''))):
        raise SystemExit('host-security manifest %s is invalid' % field)
if hashlib.file_digest(open(archive_path,'rb'),'sha256').hexdigest() != manifest['archive_sha256']:
    raise SystemExit('host-security archive digest mismatch')
marker=(payload_root/'.host-security-source-sha').read_text(encoding='utf-8').strip()
if marker != manifest['source_sha']:
    raise SystemExit('host-security payload source marker mismatch')
files=manifest.get('files')
if not isinstance(files,list) or not files:
    raise SystemExit('host-security manifest files are invalid')
seen=set()
for item in files:
    if set(item) != {'id','origin','sha256'} or item['id'] in seen:
        raise SystemExit('host-security manifest file entry is invalid')
    seen.add(item['id'])
    origin=item['origin']
    if not re.fullmatch(r'infra/(?:php|apache|nginx|scripts)/[A-Za-z0-9._/-]+', str(origin)) or '..' in origin.split('/'):
        raise SystemExit('host-security manifest origin is invalid')
    path=payload_root/origin
    if not path.is_file() or path.is_symlink():
        raise SystemExit('host-security bundle origin is missing')
    if hashlib.file_digest(open(path,'rb'),'sha256').hexdigest() != item['sha256']:
        raise SystemExit('host-security bundle origin digest mismatch')
result=subprocess.run(['tar','--sort=name','--mtime=UTC 1970-01-01','--owner=0','--group=0','--numeric-owner','-C',str(payload_root),'-cf','-','.'],capture_output=True,check=True)
if hashlib.sha256(result.stdout).hexdigest() != manifest['payload_sha256']:
    raise SystemExit('host-security payload digest mismatch')
PY

printf 'host-security bundle verified: %s\n' "$(basename "$archive")"
