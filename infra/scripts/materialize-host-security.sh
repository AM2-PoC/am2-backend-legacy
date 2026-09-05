#!/usr/bin/env bash
set -euo pipefail

# Materialize authenticated host-security bytes into an immutable store.
#
# This is the step between a sealed bundle and an approved activation, and it
# deliberately stops short of activation: it never writes to /etc, never tests a
# service configuration, and never reloads anything. Those are separate,
# separately approved operations.
#
# Two properties matter more than convenience.
#
# The store is digest-addressed. A materialization lives under its payload
# digest, so two different payloads can never occupy one path and "the same
# path" always means the same bytes. Re-materializing an identical payload is a
# no-op; finding different bytes already there is a refusal, not an overwrite.
#
# It never reads a source checkout. Everything it needs -- including the file
# contract that names the install targets -- travels inside the authenticated
# payload. That is what makes it usable by a bounded identity with no Git
# credential, no repository, and no build tooling.
#
# Authentication is delegated to verify-host-security-bundle.sh rather than
# reimplemented here, so there is one place where a bundle is judged.

usage() {
    cat >&2 <<'USAGE'
Usage: materialize-host-security.sh
         --archive           /absolute/am2-host-security.tar.gz
         --manifest          /absolute/host-security-manifest.json
         --checksums         /absolute/SHA256SUMS
         --expected-manifest /absolute/trusted-host-security-manifest.json
         --store-root        /absolute/store-root
         --receipt           /absolute/receipt.json
         [--unprivileged-store]
USAGE
}

