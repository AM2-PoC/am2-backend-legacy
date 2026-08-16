#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --repo /absolute/repository --sha COMMIT --dest /absolute/new-release [--webadmin-update /absolute/shared-dir --server-update /absolute/shared-dir]" >&2
}

repo=
requested_sha=
destination=
webadmin_update=
server_update=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            repo=$2
            shift 2
            ;;
        --sha)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            requested_sha=$2
            shift 2
            ;;
        --dest)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            destination=$2
            shift 2
            ;;
        --webadmin-update)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            webadmin_update=$2
            shift 2
            ;;
        --server-update)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            server_update=$2
            shift 2
            ;;
        *)
            usage
            exit 64
            ;;
    esac
done

if [[ -z $repo || -z $requested_sha || -z $destination ]]; then
    usage
    exit 64
fi
if [[ $repo != /* || $destination != /* ]]; then
    echo "repository and destination must be absolute paths" >&2
    exit 64
fi
if [[ ! $requested_sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "requested commit must be an exact lowercase 40-character Git SHA" >&2
    exit 64
fi
for shared in "$webadmin_update" "$server_update"; do
    if [[ -n $shared && $shared != /* ]]; then
        echo "runtime update paths must be absolute" >&2
        exit 64
    fi
    if [[ -n $shared && ! -d $shared ]]; then
        echo "runtime update directory is missing: $shared" >&2
        exit 1
    fi
done
if [[ ! -d $repo/.git ]]; then
    echo "Git repository is missing: $repo" >&2
    exit 1
fi
if [[ -e $destination || -L $destination ]]; then
    echo "release destination already exists: $destination" >&2
    exit 1
fi

sha=$(git -C "$repo" rev-parse --verify "${requested_sha}^{commit}" 2>/dev/null) || {
    echo "requested SHA is not a valid Git commit: $requested_sha" >&2
    exit 1
}
if [[ ! $sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "resolved commit is not a full SHA: $sha" >&2
    exit 1
fi

parent=$(dirname "$destination")
base=$(basename "$destination")
mkdir -p "$parent"
temporary=$(mktemp -d "$parent/.${base}.tmp.XXXXXX")
cleanup() {
    if [[ -n ${temporary:-} && -d $temporary ]]; then
        rm -rf -- "$temporary"
    fi
}
trap cleanup EXIT INT TERM HUP

git -C "$repo" archive "$sha" | tar -x -C "$temporary"
printf '%s\n' "$sha" > "$temporary/.release-sha"
mkdir -p "$temporary/WebAdmin/update" "$temporary/server/update"
if [[ -n $webadmin_update ]]; then
    rmdir "$temporary/WebAdmin/update"
    ln -s "$webadmin_update" "$temporary/WebAdmin/update"
fi
if [[ -n $server_update ]]; then
    rmdir "$temporary/server/update"
    ln -s "$server_update" "$temporary/server/update"
fi

(
    cd "$temporary/server"
    npm ci --omit=dev
)

"$temporary/infra/scripts/verify-release-runtime.sh" "$temporary" "$sha"

chmod 0750 "$temporary"
mv -T -- "$temporary" "$destination"

# A release is closed to everyone but its owner and its group, so on a deploy
# host the group is the web server's only way in. The builder cannot set it: it
# runs unprivileged and cannot join a group it is not a member of, which is why
# trying made the build fail on CI instead.
#
# The group is carried by the directory releases are published into, via setgid,
# so a new release inherits it with no privilege at all. That is a property of
# the host, so all that is checked here is that it held. A release whose group
# does not match its parent is one Apache may be unable to traverse, and the
# symptom is a total 403 the moment the symlink moves.
published_group=$(stat -c '%g' "$destination")
parent_group=$(stat -c '%g' "$(dirname -- "$destination")")
if [[ $published_group != "$parent_group" ]]; then
    printf 'release group %s does not match %s on %s; set the setgid bit on the releases directory\n' \
        "$published_group" "$parent_group" "$(dirname -- "$destination")" >&2
    exit 1
fi
temporary=
printf 'release built: %s -> %s\n' "$sha" "$destination"
