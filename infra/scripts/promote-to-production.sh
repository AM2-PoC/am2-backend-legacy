#!/usr/bin/env bash
set -euo pipefail

# Move production to a release, or refuse and say which gate stopped it.
#
# Every step here already existed as its own script. What did not exist was
# anything that ran them in order and stopped when one failed -- the sequence
# lived in docs/how-to/deploy-and-roll-back.md and in whoever happened to be
# doing the deploy.
#
# On 2026-09-04 at 11:29:06 production was moved to a new release with none of
# these gates: no staging acceptance, no verified rollback target, no smoke
# against the production environment, no record that it happened beyond the
# symlink's own mtime. That was not the cause of the incident six minutes later
# -- the vulnerability predated it -- but the gates existed on paper and were
# skipped, which is the only interesting thing about them. Later the same day
# the same gates were run correctly, by hand, one command at a time. Both
# outcomes came from the same arrangement: a checklist a person executes.
#
# This does not decide whether to promote. It decides whether promoting is
# allowed to proceed, and leaves a receipt saying what was promoted and by whom.
#
#   promote-to-production.sh --release /var/www/am2/releases/<stamp>-<sha12>
#   promote-to-production.sh --release ... --dry-run    # run the gates only

usage() {
    cat >&2 <<'USAGE'
Usage: promote-to-production.sh --release /absolute/release [--dry-run] [--allow-relay-restart]

  --release              the candidate. Must already be built and published.
  --dry-run              run every gate, change nothing.
  --allow-relay-restart  permit the step that disconnects every connected unit.
                         Without it, a release whose relay source differs from
                         the running one is refused rather than restarted
                         silently.
USAGE
}

release=
dry_run=0
allow_restart=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release)             [[ $# -ge 2 ]] || { usage; exit 64; }; release=$2; shift 2 ;;
        --dry-run)             dry_run=1; shift ;;
        --allow-relay-restart) allow_restart=1; shift ;;
        -h|--help)             usage; exit 0 ;;
        *)                     usage; exit 64 ;;
    esac
