#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: audit-runtime-boundary.sh [--deploy-gate]

Checks that AM2 runtime activation is artifact-only. With --deploy-gate, the
same fresh audit is used immediately before a new deploy transition.
USAGE
}

mode=timer
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-gate) mode=deploy-gate; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
done

CURRENT=${AM2_RUNTIME_CURRENT:-/var/www/am2/current}
STAGING_CURRENT=${AM2_RUNTIME_STAGING_CURRENT:-/var/www/am2/staging/current}
CACHE_ROOT=${AM2_RUNTIME_CACHE_ROOT:-/var/lib/am2-artifacts}
OPERATOR_CHECKOUT=${AM2_RUNTIME_OPERATOR_CHECKOUT:-/home/am2deploy/am2-main}
SYSTEMD_DIR=${AM2_RUNTIME_SYSTEMD_DIR:-/etc/systemd/system}
CRON_DIR=${AM2_RUNTIME_CRON_DIR:-/etc/cron.d}
LIBEXEC_DIR=${AM2_RUNTIME_LIBEXEC_DIR:-/usr/local/libexec/am2}
PRODUCTION_UNIT=${AM2_RUNTIME_PRODUCTION_UNIT:-am2-api}
STAGING_UNIT=${AM2_RUNTIME_STAGING_UNIT:-am2-api-staging}
RELAY_DIGEST=${AM2_RUNTIME_RELAY_DIGEST:-$LIBEXEC_DIR/relay-source-digest.sh}

# The VPS checkout is an explicit temporary operator exception only. It is not
# accepted as a runtime path and this audit never treats it as deploy input.
# Task 14 removes this exception after an approved non-production destination
# exists for chat-assisted coding and GitHub work.

failures=()
fail() { failures+=("$*"); }

release_identity() {
  local label=$1 pointer=$2 unit=$3 release pid cwd artifact source archive payload digest_running digest_deployed
  release=$(readlink -f "$pointer" 2>/dev/null || true)
  [[ -n $release && -d $release && ! -L $release ]] || { fail "$label current pointer is invalid"; return; }
  for forbidden in .git .github .hermes tests docs; do
    [[ ! -e "$release/$forbidden" ]] || fail "$label active release contains forbidden $forbidden"
  done
  [[ -f "$release/.release-sha" && -f "$release/.artifact-identity.json" ]] || {
    fail "$label active release lacks artifact identity"; return;
  }
  read -r source archive payload < <(python3 - "$release/.artifact-identity.json" <<'PY'
import json,re,sys
value=json.load(open(sys.argv[1], encoding='utf-8'))
if set(value) != {'source_sha','archive_sha256','payload_sha256'}:
    raise SystemExit(1)
for key, width in (('source_sha',40),('archive_sha256',64),('payload_sha256',64)):
    if not re.fullmatch(f'[0-9a-f]{{{width}}}', str(value.get(key,''))):
        raise SystemExit(1)
print(value['source_sha'], value['archive_sha256'], value['payload_sha256'])
PY
) || { fail "$label artifact identity is malformed"; return; }
  [[ $(tr -d '\r\n' < "$release/.release-sha") == "$source" ]] || fail "$label release marker differs from artifact identity"
  artifact="$CACHE_ROOT/$source/$archive"
  for required in am2-backend-runtime.tar.gz artifact-manifest.json SHA256SUMS; do
    [[ -f "$artifact/$required" && ! -L "$artifact/$required" ]] || fail "$label retained artifact is missing $required"
  done
  if [[ $label == production || $label == staging ]]; then
    systemctl is-active --quiet "$unit" || { fail "$label service is not active"; return; }
    pid=$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    [[ $pid =~ ^[1-9][0-9]*$ && -n $cwd ]] || { fail "$label service has no resolvable PID cwd"; return; }
    if [[ $cwd != "$release/server" ]]; then
      [[ -x $RELAY_DIGEST ]] || { fail "$label relay digest tool is unavailable"; return; }
      digest_running=$($RELAY_DIGEST "$cwd" 2>/dev/null || true)
      digest_deployed=$($RELAY_DIGEST "$release/server" 2>/dev/null || true)
      [[ -n $digest_running && $digest_running == "$digest_deployed" ]] || fail "$label PID cwd differs from active runtime identity"
    fi
  fi
}

release_identity production "$CURRENT" "$PRODUCTION_UNIT"
release_identity staging "$STAGING_CURRENT" "$STAGING_UNIT"

# Source based deployment tooling is forbidden in privileged deployment scopes.
# Search only controlled service/cron/libexec configuration, never user docs or
# the approved transitional operator checkout.
for root in "$SYSTEMD_DIR" "$CRON_DIR" "$LIBEXEC_DIR"; do
  [[ -d $root ]] || continue
  if grep -RIlE --exclude=audit-runtime-boundary.sh 'git (clone|fetch|pull|checkout)|npm (ci|install)|build-release\.sh' "$root" 2>/dev/null | grep -q .; then
    fail "source or build command is present in deployment automation under $root"
  fi
  if grep -RIlE --exclude=audit-runtime-boundary.sh 'am2_repo_deploy|github\.com-am2-backend-legacy|gh auth' "$root" 2>/dev/null | grep -q .; then
    fail "source repository credential reference is present in deployment automation under $root"
  fi
done

if systemctl list-unit-files --no-legend 2>/dev/null | grep -Eqi 'github.*runner|actions.*runner'; then
  fail "a CI runner is registered on the runtime host"
fi
if pgrep -af 'Runner\.Listener|runsvc\.sh|actions-runner' >/dev/null 2>&1; then
  fail "a CI runner process is active on the runtime host"
fi

if (( ${#failures[@]} )); then
  printf 'AM2 runtime boundary drift (%s):\n' "$mode" >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi

# Healthy timer runs intentionally emit no output. A deploy gate performs this
# same fresh check, so a stale prior timer result cannot inhibit deployment.
exit 0
