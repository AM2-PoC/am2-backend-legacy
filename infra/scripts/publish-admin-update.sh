#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --artifact /absolute/ci-artifact-dir [--update-dir /absolute/WebAdmin/update] [--reader USER]" >&2
    echo "       $0 --verify-only [--update-dir /absolute/WebAdmin/update] [--reader USER]" >&2
}

artifact=
update_dir=
reader=
verify_only=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --artifact)    [[ $# -ge 2 ]] || { usage; exit 64; }; artifact=$2; shift 2 ;;
        --update-dir)  [[ $# -ge 2 ]] || { usage; exit 64; }; update_dir=$2; shift 2 ;;
        --reader)      [[ $# -ge 2 ]] || { usage; exit 64; }; reader=$2; shift 2 ;;
        --verify-only) verify_only=1; shift ;;
        *) usage; exit 64 ;;
    esac
done

update_dir=${update_dir:-/var/www/am2/shared/webadmin-update}
[[ $update_dir == /* ]] || { usage; exit 64; }
if [[ -z $verify_only ]]; then
    [[ -n $artifact && $artifact == /* ]] || { usage; exit 64; }
fi

verify_channel() {
    local dir=$1 who=$2
    python3 - "$dir" "$who" <<'PYTHON'
import grp, hashlib, json, os, pwd, sys

directory, who = sys.argv[1], sys.argv[2]
if not who:
    try:
        who = pwd.getpwuid(os.stat(directory).st_uid).pw_name
    except (OSError, KeyError) as err:
        sys.exit(f"cannot tell who should read {directory}: {err}")
try:
    account = pwd.getpwnam(who)
except KeyError:
    sys.exit(f"no such reader: {who}")
groups = {account.pw_gid}
groups.update(g.gr_gid for g in grp.getgrall() if who in g.gr_mem)

def permits(path, bit):
    if account.pw_uid == 0:
        return True
    st = os.stat(path)
    if st.st_uid == account.pw_uid:
        return bool(st.st_mode & (bit << 6))
    if st.st_gid in groups:
        return bool(st.st_mode & (bit << 3))
    return bool(st.st_mode & bit)

problems = []
if not permits(directory, 1):
    problems.append(f"{who} cannot enter {directory}")
manifest_path = os.path.join(directory, "admin_version.json")
if not os.path.isfile(manifest_path) or os.path.islink(manifest_path):
    problems.append("admin_version.json is absent or not a regular file")
elif not permits(manifest_path, 4):
    problems.append(f"{who} cannot read admin_version.json")
else:
    try:
        manifest = json.load(open(manifest_path))
    except Exception as err:
        problems.append(f"admin_version.json does not parse: {err}")
    else:
        name = str(manifest.get("update_url", "")).rsplit("/", 1)[-1]
        apk_path = os.path.join(directory, name)
        if name != "admin.apk":
            problems.append("manifest does not name canonical admin.apk")
        elif not os.path.isfile(apk_path) or os.path.islink(apk_path):
            problems.append("admin.apk is absent or not a regular file")
        elif not permits(apk_path, 4):
            problems.append(f"{who} cannot read admin.apk")
        else:
            digest = hashlib.sha256(open(apk_path, "rb").read()).hexdigest()
            if digest != manifest.get("sha256"):
                problems.append(f"manifest declares {manifest.get('sha256')}, APK is {digest}")
if problems:
    for problem in problems:
        print(f"the Admin channel is not usable: {problem}", file=sys.stderr)
    sys.exit(1)
PYTHON
}

if [[ -n $verify_only ]]; then
    verify_channel "$update_dir" "$reader"
    echo "Admin channel at $update_dir is readable and coherent"
    exit 0
fi

manifest=$artifact/admin_version.json
[[ -r $manifest ]] || { echo "no admin_version.json in $artifact" >&2; exit 1; }
mapfile -t candidates < <(find "$artifact" -maxdepth 1 -type f -name '*.apk' ! -name '*androidTest*' -print)
[[ ${#candidates[@]} -eq 1 ]] || { echo "expected one APK, found ${#candidates[@]}" >&2; exit 1; }
apk=${candidates[0]}

read_field() {
    python3 - "$manifest" "$1" <<'PYTHON'
import json, sys
try:
    value = json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception as err:
    sys.exit(f"unreadable manifest: {err}")
print("" if value is None else value)
PYTHON
}

package=$(read_field package)
version_code=$(read_field version_code)
version_name=$(read_field version_name)
update_url=$(read_field update_url)
declared_sha=$(read_field sha256)
signer=$(read_field signer_sha256)
source_commit=$(read_field source_commit)
[[ $package == com.am2.admin ]] || { echo "unexpected package: $package" >&2; exit 1; }
[[ $version_code =~ ^[1-9][0-9]*$ ]] || { echo "version_code is invalid" >&2; exit 1; }
[[ -n $version_name ]] || { echo "version_name is empty" >&2; exit 1; }
[[ $update_url == https://webadmin.am2-poc.com/update/admin.apk ]] || { echo "update_url is not canonical" >&2; exit 1; }
[[ $declared_sha =~ ^[0-9a-f]{64}$ ]] || { echo "sha256 is invalid" >&2; exit 1; }
[[ $signer =~ ^[0-9a-f]{64}$ ]] || { echo "signer_sha256 is invalid" >&2; exit 1; }
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || { echo "source_commit is invalid" >&2; exit 1; }
actual_sha=$(sha256sum "$apk" | cut -d' ' -f1)
[[ $actual_sha == "$declared_sha" ]] || { echo "manifest does not describe this APK" >&2; exit 1; }

current=$update_dir/admin_version.json
if [[ -r $current ]]; then
    published=$(python3 - "$current" <<'PYTHON'
import json, sys
try: print(json.load(open(sys.argv[1])).get("version_code") or 0)
except Exception: print(0)
PYTHON
)
    (( version_code > published )) || { echo "build $version_code does not advance past $published" >&2; exit 1; }
fi

install -d -m 0750 "$update_dir"
rollback_manifest=
rollback_apk=
if [[ -r $current ]]; then rollback_manifest=$(mktemp); cp -p "$current" "$rollback_manifest"; fi
if [[ -r $update_dir/admin.apk ]]; then rollback_apk=$(mktemp); cp -p "$update_dir/admin.apk" "$rollback_apk"; fi
cleanup() { rm -f "${rollback_manifest:-}" "${rollback_apk:-}"; }
trap cleanup EXIT

install -m 0640 "$apk" "$update_dir/.admin.apk.incoming"
mv -f "$update_dir/.admin.apk.incoming" "$update_dir/admin.apk"
install -m 0640 "$manifest" "$update_dir/.admin_version.json.incoming"
mv -f "$update_dir/.admin_version.json.incoming" "$update_dir/admin_version.json"

if ! verify_channel "$update_dir" "$reader"; then
    if [[ -n $rollback_apk ]]; then install -m 0640 "$rollback_apk" "$update_dir/.admin.apk.rollback"; mv -f "$update_dir/.admin.apk.rollback" "$update_dir/admin.apk"; else rm -f "$update_dir/admin.apk"; fi
    if [[ -n $rollback_manifest ]]; then install -m 0640 "$rollback_manifest" "$update_dir/.admin_version.json.rollback"; mv -f "$update_dir/.admin_version.json.rollback" "$update_dir/admin_version.json"; else rm -f "$update_dir/admin_version.json"; fi
    echo "Admin publication failed; previous coherent pair restored" >&2
    exit 1
fi

echo "published Admin build $version_code ($version_name) to $update_dir"
