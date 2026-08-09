#!/usr/bin/env bash
# Prove the contract suite can actually fail.
#
# A green suite means nothing until you have watched it go red. This breaks one
# thing at a time in the staging tree, checks that at least one test notices,
# and puts it back.
#
# Staging only. Refuses to run anywhere else.
set -uo pipefail

W=/var/www/am2/staging/current/WebAdmin
S=/var/www/am2/staging/current/server
REPO=/home/am2deploy/am2-main

[ -d "$W" ] || { echo "REFUSING: staging tree not found at $W"; exit 1; }
case "$(readlink -f /var/www/am2/current)" in
    *staging*) echo "REFUSING: production symlink points into staging"; exit 1 ;;
esac

# mod_php caches compiled bytecode. With opcache.revalidate_freq=2 a file
# changed less than two seconds ago is still served from the old bytecode, so a
# mutation appears to escape when it was simply never loaded.
OPCACHE_WAIT=3

cd "$REPO"
run() { node --test tests/contract/*.test.mjs 2>&1 | grep -cE '^    not ok'; }

pass=0; fail=0
mutate() {  # description, file, sed-expression
    local desc=$1 file=$2 expr=$3
    cp "$file" /tmp/mutation.bak
    sed -i "$expr" "$file"
    if cmp -s /tmp/mutation.bak "$file"; then
        echo "  SKIP    $desc (mutation did not change the file)"
        rm -f /tmp/mutation.bak; return
    fi
    sleep "$OPCACHE_WAIT"
    local n; n=$(run)
    cp /tmp/mutation.bak "$file"; rm -f /tmp/mutation.bak
    sleep "$OPCACHE_WAIT"
    if [ "$n" -gt 0 ]; then
        echo "  caught  $desc  ($n failing)"; pass=$((pass+1))
    else
        echo "  ESCAPED $desc  <-- the suite does not cover this"; fail=$((fail+1))
    fi
}

echo "baseline failures: $(run)  (must be 0)"
echo

mutate "rename dispatch field add_user, PHP side"   "$W/users.php"       "s/'add_user'/'add_userX'/g"
mutate "rename dispatch field add_user, HTML side"  "$W/users.php"       's/name="add_user"/name="add_userX"/g'
mutate "drop one data-label from a table cell"      "$W/channels.php"    '0,/data-label=/s///'
mutate "rename a JSON key the log screen reads"     "$W/fetch_logs.php"  's/ as aksi/ as action/g'
mutate "rename a node admin route"                  "$S/server.js"       's#/api/admin/force-logout#/api/admin/fl2#'
mutate "break the def_label_ id convention"         "$W/user_access.php" 's/id="def_label_/id="deflabel/g'
mutate "rename a leaflet divIcon class"             "$W/livetrack.php"   's/pulse-dot/pulsedot/g'
mutate "switch users.php error key msg to message"  "$W/users.php"       "s/'msg'/'message'/g"
mutate "unlink the shared stylesheet"               "$W/partials/head.php" 's#asset/css/am2-tailwind.css#asset/css/gone.css#'
mutate "wrap a bare array response in an envelope"  "$W/users.php" \
    's/echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));/echo json_encode(["data"=>$stmt->fetchAll(PDO::FETCH_COLUMN)]);/'

echo
echo "caught $pass, escaped $fail"
echo "restored, failures now: $(run)  (must be 0)"
[ "$fail" -eq 0 ]
