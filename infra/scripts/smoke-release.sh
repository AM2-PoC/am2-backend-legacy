#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 /absolute/release-root 40-character-git-sha /absolute/protected.env" >&2
}

if [[ $# -ne 3 ]]; then
    usage
    exit 64
fi

release_root=$1
expected_sha=$2
env_file=$3
if [[ $release_root != /* || $env_file != /* ]]; then
    echo "release root and environment file must be absolute paths" >&2
    exit 64
fi
if [[ ! $expected_sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "expected SHA must be a lowercase 40-character Git commit SHA" >&2
    exit 64
fi
if [[ ! -f $release_root/.release-sha ]]; then
    echo "release marker is missing" >&2
    exit 1
fi
actual_sha=$(tr -d '\r\n' < "$release_root/.release-sha")
if [[ $actual_sha != "$expected_sha" ]]; then
    echo "release marker mismatch: expected $expected_sha, found $actual_sha" >&2
    exit 1
fi
if [[ ! -f $release_root/server/server.js ]]; then
    echo "relay entrypoint is missing" >&2
    exit 1
fi
if [[ ! -r $env_file ]]; then
    echo "protected environment file is missing or unreadable: $env_file" >&2
    exit 1
fi

port=$(node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});
')
log_file=$(mktemp)
pid=
cleanup() {
    if [[ -n ${pid:-} ]] && kill -0 "$pid" 2>/dev/null; then
        kill -INT "$pid" 2>/dev/null || true
        for _ in {1..20}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
    rm -f -- "$log_file"
}
trap cleanup EXIT INT TERM HUP

(
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    export PORT="$port"
    export HOST=127.0.0.1
    exec node "$release_root/server/server.js"
) >"$log_file" 2>&1 &
pid=$!

ready=0
for _ in {1..100}; do
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "isolated relay exited before readiness" >&2
        sed -n '1,80p' "$log_file" >&2
        exit 1
    fi
    body=$(curl --silent --show-error --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null || true)
    if [[ $body == *"PTT Server"* ]]; then
        ready=1
        break
    fi
    sleep 0.1
done

if [[ $ready -ne 1 ]]; then
    echo "isolated relay did not become ready before deadline" >&2
    sed -n '1,80p' "$log_file" >&2
    exit 1
fi

printf 'isolated release smoke OK: %s\n' "$expected_sha"
