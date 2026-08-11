#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 /absolute/release-root 40-character-git-sha" >&2
}

if [[ $# -ne 2 ]]; then
    usage
    exit 64
fi

release_root=$1
expected_sha=$2
if [[ $release_root != /* ]]; then
    echo "release root must be an absolute path" >&2
    exit 64
fi
if [[ ! $expected_sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "expected SHA must be a lowercase 40-character Git commit SHA" >&2
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

actual_sha=$(tr -d '\r\n' < "$release_root/.release-sha")
if [[ $actual_sha != "$expected_sha" ]]; then
    echo "release marker mismatch: expected $expected_sha, found $actual_sha" >&2
    exit 1
fi
if [[ ! -d $release_root/server/node_modules ]]; then
    echo "production dependency directory is missing: $release_root/server/node_modules" >&2
    exit 1
fi

while IFS= read -r -d '' source_file; do
    node --check "$source_file" >/dev/null
done < <(find "$release_root/server" -path '*/node_modules' -prune -o -type f -name '*.js' -print0)

(
    cd "$release_root/server"
    node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const packagePath = path.join(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const dependencies = Object.keys(pkg.dependencies || {}).sort();
if (dependencies.length === 0) {
  throw new Error('server/package.json declares no production dependencies');
}
for (const dependency of dependencies) {
  require.resolve(dependency, { paths: [process.cwd()] });
}
console.log(`runtime dependency closure OK (${dependencies.length} packages)`);
NODE
)

printf 'release runtime verified: %s\n' "$expected_sha"
