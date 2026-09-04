#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --source-root /absolute/checkout --sha 40-character-git-sha --output-dir /absolute/empty-directory" >&2
}

source_root=
expected_sha=
output_dir=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --source-root)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            source_root=$2
            shift 2
            ;;
        --sha)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            expected_sha=$2
            shift 2
            ;;
        --output-dir)
            [[ $# -ge 2 ]] || { usage; exit 64; }
            output_dir=$2
            shift 2
            ;;
        *)
            usage
            exit 64
            ;;
    esac
done

if [[ -z $source_root || -z $expected_sha || -z $output_dir ]]; then
    usage
    exit 64
fi
if [[ $source_root != /* || $output_dir != /* ]]; then
    echo "source root and output directory must be absolute paths" >&2
    exit 64
fi
if [[ ! $expected_sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "source SHA must be a lowercase 40-character Git SHA" >&2
    exit 64
fi
if ! git -C "$source_root" rev-parse --git-dir >/dev/null 2>&1; then
    echo "source root is not a Git checkout: $source_root" >&2
    exit 1
fi
if [[ -e $output_dir || -L $output_dir ]]; then
    echo "output directory already exists: $output_dir" >&2
    exit 1
fi

actual_sha=$(git -C "$source_root" rev-parse HEAD 2>/dev/null) || {
    echo "cannot resolve checkout HEAD" >&2
    exit 1
}
if [[ $actual_sha != "$expected_sha" ]]; then
    echo "checkout HEAD does not match requested source SHA" >&2
    exit 1
fi
if ! git -C "$source_root" diff --quiet --ignore-submodules --; then
    echo "source checkout has unstaged tracked modifications" >&2
    exit 1
fi
if ! git -C "$source_root" diff --cached --quiet --ignore-submodules --; then
    echo "source checkout has staged tracked modifications" >&2
    exit 1
fi
if [[ -n $(git -C "$source_root" ls-files --others --exclude-standard) ]]; then
    echo "source checkout has untracked files" >&2
    exit 1
fi
if [[ ! -d $source_root/server/node_modules ]]; then
    echo "production dependency directory is missing: $source_root/server/node_modules" >&2
    exit 1
fi

# `npm ci` necessarily creates ignored server/node_modules after the checkout is
# clean. Check the source tree again while excluding that one CI-produced tree;
# every other ignored or untracked file would make the allowlist depend on local
# workstation residue and is refused.
extra_source_files=$(git -C "$source_root" ls-files --others --ignored --exclude-standard \
    | grep -v '^server/node_modules/' || true)
if [[ -n $extra_source_files ]]; then
    echo "source checkout has untracked or ignored files outside server/node_modules" >&2
    exit 1
fi

parent=$(dirname "$output_dir")
base=$(basename "$output_dir")
mkdir -p -- "$parent"
temporary=$(mktemp -d "$parent/.${base}.tmp.XXXXXX")
payload="$temporary/payload"
cleanup() {
    if [[ -n ${temporary:-} && -d $temporary ]]; then
        rm -rf -- "$temporary"
    fi
}
trap cleanup EXIT INT TERM HUP
mkdir -p "$payload" "$temporary/out"

# `npm ls` validates the complete production graph recorded by package-lock,
# not merely direct package entrypoints. It catches a missing transitive module
# before that broken tree can be sealed into an immutable release.
if ! npm --prefix "$source_root/server" ls --omit=dev --all --json > "$temporary/npm-production-tree.json"; then
    echo "production dependency closure is incomplete" >&2
    exit 1
fi
python3 - "$temporary/npm-production-tree.json" <<'PYTHON'
import json
import sys

value = json.load(open(sys.argv[1], encoding='utf-8'))
problems = value.get('problems', [])
if problems:
    raise SystemExit('production dependency closure has problems: ' + '; '.join(problems))
PYTHON

copy_file() {
    local relative=$1
    local source="$source_root/$relative"
    local destination="$payload/$relative"
    [[ -f $source ]] || { echo "required runtime file is missing: $relative" >&2; exit 1; }
    install -D -m 0644 "$source" "$destination"
}

copy_tree() {
    local relative=$1
    local source="$source_root/$relative"
    local destination="$payload/$relative"
    [[ -d $source ]] || { echo "required runtime directory is missing: $relative" >&2; exit 1; }
    mkdir -p -- "$(dirname "$destination")"
    cp -a -- "$source" "$destination"
}

# Explicit runtime allowlist. Never archive the checkout wholesale and rely on
# edge denies to hide repository residue later.
copy_file server/server.js
copy_file server/package.json
copy_file server/package-lock.json
copy_tree server/lib
copy_tree server/node_modules
# npm creates command shims and dependency packages retain their own source
# metadata/tests/docs. The relay executes neither, so strip them after copying:
# the sealed runtime must not contain a second repository-shaped attack surface.
find "$payload/server/node_modules" -type d \
    \( -name .bin -o -name .github -o -name .hermes -o -name .git -o -name test -o -name tests -o -name docs \) \
    -prune -exec rm -rf -- {} +
find "$payload/server/node_modules" -type f -name '.env*' -delete
if [[ -d $source_root/server/public ]]; then copy_tree server/public; fi

# PHP source, translations, and browser-consumed assets. Build inputs remain out.
while IFS= read -r -d '' source; do
    relative=${source#"$source_root/"}
    copy_file "$relative"
done < <(find "$source_root/WebAdmin" -type f -name '*.php' -print0 | sort -z)
while IFS= read -r -d '' source; do
    relative=${source#"$source_root/"}
    copy_file "$relative"
done < <(find "$source_root/WebAdmin/asset" -type f \
    ! -path "$source_root/WebAdmin/asset/css/tailwind.src.css" \
    ! -path "$source_root/WebAdmin/asset/js/src/*" -print0 | sort -z)

# Required runtime operational data/scripts. Host configuration and systemd units
# stay outside the artifact; migrations are data required by release smoke.
copy_tree infra/migrations
for script in \
    apply-migrations.sh \
    check-relay-health.sh \
    relay-source-digest.sh \
    smoke-release.sh \
    verify-current-release.sh \
    verify-release-runtime.sh \
    verify-webadmin-guard.sh
do
    copy_file "infra/scripts/$script"
    chmod 0755 "$payload/infra/scripts/$script"
done
printf '%s\n' "$expected_sha" > "$payload/.release-sha"
chmod 0644 "$payload/.release-sha"

# Runtime payload permissions are normalized before hashing/archiving. There are
# no runtime symlinks here: Task 7 attaches only approved environment links after
# artifact verification.
find "$payload" -type d -exec chmod 0755 {} +
find "$payload" -type f -exec chmod 0644 {} +
find "$payload/infra/scripts" -type f -exec chmod 0755 {} +
if find "$payload" -type l -print -quit | grep -q .; then
    echo "runtime payload contains a symlink" >&2
    exit 1
fi

payload_sha256=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$payload" -cf - . | sha256sum | awk '{print $1}')
archive="$temporary/out/am2-backend-runtime.tar.gz"
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$payload" -czf "$archive" .
archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
server_lock_sha256=$(sha256sum "$source_root/server/package-lock.json" | awk '{print $1}')
webadmin_lock_sha256=$(sha256sum "$source_root/WebAdmin/package-lock.json" | awk '{print $1}')
node_major=$(node -p 'process.versions.node.split(".")[0]')
php_version=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')

cat > "$temporary/out/artifact-manifest.json" <<EOF
{
  "schema_version": 1,
  "application": "am2-backend",
  "source_sha": "$expected_sha",
  "payload_sha256": "$payload_sha256",
  "archive_sha256": "$archive_sha256",
  "runtime": {"node": "$node_major", "php": "$php_version"},
  "lockfiles": {
    "server_package_lock_sha256": "$server_lock_sha256",
    "webadmin_package_lock_sha256": "$webadmin_lock_sha256"
  }
}
EOF
# Lockfiles are detached provenance, not runtime payload. Keeping exact copies
# beside the archive lets the deploy verifier prove the manifest's lock identity
# without polluting the release tree with build inputs.
mkdir -p "$temporary/out/lockfiles"
install -m 0644 "$source_root/server/package-lock.json" "$temporary/out/lockfiles/server-package-lock.json"
install -m 0644 "$source_root/WebAdmin/package-lock.json" "$temporary/out/lockfiles/webadmin-package-lock.json"
(
    cd "$temporary/out"
    # The manifest and detached lockfiles are deployment inputs. Seal every
    # one beside the archive so altered provenance cannot ride with intact bytes.
    sha256sum am2-backend-runtime.tar.gz artifact-manifest.json \
        lockfiles/server-package-lock.json lockfiles/webadmin-package-lock.json > SHA256SUMS
)

mv -T -- "$temporary/out" "$output_dir"
temporary=
printf 'runtime artifact packaged: %s %s\n' "$expected_sha" "$archive_sha256"
