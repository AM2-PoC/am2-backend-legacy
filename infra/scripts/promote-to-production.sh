#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'USAGE'
Usage: promote-to-production.sh --release /absolute/release --archive-sha256 64-hex [--staging-rehearsal-receipt /absolute/file] [--dry-run] [--allow-relay-restart]
USAGE
}

release=
archive_sha256=
rehearsal_receipt=
dry_run=0
allow_restart=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release) [[ $# -ge 2 ]] || { usage; exit 64; }; release=$2; shift 2 ;;
        --archive-sha256) [[ $# -ge 2 ]] || { usage; exit 64; }; archive_sha256=$2; shift 2 ;;
        --staging-rehearsal-receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; rehearsal_receipt=$2; shift 2 ;;
        --dry-run) dry_run=1; shift ;;
        --allow-relay-restart) allow_restart=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 64 ;;
    esac
done
[[ -n $release && $release == /* && -d $release ]] || { usage; exit 64; }
[[ $archive_sha256 =~ ^[0-9a-f]{64}$ ]] || { echo "archive SHA-256 must be lowercase 64-hex" >&2; exit 64; }
[[ -f $release/.artifact-identity.json ]] || { echo "release artifact identity is missing" >&2; exit 1; }
release_archive_sha256=$(python3 - "$release/.artifact-identity.json" <<'PYTHON'
import json
import re
import sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
if set(value) != {'source_sha', 'archive_sha256', 'payload_sha256'}:
    raise SystemExit('release artifact identity key set is not exact')
for key, width in (('source_sha', 40), ('archive_sha256', 64), ('payload_sha256', 64)):
    if not re.fullmatch(f'[0-9a-f]{{{width}}}', str(value.get(key, ''))):
        raise SystemExit(f'release artifact identity {key} is invalid')
print(value['archive_sha256'])
PYTHON
)
[[ $release_archive_sha256 == "$archive_sha256" ]] || {
    echo "release artifact identity does not match requested archive SHA-256" >&2
    exit 1
}

CURRENT=${AM2_PRODUCTION_CURRENT:-/var/www/am2/current}
STAGING=${AM2_STAGING_CURRENT:-/var/www/am2/staging/current}
RECEIPTS=${AM2_PROMOTION_RECEIPTS:-/var/www/am2/shared/promotions}
STAGING_RECEIPTS=${AM2_STAGING_RECEIPTS:-/var/www/am2/staging/shared/rehearsals}
DEPLOY_LOCK=${AM2_DEPLOY_LOCK:-/var/lib/am2-relay-watchdog/deploy.lock}
VERIFY_CURRENT=${AM2_VERIFY_CURRENT:-/usr/local/libexec/am2/verify-current-release.sh}
VERIFY_ARTIFACT=${AM2_VERIFY_ARTIFACT:-/usr/local/libexec/am2/verify-materialized-artifact.sh}
PRODUCTION_ENV=${AM2_PRODUCTION_ENV:-/etc/am2/api.env}
PRODUCTION_UNIT=${AM2_PRODUCTION_UNIT:-am2-api}
STAGING_UNIT=${AM2_STAGING_UNIT:-am2-api-staging}
PRODUCTION_URL=${AM2_PRODUCTION_URL:-http://127.0.0.1:5000/}
STAGING_URL=${AM2_STAGING_URL:-http://127.0.0.1:5001/}
RELAY_DIGEST=${AM2_RELAY_DIGEST:-/usr/local/libexec/am2/relay-source-digest.sh}

sha_of() { tr -d '\r\n' < "$1/.release-sha"; }
step() { printf '\n-- %s\n' "$*"; }
refuse() { echo "REFUSED: $*" >&2; gate=1; }
wait_ready() {
    local unit=$1 url=$2 expected_root=$3 before_pid=$4
    local pid cwd body restarts stable_pid= stable_restarts= healthy_samples=0
    for _ in $(seq 1 60); do
        if systemctl is-active --quiet "$unit"; then
            pid=$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)
            restarts=$(systemctl show "$unit" -p NRestarts --value 2>/dev/null || true)
            cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
            body=$(curl -fsS --max-time 2 "$url" 2>/dev/null || true)
            if [[ $pid =~ ^[1-9][0-9]*$ && $pid != "$before_pid" && $cwd == "$expected_root/server" && $body == *"PTT Server"* ]]; then
                if [[ $pid == "$stable_pid" && $restarts == "$stable_restarts" ]]; then
                    healthy_samples=$((healthy_samples + 1))
                else
                    stable_pid=$pid; stable_restarts=$restarts; healthy_samples=1
                fi
                if (( healthy_samples >= 3 )); then printf '%s\n' "$pid"; return 0; fi
            else
                healthy_samples=0; stable_pid=; stable_restarts=
            fi
        fi
        sleep 1
    done
    return 1
}

# Own the transition before reading old/current identities. The watchdog takes a
# shared lock and therefore skips the intentional mismatch window silently.
exec 9>"$DEPLOY_LOCK"
flock -x 9

sha=$(sha_of "$release")
identity_source_sha=$(python3 - "$release/.artifact-identity.json" <<'PYTHON'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['source_sha'])
PYTHON
)
[[ $identity_source_sha == "$sha" ]] || { echo "release marker and artifact identity source mismatch" >&2; exit 1; }
candidate_manifest=${AM2_CANDIDATE_MANIFEST:-/var/lib/am2-artifacts/$sha/$archive_sha256/artifact-manifest.json}
[[ -f $candidate_manifest && ! -L $candidate_manifest ]] || { echo "trusted candidate manifest is missing" >&2; exit 1; }
"$VERIFY_ARTIFACT" --release "$release" --manifest "$candidate_manifest" >/dev/null
old=$(readlink -f "$CURRENT")
old_sha=$(sha_of "$old")
old_pid=$(systemctl show "$PRODUCTION_UNIT" -p MainPID --value)
old_restarts=$(systemctl show "$PRODUCTION_UNIT" -p NRestarts --value)
running_cwd=$(readlink -f "/proc/$old_pid/cwd" 2>/dev/null || true)
gate=0

echo "candidate : $release"
echo "source    : $sha"
echo "archive   : $archive_sha256"
echo "rollback  : $old ($old_sha)"

step "staging runtime and rehearsal identity"
staging_sha=$(sha_of "$STAGING" 2>/dev/null || true)
staging_pid=$(systemctl show "$STAGING_UNIT" -p MainPID --value 2>/dev/null || true)
staging_cwd=$(readlink -f "/proc/$staging_pid/cwd" 2>/dev/null || true)
staging_body=$(curl -fsS --max-time 5 "$STAGING_URL" 2>/dev/null || true)
staging_release=$(readlink -f "$STAGING" 2>/dev/null || true)
if [[ $(systemctl is-active "$STAGING_UNIT" 2>/dev/null || true) != active || $staging_sha != "$sha" || $staging_cwd != "$staging_release/server" || $staging_body != *"PTT Server"* ]]; then
    refuse "staging is not actively running candidate source $sha"
elif ! "$VERIFY_ARTIFACT" --release "$staging_release" --manifest "$candidate_manifest" >/dev/null 2>&1; then
    refuse "staging is not running the exact candidate artifact bytes"
fi
if [[ -z $rehearsal_receipt || $rehearsal_receipt != "$STAGING_RECEIPTS/"* || ! -f $rehearsal_receipt || -L $rehearsal_receipt || $(stat -c %u "$rehearsal_receipt") -ne 0 || $(stat -c %a "$rehearsal_receipt") != 644 ]]; then
    refuse "an exact staging rehearsal receipt is required"
else
    grep -Fxq "schema_version 1" "$rehearsal_receipt" || refuse "staging rehearsal receipt schema mismatch"
    grep -Fxq "source_sha $sha" "$rehearsal_receipt" || refuse "staging rehearsal receipt source mismatch"
    grep -Fxq "archive_sha256 $archive_sha256" "$rehearsal_receipt" || refuse "staging rehearsal receipt archive mismatch"
    identity_payload_sha=$(python3 - "$release/.artifact-identity.json" <<'PYTHON'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['payload_sha256'])
PYTHON
)
    grep -Fxq "payload_sha256 $identity_payload_sha" "$rehearsal_receipt" || refuse "staging rehearsal receipt payload mismatch"
    grep -Fxq "candidate_release $staging_release" "$rehearsal_receipt" || refuse "staging rehearsal receipt release mismatch"
    grep -Eq '^candidate_pid [1-9][0-9]*$' "$rehearsal_receipt" || refuse "staging rehearsal candidate PID missing"
    grep -Eq '^rollback_pid [1-9][0-9]*$' "$rehearsal_receipt" || refuse "staging rehearsal rollback PID missing"
    grep -Eq '^repromoted_pid [1-9][0-9]*$' "$rehearsal_receipt" || refuse "staging rehearsal re-promotion PID missing"
    grep -Fxq "status verified" "$rehearsal_receipt" || refuse "staging rehearsal is not verified"
fi

step "candidate and rollback preflight"
"$VERIFY_CURRENT" "$release" >/dev/null 2>&1 || refuse "candidate does not pass host-owned preflight"
"$VERIFY_CURRENT" "$old" >/dev/null 2>&1 || refuse "rollback target does not pass host-owned preflight"

step "cold start against production environment"
if "$release/infra/scripts/smoke-release.sh" "$release" "$sha" "$PRODUCTION_ENV" 2>&1 | grep -q 'isolated release smoke OK'; then
    echo "ok: smoke passed"
else
    refuse "candidate did not survive isolated production smoke"
fi

step "relay impact"
if [[ -z $running_cwd || ! -d $running_cwd ]]; then
    refuse "cannot resolve running production PID cwd"
    restart_needed=1
else
    candidate_digest=$($RELAY_DIGEST "$release/server" 2>/dev/null) || { refuse "cannot digest candidate relay"; candidate_digest=; }
    running_digest=$($RELAY_DIGEST "$running_cwd" 2>/dev/null) || { refuse "cannot digest running relay"; running_digest=; }
    if [[ -n $candidate_digest && $candidate_digest == "$running_digest" ]]; then
        restart_needed=0
        echo "ok: running relay bytes already match candidate"
    else
        restart_needed=1
        online=$(sudo -u postgres psql -d am2 -At -c "select count(*) from public.users where status='online';" 2>/dev/null || echo '?')
        if (( allow_restart )); then
            echo "note: relay differs; $online unit(s) will reconnect"
        else
            refuse "relay differs and $online unit(s) are online; explicit --allow-relay-restart is required"
        fi
    fi
fi

if (( gate )); then
    echo "production was not touched." >&2
    exit 1
fi
if (( dry_run )); then
    echo "all gates passed; dry run did not touch production."
    exit 0
fi

cutover_started=0
rollback_on_failure() {
    local rc=$?
    trap - ERR INT TERM HUP
    set +e
    if (( cutover_started )); then
        echo "promotion failed; restoring $old" >&2
        ln -sfn "$old" "$CURRENT.rollback"
        mv -Tf "$CURRENT.rollback" "$CURRENT"
        systemctl reset-failed "$PRODUCTION_UNIT"
        systemctl restart "$PRODUCTION_UNIT"
        rollback_pid=$(wait_ready "$PRODUCTION_UNIT" "$PRODUCTION_URL" "$old" "${new_pid:-0}")
        if [[ -z $rollback_pid ]]; then
            echo "rollback service verification failed" >&2
        fi
        if ! "$VERIFY_CURRENT" "$old" >/dev/null 2>&1; then
            echo "rollback release preflight failed" >&2
        fi
    fi
    exit "$rc"
}
trap rollback_on_failure ERR INT TERM HUP

step "atomic activation"
ln -sfn "$release" "$CURRENT.new"
mv -Tf "$CURRENT.new" "$CURRENT"
cutover_started=1

if (( restart_needed )); then
    systemctl restart "$PRODUCTION_UNIT"
    new_pid=$(wait_ready "$PRODUCTION_UNIT" "$PRODUCTION_URL" "$release" "$old_pid")
else
    new_pid=$old_pid
    [[ $(readlink -f "/proc/$new_pid/cwd") == "$release/server" ]] || {
        candidate_digest=$($RELAY_DIGEST "$release/server")
        running_digest=$($RELAY_DIGEST "$(readlink -f "/proc/$new_pid/cwd")")
        [[ $candidate_digest == "$running_digest" ]]
    }
    curl -fsS --max-time 5 "$PRODUCTION_URL" | grep -q 'PTT Server'
fi
[[ $(readlink -f "$CURRENT") == "$release" ]]
[[ $(sha_of "$CURRENT") == "$sha" ]]
[[ $(systemctl show "$PRODUCTION_UNIT" -p NRestarts --value) -le $old_restarts ]]
"$release/infra/scripts/verify-webadmin-guard.sh" --lane production

step "receipt"
install -d -m 0755 "$RECEIPTS"
receipt=$RECEIPTS/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}.txt
cat > "$receipt.incoming" <<RECEIPT
promoted_at $(date -u +%Y-%m-%dT%H:%M:%SZ)
actor ${SUDO_USER:-$USER}
release $release
source_sha $sha
archive_sha256 $archive_sha256
rolled_from $old
previous_sha $old_sha
staging_rehearsal_receipt $rehearsal_receipt
relay_restart $restart_needed
status verified
RECEIPT
chmod 0644 "$receipt.incoming"
mv -T "$receipt.incoming" "$receipt"
cutover_started=0
trap - ERR INT TERM HUP
echo "promoted: $receipt"