archive=
manifest=
checksums=
expected_manifest=
store_root=
receipt=
unprivileged=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --archive) [[ $# -ge 2 ]] || { usage; exit 64; }; archive=$2; shift 2 ;;
        --manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; manifest=$2; shift 2 ;;
        --checksums) [[ $# -ge 2 ]] || { usage; exit 64; }; checksums=$2; shift 2 ;;
        --expected-manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; expected_manifest=$2; shift 2 ;;
        --store-root) [[ $# -ge 2 ]] || { usage; exit 64; }; store_root=$2; shift 2 ;;
        --receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; receipt=$2; shift 2 ;;
        --unprivileged-store) unprivileged=1; shift ;;
        *) usage; exit 64 ;;
    esac
done

for value in "$archive" "$manifest" "$checksums" "$expected_manifest" "$store_root" "$receipt"; do
    [[ $value == /* ]] || { usage; exit 64; }
done

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
verifier=$here/verify-host-security-bundle.sh
[[ -f $verifier && ! -L $verifier ]] || { echo "host-security bundle verifier is missing" >&2; exit 1; }

# A privileged materialization is the real one: root, and a store only root can
# write. Anything else is a fixture, and must not be able to claim otherwise --
# so it is confined away from system paths and stamped as unprivileged in its
# receipt. That keeps "this receipt describes the host" an honest statement.
#
# Resolved before it is judged: a leading-string match lets `/tmp/../etc/am2`
# and `//etc/am2` walk straight past the bound and land a fixture receipt on
# the very path the drift timer reads.
system_paths='^/(etc|usr|bin|sbin|lib|lib64|boot|opt|var|srv|root)(/|$)'
resolved_store=$(realpath -m -- "$store_root")
resolved_receipt=$(realpath -m -- "$receipt")
if (( unprivileged )); then
    if [[ $resolved_store =~ $system_paths || $resolved_receipt =~ $system_paths ]]; then
        echo "an unprivileged materialization may not target a system path: $store_root" >&2
        exit 1
    fi
elif [[ $EUID -ne 0 ]]; then
    echo "a privileged materialization requires root; pass --unprivileged-store for a fixture store" >&2
    exit 1
fi

"$verifier" \
    --archive "$archive" \
    --manifest "$manifest" \
    --checksums "$checksums" \
    --expected-manifest "$expected_manifest" >/dev/null

payload_sha256=$(python3 -c '
import json, re, sys
manifest=json.load(open(sys.argv[1], encoding="utf-8"))
digest=str(manifest.get("payload_sha256", ""))
if not re.fullmatch(r"[0-9a-f]{64}", digest):
    raise SystemExit("host-security manifest payload digest is invalid")
print(digest)
' "$manifest")

destination=$store_root/$payload_sha256
work=$(mktemp -d)
staged=$work/payload
cleanup() { chmod -R u+w "$work" 2>/dev/null || true; rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP

mkdir -p "$staged"
tar -xzf "$archive" -C "$staged"
if find "$staged" -type l -print -quit | grep -q .; then
    echo "host-security payload contains a symlink" >&2
    exit 1
fi

# Authenticate the bytes this script extracted, not merely the bytes some other
# process approved a moment ago.
#
# The bundle verifier judges a private snapshot of the archive and deletes it.
# Between that and this extraction the archive on disk can change -- and whoever
# can write the delivery directory is exactly the party the checksum design
# exists to distrust. Re-deriving the digests here means a swapped archive is
# caught rather than sealed into the store under an authenticated name.
#
# This also covers the contract, which the manifest's file list does not name:
# the payload digest spans every byte in the payload, so an edited contract --
# the file that decides where everything installs -- changes it.
python3 - "$manifest" "$staged" <<'PY' || exit 1
import hashlib, json, pathlib, subprocess, sys
manifest_path, payload_root = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding='utf-8'))
root = pathlib.Path(payload_root)

marker = (root / '.host-security-source-sha').read_text(encoding='utf-8').strip()
if marker != manifest['source_sha']:
    raise SystemExit('extracted payload source marker differs from the manifest')

expected = {item['origin']: item['sha256'] for item in manifest['files']}
for origin, digest in expected.items():
    path = root / origin
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f'extracted payload is missing {origin}')
    if hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != digest:
        raise SystemExit(f'extracted payload digest mismatch at {origin}')

contract = root / 'infra/contracts/host-security-contract.json'
if not contract.is_file() or contract.is_symlink():
    raise SystemExit('extracted payload carries no host-security contract')

present = {str(path.relative_to(root)) for path in root.rglob('*') if path.is_file() or path.is_symlink()}
unexpected = present - set(expected) - {'.host-security-source-sha', 'infra/contracts/host-security-contract.json'}
if unexpected:
    raise SystemExit(f'extracted payload carries unexpected files: {sorted(unexpected)[:3]}')

derived = subprocess.run(
    ['tar', '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner',
     '-C', str(root), '-cf', '-', '.'], capture_output=True, check=True).stdout
if hashlib.sha256(derived).hexdigest() != manifest['payload_sha256']:
    raise SystemExit('extracted payload digest differs from the manifest; the archive changed after it was verified')
PY

contract=$staged/infra/contracts/host-security-contract.json

if [[ -e $destination ]]; then
    # Same digest, already materialized. Prove the bytes on disk are still the
    # bytes just authenticated before treating this as a no-op: a store somebody
    # edited in place would otherwise be silently reused forever.
    #
    # Compared against the freshly extracted tree rather than against the
    # manifest alone, because the manifest does not name the contract, and the
    # contract is what decides where every file installs. Compared by content
    # rather than by re-deriving the payload digest, because a materialized
    # store is sealed read-only and a tar digest would then disagree with the
    # packager's over permissions alone.
    python3 - "$staged" "$destination/payload" <<'PY' || exit 1
import hashlib, pathlib, sys
staged_root, store_root = (pathlib.Path(argument) for argument in sys.argv[1:])


def digests(root):
    if not root.is_dir():
        raise SystemExit(f'existing materialization has no payload at {root}')
    found = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise SystemExit(f'existing materialization contains a symlink: {path.relative_to(root)}')
        if path.is_file():
            found[str(path.relative_to(root))] = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    return found


staged, stored = digests(staged_root), digests(store_root)
missing = sorted(set(staged) - set(stored))
extra = sorted(set(stored) - set(staged))
changed = sorted(name for name in set(staged) & set(stored) if staged[name] != stored[name])
if missing:
    raise SystemExit(f'existing materialization is missing {missing[:3]}; refusing to reuse it')
if extra:
    raise SystemExit(f'existing materialization carries unexpected files {extra[:3]}; refusing to reuse it')
if changed:
    raise SystemExit(f'existing materialization differs from the authenticated payload at {changed[:3]}; '
                     'refusing to reuse or overwrite it')
PY
else
    mkdir -p "$store_root"
    staging_dir=$store_root/.incoming-$payload_sha256.$$
    rm -rf -- "$staging_dir"
    mkdir -p "$staging_dir"
    cp -a "$staged" "$staging_dir/payload"
    find "$staging_dir" -type d -exec chmod 0555 {} +
    find "$staging_dir" -type f -exec chmod 0444 {} +
    if ! mv -T -n -- "$staging_dir" "$destination" 2>/dev/null || [[ -e $staging_dir ]]; then
        # Another materialization of the same digest won the race; drop ours and
        # let the existing one stand, since both carry identical bytes.
        chmod -R u+w "$staging_dir" 2>/dev/null || true
        rm -rf -- "$staging_dir"
        [[ -d $destination ]] || { echo "could not publish materialization at $destination" >&2; exit 1; }
    fi
fi

python3 - "$manifest" "$destination" "$receipt" "$unprivileged" <<'PY'
import json, os, pathlib, re, sys, tempfile, time

manifest_path, destination, receipt_path, unprivileged = sys.argv[1:]
manifest = json.load(open(manifest_path, encoding='utf-8'))
contract = json.load(open(pathlib.Path(destination, 'payload/infra/contracts/host-security-contract.json'), encoding='utf-8'))

by_origin = {item['source']: item for item in contract['files']}
files = []
for item in manifest['files']:
    origin = item['origin']
    declared = by_origin.get(origin)
    if declared is None or declared['id'] != item['id']:
        raise SystemExit(f'materialized payload does not declare manifest origin: {origin}')
    entry = {
        'id': item['id'],
        'origin': origin,
        'sha256': item['sha256'],
        'mode': declared['mode'],
        'consumer': declared['consumer'],
    }
    # Most files name one absolute target. The PHP auto_prepend configuration
    # is installed once per SAPI, and which SAPI versions exist is host state
    # that is unknown here, so the receipt carries the rule and the
    # installed-state verifier resolves it against the host it is checking.
    if 'target' in declared:
        target = declared['target']
        if not re.fullmatch(r'/[A-Za-z0-9._/-]+', target) or '..' in target.split('/'):
            raise SystemExit(f'host-security contract target is invalid: {target}')
        entry['target'] = target
    elif declared.get('target_kind') == 'php-sapi-conf.d':
        entry['target_kind'] = 'php-sapi-conf.d'
        entry['filename'] = declared['filename']
        entry['sapis'] = list(declared['sapis'])
    else:
        raise SystemExit(f"host-security contract entry resolves no target: {item['id']}")
    files.append(entry)

if not files:
    raise SystemExit('materialized payload declares no host-security files')

receipt = {
    'schema_version': 1,
    'application': 'am2-host-security-materialization',
    'source_sha': manifest['source_sha'],
    'payload_sha256': manifest['payload_sha256'],
    'archive_sha256': manifest['archive_sha256'],
    'store_path': destination,
    'materialized_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'privileged': unprivileged != '1',
    'materialized_by_uid': os.geteuid(),
    'files': files,
}

# Written whole and moved into place, so a reader never sees half a receipt.
receipt_dir = pathlib.Path(receipt_path).parent
receipt_dir.mkdir(parents=True, exist_ok=True)
handle, temporary = tempfile.mkstemp(dir=receipt_dir, prefix='.host-security-receipt-')
try:
    with os.fdopen(handle, 'w', encoding='utf-8') as stream:
        stream.write(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, receipt_path)
except BaseException:
    pathlib.Path(temporary).unlink(missing_ok=True)
    raise
PY

printf 'host-security materialized: %s %s\n' "$payload_sha256" "$destination"
