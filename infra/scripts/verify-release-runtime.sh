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

node_executable=/usr/bin/node
if [[ ! -x $node_executable ]]; then
    node_executable=$(command -v node)
fi
readarray -t node_contract < <(python3 - "$release_root/server/package.json" "$release_root/server/package-lock.json" <<'PYTHON'
import json, sys
package = json.load(open(sys.argv[1], encoding='utf-8'))
lock = json.load(open(sys.argv[2], encoding='utf-8'))
print(package.get('engines', {}).get('node', ''))
print(lock.get('packages', {}).get('', {}).get('engines', {}).get('node', ''))
PYTHON
)
[[ ${node_contract[0]} == 22.x && ${node_contract[1]} == 22.x ]] || {
    echo "release Node runtime declaration is unsupported or inconsistent" >&2
    exit 1
}
actual_node_major=$("$node_executable" -p 'process.versions.node.split(".")[0]')
[[ $actual_node_major == 22 ]] || {
    echo "Node runtime major mismatch: release requires 22, service executable provides $actual_node_major" >&2
    exit 1
}

while IFS= read -r -d '' source_file; do
    "$node_executable" --check "$source_file" >/dev/null
done < <(find "$release_root/server" -path '*/node_modules' -prune -o -type f -name '*.js' -print0)

(
    cd "$release_root/server"
    "$node_executable" <<'NODE'
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

(
    cd "$release_root/server"
    "$node_executable" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
if (!lock.packages || typeof lock.packages !== 'object') {
  throw new Error('package-lock.json does not contain a package map');
}
for (const [relative, metadata] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || metadata.dev === true) continue;
  const installed = path.join(process.cwd(), relative);
  if (!fs.statSync(installed, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`missing locked production dependency: ${relative}`);
  }
  if (!fs.statSync(path.join(installed, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`locked production dependency lacks package.json: ${relative}`);
  }
}
NODE
)
printf 'release runtime verified: %s\n' "$expected_sha"
