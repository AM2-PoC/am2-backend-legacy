#!/usr/bin/env bash
set -euo pipefail

# Alerts are edges, not a level.
#
# This used to deliver the same sentence every AM2_ALERT_DEDUP_SECONDS for as
# long as a fault lasted. The production watchdog was installed into a hybrid
# runtime state on 11 August and failed every minute for sixteen days; it was
# correct every time, and it produced twenty-six identical GitHub comments and
# an hourly `wall` broadcast to every terminal on the VPS. Nobody acted on any
# of them, which is what repetition does to a signal.
#
# So an episode is announced when it opens, repeated only rarely while it stays
# open, and -- the part that never existed -- announced once more when it
# clears. The thread then reads as a history of faults rather than a stopped
# clock, and silence means healthy instead of meaning nothing.

recovered=0
if [[ ${1:-} == --recovered ]]; then
    recovered=1
    shift
fi

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 [--recovered] alert-message" >&2
    exit 64
fi

message=$*
state_dir=${AM2_WATCHDOG_STATE_DIR:-/var/lib/am2-relay-watchdog}
# A day, not ten minutes. While a fault is open the useful reminder cadence is
# "still broken tomorrow", and anything shorter has already been proven to be
# noise rather than pressure.
dedup_seconds=${AM2_ALERT_DEDUP_SECONDS:-86400}
if [[ ! $dedup_seconds =~ ^[0-9]+$ ]]; then
    echo "AM2_ALERT_DEDUP_SECONDS must be a non-negative integer" >&2
    exit 64
fi

mkdir -p "$state_dir"
episode_file="$state_dir/episode.open"
key=$(printf '%s' "$message" | sha256sum | cut -d' ' -f1)
stamp_file="$state_dir/alert-$key.timestamp"
now=$(date +%s)

# Nothing to recover from. Said without delivering anything, because a
# recovery notice for a fault nobody was told about is just noise with a
# friendlier tone.
if (( recovered )) && [[ ! -f $episode_file ]]; then
    exit 0
fi

# Repetition is suppressed only while the episode that produced it is still
# open. Once it closes, the same fault returning is new information and is
# announced immediately -- which the old flat timestamp got wrong.
if (( ! recovered )) && [[ -f $episode_file && -f $stamp_file ]]; then
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

if (( recovered )); then
    # Every trace of the episode goes, including the per-message stamps, so a
    # fault that comes back tomorrow is announced rather than suppressed by a
    # timestamp from the one before it.
    rm -f "$episode_file" "$state_dir"/alert-*.timestamp
else
    printf '%s\n' "$now" > "$stamp_file"
    [[ -f $episode_file ]] || printf '%s\n' "$now" > "$episode_file"
fi
