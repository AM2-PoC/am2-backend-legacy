#!/usr/bin/env bash
set -euo pipefail

service=${AM2_WATCHDOG_SERVICE:-am2-api}
url=${AM2_WATCHDOG_URL:-http://127.0.0.1:5000/}
current=${AM2_WATCHDOG_CURRENT:-/var/www/am2/current}
state_dir=${AM2_WATCHDOG_STATE_DIR:-/var/lib/am2-relay-watchdog}
deploy_lock=${AM2_DEPLOY_LOCK:-/var/lib/am2-relay-watchdog/deploy.lock}

# Deployment owns an exclusive lock while it swaps /current and restarts the
# relay. A health sample in that intentional transition window is invalid, so
# skip it without alerting. The next timer tick verifies the resulting state.
mkdir -p "$(dirname "$deploy_lock")"
exec 9>"$deploy_lock"
flock -n -s 9 || exit 0

fail() {
    echo "relay unhealthy: $*" >&2
    exit 1
}

active=$(systemctl is-active "$service" 2>/dev/null || true)
[[ $active == active ]] || fail "service $service is $active"

pid=$(systemctl show "$service" -p MainPID --value 2>/dev/null || true)
[[ $pid =~ ^[1-9][0-9]*$ ]] || fail "service $service has no MainPID"

current_real=$(readlink -f "$current" 2>/dev/null || true)
pid_cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
[[ -n $current_real && -n $pid_cwd ]] || fail "cannot resolve current/PID cwd identity"

# What matters is the code the relay is running, not the path it is running it
# from.
#
# A WebSocket cannot survive its process ending, so a deploy either restarts the
# relay and cuts whoever is transmitting, or swaps /current and leaves the relay
# where it is. The second is right whenever server/ did not change -- and this
# check called it a fault, every minute, for sixteen days, because it compared
# paths. Nobody could act on that without accepting the very interruption the
# skipped restart avoided.
#
# So compare content. Identical means the relay is running exactly what is
# deployed and the path is bookkeeping; different means it is running code that
# is no longer deployed, which is the real fault and still fails.
#
# node_modules is excluded because it is reinstalled per release from the same
# lockfile, and hashing it every minute would cost more than it tells us.
# package-lock.json is a regular file in server/, so a dependency change is
# still caught.
# One implementation, shared with the deploy that asks the same question.
digest_of() {
    "$(dirname "$0")/relay-source-digest.sh" "$1"
}

if [[ $pid_cwd != "$current_real/server" ]]; then
    running=$(digest_of "$pid_cwd") \
        || fail "runtime identity mismatch: cannot read relay source at $pid_cwd"
    deployed=$(digest_of "$current_real/server") \
        || fail "runtime identity mismatch: cannot read deployed relay source at $current_real/server"
    [[ $running == "$deployed" ]] \
        || fail "runtime identity mismatch: relay is running stale code from $pid_cwd, deployed is $current_real/server"
fi

mkdir -p "$state_dir"
restart_file="$state_dir/${service}.restarts"
restarts=$(systemctl show "$service" -p NRestarts --value 2>/dev/null || true)
[[ $restarts =~ ^[0-9]+$ ]] || fail "invalid restart counter: $restarts"
if [[ -f $restart_file ]]; then
    previous=$(tr -d '\r\n' < "$restart_file")
    [[ $previous =~ ^[0-9]+$ ]] || previous=$restarts
    (( restarts <= previous )) || fail "restart counter grew: $previous -> $restarts"
fi

http_result=$(curl --silent --show-error --max-time 5 --write-out $'\n%{http_code}' "$url" 2>/dev/null || true)
status=${http_result##*$'\n'}
body=${http_result%$'\n'*}
[[ $status == 200 ]] || fail "HTTP status is $status"
[[ $body == *"PTT Server"* ]] || fail "HTTP body missing PTT Server marker"

printf '%s\n' "$restarts" > "$restart_file"

# The other edge.
#
# Failure routes to the alert through systemd's OnFailure=. Recovery had no
# path at all, so the issue thread could only ever say that something broke --
# never that it was fixed -- and the only way to learn the difference was to
# come back here and look. Silence has to mean healthy for silence to be worth
# anything.
#
# A failure to deliver the notice is worth an error line and nothing more: the
# relay is healthy, and reporting it as unhealthy because a comment did not
# post would be a lie in the more dangerous direction.
if [[ -f "$state_dir/episode.open" ]]; then
    "$(dirname "$0")/send-relay-alert.sh" --recovered \
        "relay healthy again: $service on $current_real" \
        || echo "relay recovered but the notice could not be delivered" >&2
fi
