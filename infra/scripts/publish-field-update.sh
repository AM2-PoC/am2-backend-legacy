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
    echo "       $0 --verify-only [--update-dir /absolute/server/update] [--reader USER]" >&2
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

update_dir=${update_dir:-/var/www/am2/current/server/update}
[[ $update_dir == /* ]] || { usage; exit 64; }
if [[ -z $verify_only ]]; then
    [[ -n $artifact && $artifact == /* ]] || { usage; exit 64; }
fi

# Writing the files is not publishing them. The relay is a different process
# and often a different user, and the one time that mattered -- a publish run
# under sudo into a directory owned by the service account -- every check here
# passed, the script said "published", and the endpoint answered "No version
# info found" for a day. So the last thing this does is read the channel back
# as the process that serves it.
#
# The reader defaults to whoever owns the update directory, which is the
# account the relay runs as on every host this deploys to.
verify_channel() {
    local dir=$1 who=$2
    python3 - "$dir" "$who" <<'PYTHON'
import grp, json, hashlib, os, pwd, sys

directory, who = sys.argv[1], sys.argv[2]

if not who:
    try:
        who = pwd.getpwuid(os.stat(directory).st_uid).pw_name
    except (OSError, KeyError) as err:
        sys.exit(f"cannot tell who should be able to read {directory}: {err}")
try:
    account = pwd.getpwnam(who)
except KeyError:
    sys.exit(f"no such account to read the channel as: {who}")

groups = {account.pw_gid}
groups.update(g.gr_gid for g in grp.getgrall() if who in g.gr_mem)


def permits(path, bit):
    """Whether `who` holds `bit` (4 read, 1 traverse) on path."""
    if account.pw_uid == 0:
        return True
    st = os.stat(path)
    if st.st_uid == account.pw_uid:
        return st.st_mode & (bit << 6)
    if st.st_gid in groups:
        return st.st_mode & (bit << 3)
    return st.st_mode & bit


problems = []
if not permits(directory, 1):
    problems.append(f"{who} cannot enter {directory}")

manifest = os.path.join(directory, "version.json")
if not os.path.exists(manifest):
    problems.append(f"{manifest} is not there")
elif not permits(manifest, 4):
    problems.append(f"{who} cannot read {manifest}")
else:
    try:
        published = json.load(open(manifest))
    except Exception as err:
        problems.append(f"{manifest} does not parse: {err}")
    else:
        name = str(published.get("update_url", "")).rsplit("/", 1)[-1]
        apk = os.path.join(directory, name)
        if not name.endswith(".apk"):
            problems.append("the published manifest names no APK")
        elif not os.path.exists(apk):
            problems.append(f"{apk} is named by the manifest and is not there")
        elif not permits(apk, 4):
            problems.append(f"{who} cannot read {apk}")
        else:
            digest = hashlib.sha256(open(apk, "rb").read()).hexdigest()
            if digest != published.get("sha256"):
                problems.append(
                    f"the published manifest describes {published.get('sha256')}, "
                    f"the published APK is {digest}")

if problems:
    for problem in problems:
        print(f"the channel is not usable: {problem}", file=sys.stderr)
    sys.exit(1)
PYTHON
}

if [[ -n $verify_only ]]; then
    verify_channel "$update_dir" "$reader"
    echo "channel at $update_dir is readable and coherent"
    exit 0
fi

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

# Keep whatever is published now, manifest AND the APK it names. If the new
# pair turns out not to be readable, the field must be left on the build that
# was working -- a channel answering nothing at all is worse than a channel
# answering something older.
#
# Both, not just the manifest: they land under the same name, so restoring the
# old manifest beside the new APK leaves a pair that does not agree, and a
# handset refuses that install on the digest without saying why.
rollback_manifest=
rollback_apk=
rollback_apk_name=
if [[ -r $current ]]; then
    rollback_manifest=$(mktemp)
    cp -p "$current" "$rollback_manifest"
    rollback_apk_name=$(python3 -c "
import json
try:
    print(str(json.load(open('$current')).get('update_url') or '').rsplit('/', 1)[-1])
except Exception:
    print('')
")
    if [[ -n $rollback_apk_name && -r $update_dir/$rollback_apk_name ]]; then
        rollback_apk=$(mktemp)
        cp -p "$update_dir/$rollback_apk_name" "$rollback_apk"
    fi
fi

# The APK first and the manifest second, both through a temporary name so a
# reader never sees a half-written file. In the instant between them the
# manifest still describes the previous build, which is the safe direction: a
# handset is offered something older, never something whose digest will not
# match.
install -m 0640 "$apk" "$update_dir/.$target_name.incoming"
mv -f "$update_dir/.$target_name.incoming" "$update_dir/$target_name"
install -m 0640 "$manifest" "$update_dir/.version.json.incoming"
mv -f "$update_dir/.version.json.incoming" "$update_dir/version.json"

if ! verify_channel "$update_dir" "$reader"; then
    if [[ -n $rollback_manifest ]]; then
        # The APK first and the manifest second, the same order as publishing,
        # so no reader ever sees a manifest describing bytes that are not there.
        if [[ -n $rollback_apk ]]; then
            cp -p "$rollback_apk" "$update_dir/.$rollback_apk_name.incoming"
            mv -f "$update_dir/.$rollback_apk_name.incoming" "$update_dir/$rollback_apk_name"
        fi
        cp -p "$rollback_manifest" "$update_dir/.version.json.incoming"
        mv -f "$update_dir/.version.json.incoming" "$current"
        echo "rolled back: the channel still serves the build it served before" >&2
    else
        rm -f "$current" "$update_dir/$target_name"
        echo "removed the manifest: nothing was published here before" >&2
    fi
    rm -f "$rollback_manifest" "$rollback_apk"
    exit 1
fi
rm -f "$rollback_manifest" "$rollback_apk"

echo "published $version_name (build $version_code) as $update_dir/$target_name"
