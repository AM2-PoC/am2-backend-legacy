#!/bin/bash
#
# Who would be turned away if AM2_API_AUTH_MODE were set to "enforce".
#
# Both halves of the API auth check currently record and allow: PHP writes
# "api-auth REJECT-CANDIDATE" to the Apache error log, the relay writes it to
# the journal. That is the whole point of the "log" mode -- it exists so the
# switch can be flipped on evidence instead of on hope, because the callers are
# field devices nobody can survey directly.
#
# This turns those lines into the answer to one question: is anything still
# calling these endpoints without a key, and what is it?
#
# Read-only. It reads logs and prints a summary.
#
# Usage:
#   infra/scripts/api-auth-report.sh                 # production, all retained logs
#   infra/scripts/api-auth-report.sh --env staging
#   infra/scripts/api-auth-report.sh --since "7 days ago"
#
# Reading it:
#
#   Callers from 127.0.0.1 with ua=node are this repository's own contract
#   suite, not the field. They are listed separately for exactly that reason --
#   the first run of this report was 486 lines that all turned out to be the
#   test run from four minutes earlier.
#
#   An empty report means one of two very different things: nothing is calling
#   without a key, or the code that logs this is not deployed. Check the second
#   before believing the first. The script says which it found.
set -euo pipefail

ENVIRONMENT=production
SINCE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --env)   ENVIRONMENT="${2:-}"; shift 2 ;;
        --since) SINCE="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

case "$ENVIRONMENT" in
    production) APACHE_GLOB=/var/log/apache2/am2_webadmin_error.log; UNIT=am2-api ;;
    staging)    APACHE_GLOB=/var/log/apache2/am2_staging_error.log;  UNIT=am2-api-staging ;;
    *) echo "unknown environment: $ENVIRONMENT (expected production or staging)" >&2; exit 2 ;;
esac

echo "== API auth readiness: $ENVIRONMENT =="
echo

# ---------------------------------------------------------------------------
# Is the code that produces these lines actually running?
#
# Asked first because it decides what an empty report means. Production was
# serving a release from three months earlier that had no api-auth check at
# all, so its silent log said nothing whatsoever about traffic.
# ---------------------------------------------------------------------------
CURRENT=$(readlink -f /var/www/am2/current 2>/dev/null || true)
[ "$ENVIRONMENT" = staging ] && CURRENT=$(readlink -f /var/www/am2/staging/current 2>/dev/null || true)

if [ -z "$CURRENT" ]; then
    echo "deployed release: UNKNOWN (no current symlink)"
    DEPLOYED_HAS_CHECK=unknown
elif grep -q "REJECT-CANDIDATE" "$CURRENT/WebAdmin/config.php" 2>/dev/null; then
    echo "deployed release: $CURRENT"
    echo "  api-auth check:  PRESENT -- an empty report below is meaningful"
    DEPLOYED_HAS_CHECK=yes
else
    echo "deployed release: $CURRENT"
    echo "  api-auth check:  ABSENT -- this release predates it."
    echo "                   An empty report below means NOTHING IS BEING RECORDED,"
    echo "                   not that nothing is calling. Deploy first, then measure."
    DEPLOYED_HAS_CHECK=no
fi

MODE=$(grep -hoE '^AM2_API_AUTH_MODE=.*' "/etc/am2/webadmin.env.$ENVIRONMENT" 2>/dev/null | cut -d= -f2- || true)
echo "  configured mode: ${MODE:-unset (defaults to log)}"
echo

# ---------------------------------------------------------------------------
# The PHP half.
# ---------------------------------------------------------------------------
lines() {
    # zgrep over the rotated set too: a week of history is the point, and the
    # interesting caller may be the one that ran once on a Sunday.
    zgrep -h "api-auth REJECT-CANDIDATE" "$APACHE_GLOB"* 2>/dev/null || true
}

ALL=$(lines | wc -l)
# The contract suite calls every one of these endpoints from localhost as node.
# Counting it as field traffic is how a clean report gets misread as a busy one.
SELF=$(lines | grep -c "from 127.0.0.1 ua=node" || true)
FIELD=$((ALL - SELF))

echo "-- panel endpoints (PHP) --"
echo "recorded rejections: $ALL total, $SELF from this repo's own test suite, $FIELD from everything else"
echo

