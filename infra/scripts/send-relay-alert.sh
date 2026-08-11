#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 alert-message" >&2
    exit 64
fi

message=$*
state_dir=${AM2_WATCHDOG_STATE_DIR:-/var/lib/am2-relay-watchdog}
dedup_seconds=${AM2_ALERT_DEDUP_SECONDS:-600}
if [[ ! $dedup_seconds =~ ^[0-9]+$ ]]; then
    echo "AM2_ALERT_DEDUP_SECONDS must be a non-negative integer" >&2
    exit 64
fi
mkdir -p "$state_dir"
key=$(printf '%s' "$message" | sha256sum | cut -d' ' -f1)
stamp_file="$state_dir/alert-$key.timestamp"
now=$(date +%s)
if [[ -f $stamp_file ]]; then
    previous=$(tr -d '\r\n' < "$stamp_file")
    if [[ $previous =~ ^[0-9]+$ ]] && (( now - previous < dedup_seconds )); then
        printf 'relay alert deduplicated: %s\n' "$message"
        exit 0
    fi
fi

logger --tag am2-relay-alert --priority daemon.crit -- "$message"

if [[ -n ${AM2_ALERT_COMMAND:-} ]]; then
    if [[ $AM2_ALERT_COMMAND != /* || ! -x $AM2_ALERT_COMMAND ]]; then
        echo "AM2_ALERT_COMMAND must be an absolute executable path" >&2
        exit 1
    fi
    "$AM2_ALERT_COMMAND" "$message"
else
    echo "relay alert logged locally; external AM2_ALERT_COMMAND is not configured" >&2
    exit 1
fi

printf '%s\n' "$now" > "$stamp_file"
