#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 --release /absolute/release --manifest /absolute/artifact-manifest.json [--allow-relay-restart]" >&2
}
release=
manifest=
allow_restart=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release) [[ $# -ge 2 ]] || { usage; exit 64; }; release=$2; shift 2 ;;
        --manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; manifest=$2; shift 2 ;;
        --allow-relay-restart) allow_restart=1; shift ;;
        *) usage; exit 64 ;;
    esac
done
[[ $release == /* && -d $release && $manifest == /* && -f $manifest ]] || { usage; exit 64; }

CURRENT=${AM2_STAGING_CURRENT:-/var/www/am2/staging/current}
UNIT=${AM2_STAGING_UNIT:-am2-api-staging}
URL=${AM2_STAGING_URL:-http://127.0.0.1:5001/}
LOCK=${AM2_DEPLOY_LOCK:-/var/lib/am2-relay-watchdog/deploy.lock}
RECEIPTS=${AM2_STAGING_RECEIPTS:-/var/www/am2/staging/shared/rehearsals}
VERIFY_CURRENT=${AM2_VERIFY_CURRENT:-/usr/local/libexec/am2/verify-current-release.sh}
VERIFY_ARTIFACT=${AM2_VERIFY_ARTIFACT:-/usr/local/libexec/am2/verify-materialized-artifact.sh}
ENV_FILE=${AM2_STAGING_ENV:-/etc/am2/api.staging.env}

readarray -t identity < <(python3 - "$manifest" <<'PYTHON'
import json, re, sys
value=json.load(open(sys.argv[1], encoding='utf-8'))
for key,width in (('source_sha',40),('archive_sha256',64),('payload_sha256',64)):
    item=str(value.get(key,''))
    if not re.fullmatch(f'[0-9a-f]{{{width}}}',item): raise SystemExit(f'invalid {key}')
    print(item)
PYTHON
)
source_sha=${identity[0]}; archive_sha256=${identity[1]}; payload_sha256=${identity[2]}
"$VERIFY_ARTIFACT" --release "$release" --manifest "$manifest" >/dev/null
"$VERIFY_CURRENT" "$release" >/dev/null
old=$(readlink -f "$CURRENT")
[[ $old != "$release" ]] || { echo "rehearsal requires a distinct rollback release" >&2; exit 1; }
"$VERIFY_CURRENT" "$old" >/dev/null
"$release/infra/scripts/smoke-release.sh" "$release" "$source_sha" "$ENV_FILE" | grep -q 'isolated release smoke OK'
(( allow_restart )) || { echo "staging relay restart approval is required" >&2; exit 1; }

exec 9>"$LOCK"
flock -x 9
wait_ready() {
    local expected=$1 before=$2 pid cwd body
    for _ in $(seq 1 60); do
        pid=$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || true)
        cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
        body=$(curl -fsS --max-time 2 "$URL" 2>/dev/null || true)
        if systemctl is-active --quiet "$UNIT" && [[ $pid =~ ^[1-9][0-9]*$ && $pid != "$before" && $cwd == "$expected/server" && $body == *"PTT Server"* ]]; then
            printf '%s\n' "$pid"; return 0
        fi
        sleep 1
    done
    return 1
}
switch_and_restart() {
    local target=$1 before
    before=$(systemctl show "$UNIT" -p MainPID --value)
    ln -sfn "$target" "$CURRENT.new"
    mv -Tf "$CURRENT.new" "$CURRENT"
    systemctl reset-failed "$UNIT"
    systemctl restart "$UNIT"
    wait_ready "$target" "$before"
}
restore_on_failure() {
    local rc=$?
    trap - ERR INT TERM HUP
    set +e
    if [[ $(readlink -f "$CURRENT" 2>/dev/null) != "$old" ]]; then switch_and_restart "$old" >/dev/null; fi
    exit "$rc"
}
trap restore_on_failure ERR INT TERM HUP
candidate_pid=$(switch_and_restart "$release")
"$VERIFY_ARTIFACT" --release "$release" --manifest "$manifest" >/dev/null
rollback_pid=$(switch_and_restart "$old")
"$VERIFY_CURRENT" "$old" >/dev/null
repromoted_pid=$(switch_and_restart "$release")
"$VERIFY_ARTIFACT" --release "$release" --manifest "$manifest" >/dev/null

install -d -o root -g root -m 0755 "$RECEIPTS"
receipt=$RECEIPTS/$(date -u +%Y%m%dT%H%M%SZ)-$archive_sha256.receipt
umask 022
cat > "$receipt.incoming" <<RECEIPT
schema_version 1
source_sha $source_sha
archive_sha256 $archive_sha256
payload_sha256 $payload_sha256
rollback_release $old
candidate_release $release
candidate_pid $candidate_pid
rollback_pid $rollback_pid
repromoted_pid $repromoted_pid
status verified
RECEIPT
chmod 0644 "$receipt.incoming"
mv -T "$receipt.incoming" "$receipt"
trap - ERR INT TERM HUP
printf '%s\n' "$receipt"
