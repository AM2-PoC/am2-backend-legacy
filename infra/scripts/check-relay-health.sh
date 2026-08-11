#!/usr/bin/env bash
set -euo pipefail

service=${AM2_WATCHDOG_SERVICE:-am2-api}
url=${AM2_WATCHDOG_URL:-http://127.0.0.1:5000/}
current=${AM2_WATCHDOG_CURRENT:-/var/www/am2/current}
state_dir=${AM2_WATCHDOG_STATE_DIR:-/var/lib/am2-relay-watchdog}

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
[[ $pid_cwd == "$current_real/server" ]] || fail "runtime identity mismatch: cwd=$pid_cwd current=$current_real/server"

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

printf 'relay healthy: service=%s pid=%s release=%s restarts=%s\n' "$service" "$pid" "$current_real" "$restarts"