done
[[ -n $release && $release == /* && -d $release ]] || { usage; exit 64; }

CURRENT=/var/www/am2/current
STAGING=/var/www/am2/staging/current
RECEIPTS=/var/www/am2/shared/promotions

sha_of() { tr -d '\r\n' < "$1/.release-sha"; }
gate=0
step() { printf '\n── %s\n' "$*"; }
refuse() { echo "REFUSED: $*" >&2; gate=1; }

sha=$(sha_of "$release")
old=$(readlink -f "$CURRENT")
old_sha=$(sha_of "$old")

echo "candidate : $release"
echo "            $sha"
echo "rollback  : $old"
echo "            $old_sha"

# ── Gate 1. Staging ran this exact source.
#
# The gate that would have caught 11:29. Production took a release built from a
# SHA no staging release had ever been built from, and nothing noticed. Compared
# by SHA rather than by release name because the two lanes stamp their
# directories independently.
step "staging has run this source"
staging_sha=$(sha_of "$STAGING" 2>/dev/null || echo '')
if [[ -z $staging_sha ]]; then
    refuse "cannot read the staging release; there is nothing to compare against"
elif [[ $staging_sha != "$sha" ]]; then
    refuse "staging is running $staging_sha, not $sha -- promote what was tested"
else
    echo "ok: staging is running the same source"
fi

# ── Gate 2. The candidate can start.
step "candidate runtime"
if "$release/infra/scripts/verify-release-runtime.sh" "$release" "$sha" >/dev/null 2>&1; then
    echo "ok: candidate verifies"
else
    refuse "the candidate does not verify; run verify-release-runtime.sh to see why"
fi

# ── Gate 3. So can the thing we would roll back to.
#
# Recording a rollback target proves nothing if that release can no longer
# start. A rollback nobody has checked is a hope, not a plan.
step "rollback target runtime"
if [[ $old == "$release" ]]; then
    echo "ok: already current, nothing to roll back to"
elif "$old/infra/scripts/verify-release-runtime.sh" "$old" "$old_sha" >/dev/null 2>&1; then
    echo "ok: rollback target verifies"
else
    refuse "the rollback target does not verify -- promoting would leave nowhere to go back to"
fi

# ── Gate 4. It starts against production's own environment.
#
# Isolated cold start on a random loopback port, using the real env file. Not
# the same as "it worked on staging": staging has its own database, its own
# relay port and its own env.
step "cold start against the production environment"
if "$release/infra/scripts/smoke-release.sh" "$release" "$sha" /etc/am2/api.env 2>&1 | grep -q 'isolated release smoke OK'; then
    echo "ok: smoke passed"
else
    refuse "the candidate did not survive a cold start with the production environment"
fi

# ── Gate 5. Does this disconnect anybody?
#
# PHP is read from disk per request, so the panel changes the moment the symlink
# moves and nobody is interrupted. The relay holds its code in memory, so a
# relay change needs a restart and a restart drops every connected unit. That is
# a decision, not a detail, so it has to be asked for rather than discovered.
step "relay impact"
relay_digest() { (cd "$1/server" && find . -name '*.js' -not -path './node_modules/*' -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
if [[ $(relay_digest "$release") == $(relay_digest "$old") ]]; then
    echo "ok: relay source is unchanged; no restart, nobody is disconnected"
    restart_needed=0
else
    restart_needed=1
    online=$(sudo -u postgres psql -d am2 -At -c "select count(*) from public.users where status='online';" 2>/dev/null || echo '?')
    if (( allow_restart )); then
        echo "note: relay source changed; $online unit(s) will be disconnected and must reconnect"
    else
        refuse "relay source changed and $online unit(s) are online -- pass --allow-relay-restart to accept that, or promote in a quiet window"
    fi
fi

if (( gate )); then
    echo
    echo "production was not touched." >&2
    exit 1
fi

echo
echo "all gates passed."
if (( dry_run )); then
    echo "dry run: production was not touched."
    exit 0
fi

# ── Promote.
step "moving $CURRENT"
sudo ln -sfn "$release" "$CURRENT.new"
sudo mv -Tf "$CURRENT.new" "$CURRENT"
echo "current -> $(readlink -f "$CURRENT")"

if (( restart_needed )); then
    step "restarting the relay"
    sudo systemctl restart am2-api
    sleep 3
    systemctl is-active --quiet am2-api || { echo "am2-api did not come back" >&2; exit 1; }
    echo "ok: am2-api active as PID $(systemctl show am2-api -p MainPID --value)"
fi

# ── Prove the panel still refuses everyone it should.
#
# Run after the move rather than before, and after a pause: PHP's opcache serves
# the previous bytecode for a second or two through a symlink whose path has not
# changed, so a check run immediately reports the release that was just
# replaced.
step "guard, after the move"
sleep 3
"$release/infra/scripts/verify-webadmin-guard.sh" --lane production

# ── Receipt.
#
# The only record that production moved at 11:29 was the symlink's own mtime.
step "receipt"
sudo install -d -m 0755 "$RECEIPTS"
receipt=$RECEIPTS/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}.txt
sudo tee "$receipt" >/dev/null <<RECEIPT
promoted_at   $(date -u +%Y-%m-%dT%H:%M:%SZ)
actor         ${SUDO_USER:-$USER}
release       $release
source_sha    $sha
rolled_from   $old
previous_sha  $old_sha
staging_sha   $staging_sha
relay_restart $restart_needed
RECEIPT
echo "$receipt"

echo
echo "promoted. to undo:"
echo "  sudo ln -sfn $old $CURRENT.new && sudo mv -Tf $CURRENT.new $CURRENT"
(( restart_needed )) && echo "  sudo systemctl restart am2-api"
exit 0
