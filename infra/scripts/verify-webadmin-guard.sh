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
# forgets, so it is worth asking rather than assuming. It is asked of files that
# are already there: seven of the panel's own files include no config.php, so
# nothing has to be written into a release to find out. Releases are immutable
# and owned by am2release under artifact-only delivery, and an earlier version
# of this script created a probe file inside one -- briefly, with sudo, but
# inside one all the same.
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

# A file that never requires config.php, chosen rather than created.
#
# This used to write a synthetic probe into the document root and delete it
# again. That was wrong twice over. Releases are immutable and owned by
# am2release under the artifact-only delivery model, so writing into one --
# even briefly, even with sudo -- is exactly what that model exists to prevent.
# And it was unnecessary: seven files already in the panel include no config.php
# at all, so the property can be checked against something real.
#
# i18n.php is the clearest of them. It defines translation helpers, includes
# nothing, and has no side effects worth triggering. If layer two is not
# running, it answers 200 with an empty body -- which is what production did
# until the guard was installed at 16:28 today.
probe=i18n.php
if ! grep -q "require.*config\.php" "$docroot/$probe" 2>/dev/null; then
    :
else
    echo "FAIL: $probe now includes config.php, so it no longer tests layer two" >&2
    echo "      pick another file that does not, or this check proves nothing" >&2
    exit 1
fi

status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Host: $host" -H 'Accept: application/json' \
    "http://$origin/$probe" || echo 000)

failed=0
if [[ $status == 401 ]]; then
    echo "ok: a file that never requires config.php is refused before it runs ($lane)"
else
    echo "FAIL: $probe answered $status, not 401 -- layer two is not running ($lane)" >&2
    failed=1
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
