#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 /absolute/release-root" >&2
}

if [[ $# -ne 1 ]]; then
    usage
    exit 64
fi

release_root=$1
if [[ $release_root != /* ]]; then
    echo "release root must be an absolute path" >&2
    exit 64
fi
if [[ ! -d $release_root ]]; then
    echo "release directory is missing: $release_root" >&2
    exit 1
fi

for required in \
    "$release_root/.release-sha" \
    "$release_root/server/package.json" \
    "$release_root/server/package-lock.json" \
    "$release_root/server/server.js"
do
    if [[ ! -f $required ]]; then
        echo "required release file is missing: $required" >&2
        exit 1
    fi
done

marker=$(tr -d '\r\n' < "$release_root/.release-sha")
if [[ ! $marker =~ ^[0-9a-f]{40}$ ]]; then
    echo "invalid release marker: $release_root/.release-sha" >&2
    exit 1
fi

if [[ -x $release_root/infra/scripts/verify-release-runtime.sh ]]; then
    exec "$release_root/infra/scripts/verify-release-runtime.sh" "$release_root" "$marker"
fi

# Compatibility path for pre-P0 rollback targets. It intentionally validates
# only the runtime closure that the legacy release can prove; new releases must
# carry the strict verifier above.
server_root=$release_root/server
node --check "$server_root/server.js" >/dev/null
(
    cd "$server_root"
    node - <<'NODE'
const dependencies = Object.keys(require('./package.json').dependencies || {});
for (const dependency of dependencies) {
    require.resolve(dependency, { paths: [process.cwd()] });
}
console.log(`legacy runtime dependency closure OK (${dependencies.length} packages)`);
NODE
)
printf 'legacy rollback runtime verified: %s\n' "$marker"
