#!/bin/bash

set -euo pipefail

DB=""
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --db)      DB="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;

        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$DB" ] || { echo "REFUSING: --db is required (e.g. --db am2_staging)" >&2; exit 2; }

MIG_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
# Fed on stdin, never with -f on a path. psql runs as postgres, which cannot
# read the deploy user's checkout -- the first real run of this script failed
# exactly there, with "Permission denied" on a file sitting right next to it.
# Reading the file stays with the user who owns it.
psql_db() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" "$@"; }

psql_db -tAc 'SELECT 1' >/dev/null

psql_db <<'SQL'

SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
skipped=0

for path in "$MIG_DIR"/*.sql; do
    file="$(basename "$path")"
    sum="$(sha256sum "$path" | cut -d' ' -f1)"
    recorded="$(psql_db -tAc \
        "SELECT checksum FROM public.schema_migrations WHERE filename = '${file//\'/\'\'}'")"

    if [ -n "$recorded" ]; then
        if [ "$recorded" != "$sum" ]; then
            echo "REFUSING: $file was applied as $recorded but is now $sum" >&2
            echo "  The database and this checkout disagree about what ran." >&2
            echo "  Write a new migration rather than editing an applied one." >&2
            exit 1
        fi
        skipped=$((skipped + 1))
        continue
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "would apply $file"
        applied=$((applied + 1))
        continue
    fi

    # CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and it is
    # in 001 for a good reason: ptt_logs is written on every transmission, so
    # the non-concurrent form would hold a write lock against live traffic.
    # Wrapping every migration in one transaction would therefore fail on the
    # first file -- so the wrapping is decided per file.
    #
    # Comments stripped before looking: 001 explains CONCURRENTLY in prose above
    # the statement that uses it, and a file that only mentioned the word would
    # otherwise be run without a transaction and lose atomicity silently.
    if sed 's/--.*//' "$path" | grep -qi 'CONCURRENTLY'; then
        echo "applying $file (outside a transaction: CONCURRENTLY)"
        psql_db -f - < "$path"
        # Recorded after the fact, which is the honest cost of not having a
        # transaction. If this line is what fails, re-running is safe: the
        # migrations are written idempotently (IF NOT EXISTS throughout).
        psql_db -c \
            "INSERT INTO public.schema_migrations (filename, checksum)
             VALUES ('${file//\'/\'\'}', '$sum')"
    else
        echo "applying $file"

        { cat "$path"
          printf "\nINSERT INTO public.schema_migrations (filename, checksum) VALUES ('%s', '%s');\n" \
              "${file//\'/\'\'}" "$sum"
        } | psql_db --single-transaction -f -
    fi

    applied=$((applied + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then
    echo "dry run: $applied to apply, $skipped already recorded"
else
    echo "applied $applied, already present $skipped"
fi
