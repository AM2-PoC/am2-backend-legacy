#!/usr/bin/env bash
set -euo pipefail

# Prove the net is actually catching, on a running host.
#
# Every other check in this change reads source text. This one asks the question
# the source cannot answer: if somebody drops a PHP file into the panel's
# document root and forgets every convention -- no config.php, no guard, no
# session check -- does the request still get refused?
#
# That is the only property that makes this design safe for a maintainer who
# forgets, so it is worth a probe rather than an assumption. The probe is
# written, requested and removed within the run, and it prints nothing but a
# marker so a false pass cannot look like a real page.
#
# Defaults to the staging lane. Production must be named explicitly.

lane=staging
while [[ $# -gt 0 ]]; do
    case "$1" in
        --lane) [[ $# -ge 2 ]] || { echo "usage: $0 [--lane staging|production]" >&2; exit 64; }
                lane=$2; shift 2 ;;
        *) echo "usage: $0 [--lane staging|production]" >&2; exit 64 ;;
    esac
done

case "$lane" in
    staging)    docroot=/var/www/am2/staging/current/WebAdmin; origin=127.0.0.1:8081
                host=staging-webadmin.am2-poc.com ;;
    production) docroot=/var/www/am2/current/WebAdmin;         origin=127.0.0.1:8080
                host=webadmin.am2-poc.com ;;
    *) echo "unknown lane: $lane" >&2; exit 64 ;;
esac

[[ -d $docroot ]] || { echo "no document root at $docroot" >&2; exit 1; }

# A name nothing else will collide with, and one that says what it is if a run
# is interrupted before the cleanup.
probe=am2-guard-probe-$$.php
marker="GUARD-PROBE-REACHED-$$"

cleanup() { sudo rm -f "$docroot/$probe"; }
trap cleanup EXIT

# Deliberately unguarded: no config.php, no session check, nothing. This is the
# file a maintainer writes at speed, and the whole design is about that file
# being safe anyway.
printf '<?php echo "%s";\n' "$marker" | sudo tee "$docroot/$probe" >/dev/null
sudo chown --reference="$docroot" "$docroot/$probe"
sudo chmod 0644 "$docroot/$probe"

status=$(curl -s -o /tmp/am2-guard-probe.out -w '%{http_code}' \
    -H "Host: $host" -H 'Accept: application/json' \
    "http://$origin/$probe" || echo 000)
body=$(cat /tmp/am2-guard-probe.out); rm -f /tmp/am2-guard-probe.out

failed=0
if grep -q "$marker" <<<"$body"; then
    echo "FAIL: an unguarded file ran and returned its own output ($lane)" >&2
    failed=1
elif [[ $status != 401 ]]; then
    echo "FAIL: expected 401 for an unguarded file, got $status ($lane)" >&2
    failed=1
else
    echo "ok: an unguarded file in $lane is refused with 401 before it runs"
fi

# The other half: the two public entry points must still answer, or nobody can
# obtain the session everything else now requires. A guard that refuses the
# login page is a locked building with the keys inside.
login=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" \
    "http://$origin/login.php" || echo 000)
if [[ $login == 200 ]]; then
    echo "ok: login.php still answers without a session"
else
    echo "FAIL: login.php answered $login; nobody can sign in ($lane)" >&2
    failed=1
fi

# Every PHP file in the document root, asked twice with no session.
#
# Reasoning about which files are guarded is exactly what produced thirteen
# endpoints that disagreed with each other, so this asks all of them instead.
# It also covers the ones nobody thinks of as endpoints: config.php,
# session_boot.php, i18n.php and the other libraries are reachable by URL like
# anything else, and before the shared guard they would run.
#
# Two shapes, because the right refusal differs: a fetch() or an API client
# needs a status it can act on, a browser navigating needs to arrive at the
# login page. Anything that answers 200 to either is serving an anonymous
# caller.
echo "sweeping every .php in $docroot"
sweep_bad=0
for file in "$docroot"/*.php; do
    name=$(basename "$file")
    api=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" \
        -H 'Accept: application/json' "http://$origin/$name" || echo 000)
    nav=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" \
        -H 'Accept: text/html' -H 'Sec-Fetch-Dest: document' \
        "http://$origin/$name" || echo 000)

    case "$name" in
        # The one page that must answer, and the sign-in endpoint, which is
        # POST-only and so refuses a GET on its own terms after the guard lets
        # it through.
        login.php)     [[ $api == 200 && $nav == 200 ]] || { echo "FAIL: login.php answered api=$api nav=$nav" >&2; sweep_bad=1; }; continue ;;
        api_login.php) [[ $api == 405 && $nav == 405 ]] || { echo "FAIL: api_login.php answered api=$api nav=$nav" >&2; sweep_bad=1; }; continue ;;
    esac

    if [[ $api != 401 ]]; then
        echo "FAIL: $name answered $api to an anonymous API call, not 401" >&2
        sweep_bad=1
    fi
    if [[ $nav != 302 && $nav != 401 ]]; then
        echo "FAIL: $name answered $nav to an anonymous navigation, not 302" >&2
        sweep_bad=1
    fi
done
if (( sweep_bad )); then
    failed=1
else
    count=$(ls -1 "$docroot"/*.php | wc -l)
    echo "ok: all $count PHP files in the $lane document root refuse an anonymous caller"
fi

exit "$failed"