if [ "$FIELD" -gt 0 ]; then
    #
    # Grouped by endpoint with a last-seen date, not by raw line.
    #
    # The dates are the point. Reading this report the first time, sixty
    # rejections for api_dashboard_chart.php from real browsers looked like
    # proof that enforce would 401 the panel's own dashboard -- and they were
    # all from a week earlier, before the session-aware path landed. Without a
    # date beside the count there is no way to tell a live problem from a
    # fixed one, and the whole report is only useful if it can tell them apart.
    #
    echo "callers that are not the test suite (newest first):"
    printf '  %-6s %-12s %s\n' "COUNT" "LAST SEEN" "ENDPOINT / SOURCE"
    #
    # Parsed in awk rather than with a sed capture. A user agent contains
    # commas and the Apache line carries a trailing ", referer: ..." -- a
    # regex that tried to bound the UA field stopped early, failed to match
    # the browser lines entirely, and passed them through raw. Pulling out
    # only the fields that are actually delimited is the version that holds.
    #
    lines | grep -v "from 127.0.0.1 ua=node" | awk '
        {
            # "[Mon Aug 03 11:21:15 2026]" -> "Aug 03"
            day = $2 " " $3

            method = ""; endpoint = ""; src = ""
            for (i = 1; i <= NF; i++) {
                if ($i == "REJECT-CANDIDATE") { method = $(i+1); split($(i+2), u, "?"); endpoint = u[1] }
                if ($i == "from")             { src = $(i+1) }
            }
            if (endpoint == "") next

            # The kind of caller is what matters, not the exact build string.
            kind = (index($0, "Mozilla") ? "browser" : \
                   (index($0, "ua=curl") ? "curl" : \
                   (index($0, "ua=node") ? "node" : "other")))

            key = method " " endpoint "\t" kind
            count[key]++
            # Month names do not sort, so compare on the raw seconds instead.
            cmd = "date -d \"" day "\" +%s 2>/dev/null"
            cmd | getline epoch; close(cmd)
            if (epoch + 0 > seen[key] + 0) { seen[key] = epoch; last[key] = day }
        }
        END { for (k in count) printf "  %-6d %-12s %s\n", count[k], last[k], k }
    ' | sort -rn | head -25
    echo
    echo "  A recent date here is a request that would become 401 under enforce."
    echo "  An old one is probably already fixed -- check what changed since."
else
    echo "  nothing outside the test suite."
fi
echo

# ---------------------------------------------------------------------------
# The relay half.
# ---------------------------------------------------------------------------
echo "-- relay routes (node) --"
JOURNAL_ARGS=(-u "$UNIT" --no-pager)
[ -n "$SINCE" ] && JOURNAL_ARGS+=(--since "$SINCE")

if journalctl "${JOURNAL_ARGS[@]}" -n 0 >/dev/null 2>&1; then
    RELAY=$(journalctl "${JOURNAL_ARGS[@]}" 2>/dev/null | grep -c "REJECT-CANDIDATE" || true)
    echo "recorded rejections: $RELAY"
    if [ "$RELAY" -gt 0 ]; then
        journalctl "${JOURNAL_ARGS[@]}" 2>/dev/null | grep "REJECT-CANDIDATE" \
            | sed -E 's/.*REJECT-CANDIDATE ([A-Z]+) ([^ ]+) from ([^ ]+) ua=(.*) key=(.*)/  \3  \1 \2  ua=\4  key=\5/' \
            | sort | uniq -c | sort -rn | head -20
    fi
else
    echo "  journal for $UNIT not readable (try with sudo)"
fi
echo

# ---------------------------------------------------------------------------
# The verdict, stated rather than left to be inferred.
# ---------------------------------------------------------------------------
echo "-- verdict --"
if [ "$DEPLOYED_HAS_CHECK" != yes ]; then
    echo "NOT READY TO DECIDE: the deployed release does not record rejections."
    echo "Deploy the release carrying am2_api_auth() in log mode, leave it a few days,"
    echo "then run this again. Until then there is no evidence either way."
elif [ "$FIELD" -eq 0 ]; then
    echo "No caller outside the test suite has been rejected in the retained logs."
    echo "That is the evidence enforce needs -- confirm the window is long enough"
    echo "to include a quiet weekend before acting on it."
else
    echo "$FIELD requests would have failed under enforce. Identify each caller above"
    echo "before flipping; the field devices cannot be surveyed any other way."
fi
