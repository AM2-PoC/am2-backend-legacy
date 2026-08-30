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

# A release must not go live ahead of its own schema.
#
# 80ab744 shipped the device-token login and 005_device_tokens.sql together,
# and nothing tied them: whether the table existed came down to somebody
# remembering apply-migrations.sh. A relay that starts without it does not
# complain -- the issuing call is wrapped in a try that logs and continues,
# and the verifying call leaves through the login catch-all, which the handset
# is told is a database timeout.
#
# This asks the database the relay itself will use, with the relay's own
# credentials, because a superuser seeing the row proves nothing about the
# account that has to read it. And it runs here rather than at ExecStartPre:
# refusing to start has already stopped the release that was working, while
# refusing to pass leaves it serving until the migration is run.
(
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    cd "$release_root/server"
    RELEASE_ROOT="$release_root" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(process.env.RELEASE_ROOT, 'infra/migrations');
const carried = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
    : [];
if (carried.length === 0) {
    console.log('release carries no migrations to check');
    process.exit(0);
}

// After the early exit, not before: a release that carries no migrations has
// nothing to ask the database, and the restart-safety fixture is exactly such
// a release -- a bare entrypoint with no node_modules to require pg from.
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    connectionTimeoutMillis: 10000,
});

pool.query('SELECT filename FROM public.schema_migrations')
    .then(({ rows }) => {
        const applied = new Set(rows.map((row) => row.filename));
        const missing = carried.filter((name) => !applied.has(name));
        if (missing.length > 0) {
            console.error(
                `the database is behind this release: ${missing.join(', ')} `
                + `${missing.length === 1 ? 'is' : 'are'} not applied to ${process.env.DB_NAME}.`);
            console.error(
                '  run: infra/scripts/apply-migrations.sh --db ' + process.env.DB_NAME);
            console.error('  the release that is live now keeps serving until you do.');
            process.exit(1);
        }
        console.log(`schema is current for this release (${carried.length} migrations)`);
        process.exit(0);
    })
    .catch((err) => {
        // A missing schema_migrations table is itself the answer: nothing has
        // ever been applied here.
        console.error(`cannot read the applied migrations from ${process.env.DB_NAME}: ${err.message}`);
        console.error('  run: infra/scripts/apply-migrations.sh --db ' + process.env.DB_NAME);
        process.exit(1);
    });
NODE
) || exit 1

printf 'isolated release smoke OK: %s\n' "$expected_sha"
