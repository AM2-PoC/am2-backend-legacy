#!/usr/bin/env bash
set -euo pipefail


usage() { echo "usage: $0 [--lane staging|production] | --list-assets /path/to/WebAdmin" >&2; }

list_assets() {
    local dir=$1
    { grep -hoE "(am2_asset(_url)?\(\s*['\"]|(src|href)=['\"])\.?/?asset/[A-Za-z0-9._/-]+" \
        "$dir"/*.php "$dir"/partials/*.php 2>/dev/null || true; } \
        | sed -E "s#^.*['\"]\.?/?(asset/)#\1#" \
        | sort -u
}

lane=staging
while [[ $# -gt 0 ]]; do
    case "$1" in
        --lane) [[ $# -ge 2 ]] || { usage; exit 64; }
                lane=$2; shift 2 ;;
        --list-assets)
                [[ $# -eq 2 && -d $2 ]] || { usage; exit 64; }
                list_assets "$2"; exit 0 ;;

        *) usage; exit 64 ;;
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

# Callers run this right after a release symlink swap -- the production gate,
# with no relay restart, well under a second after it. mod_php keeps a switched
# path for realpath_cache_ttl (2s in the sealed ini) plus the rest of the
# current second, so asking at once could test the previous release's PHP and
# pass. Wait out that window before the first request.
sleep 3

probe=i18n.php
if ! grep -q "require.*config\.php" "$docroot/$probe" 2>/dev/null; then
    :
else
    echo "FAIL: $probe now includes config.php, so it no longer tests layer two" >&2
    echo "      pick another file that does not, or this check proves nothing" >&2
    exit 1
fi

status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
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
login=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" \
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
    api=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" \
        -H 'Accept: application/json' "http://$origin/$name" || echo 000)
    nav=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" \
        -H 'Accept: text/html' -H 'Sec-Fetch-Dest: document' \
        "http://$origin/$name" || echo 000)

    case "$name" in

        login.php)     [[ $api == 200 && $nav == 200 ]] || { echo "FAIL: login.php answered api=$api nav=$nav" >&2; sweep_bad=1; }; continue ;;
        api_login.php) [[ $api == 405 && $nav == 405 ]] || { echo "FAIL: api_login.php answered api=$api nav=$nav" >&2; sweep_bad=1; }; continue ;;

        auth_guard.php|session_boot.php)
            [[ $api == 404 && $nav == 404 ]] || { echo "FAIL: $name answered api=$api nav=$nav, not 404" >&2; sweep_bad=1; }
            continue ;;
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

# Every asset the pages load, from the lane's own origin. Assets are public, so
# this needs no session, and it asks Apache rather than the CDN so a cached
# copy cannot answer for a file the release does not carry.
assets=$(list_assets "$docroot")
[[ -n $assets ]] || { echo "FAIL: found no page assets in $docroot; the asset sweep proves nothing" >&2; failed=1; }
asset_bad=0
for asset in $assets; do
    status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" \
        "http://$origin/$asset" || echo 000)
    if [[ $status != 200 ]]; then
        echo "FAIL: page asset $asset answered $status, not 200 ($lane)" >&2
        asset_bad=1
    fi
done
if (( asset_bad )); then
    failed=1
elif [[ -n $assets ]]; then
    echo "ok: all $(wc -w <<<"$assets") page assets answer 200 on the $lane origin"
fi

exit "$failed"
