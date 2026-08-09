#!/bin/bash
#
# Regenerate infra/docker/seed/01-schema.sql from staging.
#
# This dumps structure only -- zero rows, `pg_dump --schema-only` -- so it is
# not the sensitive part of staging. The two things it strips afterward are
# what a fresh database complains about: \restrict/\unrestrict, psql
# meta-commands some builds do not know, and CREATE SCHEMA public, which
# every Postgres image already has.
#
# Run this on the host that can reach am2_staging (the VPS, over the admin
# SSH connection) -- not from a laptop, which has no route to it.
set -euo pipefail

DB=am2_staging
[ "$DB" = "am2_staging" ] || { echo "REFUSING: this script only reads am2_staging"; exit 1; }

OUT="$(dirname "$0")/../docker/seed/01-schema.sql"
RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

sudo -u postgres pg_dump -d "$DB" --schema-only --no-owner --no-privileges --schema=public > "$RAW"

{
    printf -- '-- Schema only. Generated from staging with `pg_dump --schema-only`,\n'
    printf -- '-- which touches zero rows -- structure is not sensitive, the data behind\n'
    printf -- '-- it is. See infra/docker/seed/02-seed.sql for what actually populates\n'
    printf -- '-- this database: synthetic accounts, never a copy of anything real.\n'
    printf -- '--\n'
    printf -- '-- Regenerated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    grep -v -e '^\\restrict' -e '^\\unrestrict' -e '^CREATE SCHEMA public;$' "$RAW"
} > "$OUT"

echo "wrote $OUT"
