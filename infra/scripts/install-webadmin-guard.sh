#!/usr/bin/env bash
set -euo pipefail


usage() {
    cat >&2 <<'USAGE'
Usage: install-webadmin-guard.sh [--apply] [--source DIR] [--drain-sessions]

  (default)          Report what would change. Touches nothing.
  --apply            Make the changes.
  --source DIR       Repository root to install from (default: this checkout).
  --drain-sessions   Also split the PHP session store per lane. This signs out
                     every operator on both lanes, so it is refused unless
                     asked for explicitly.
USAGE
}

apply=0
drain=0
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
while [[ $# -gt 0 ]]; do
    case "$1" in
        --apply)          apply=1; shift ;;
        --drain-sessions) drain=1; shift ;;
        --source)         [[ $# -ge 2 ]] || { usage; exit 64; }; source_dir=$2; shift 2 ;;
        -h|--help)        usage; exit 0 ;;
        *)                usage; exit 64 ;;
    esac
done

prepend_source=$source_dir/infra/php/webadmin-prepend.php
[[ -r $prepend_source ]] || { echo "no prepend at $prepend_source" >&2; exit 1; }
ini_source=$source_dir/infra/php/99-am2-webadmin-guard.ini
[[ -r $ini_source ]] || { echo "no sealed PHP ini at $ini_source" >&2; exit 1; }

php_version=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
installed=/etc/am2/php/webadmin-prepend.php
ini_name=99-am2-webadmin-guard.ini

say() { printf '%s\n' "$*"; }
run() {
    if (( apply )); then
        "$@"
    else
        say "  would run: $*"
    fi
}

# 1. The prepend itself.
if [[ -r $installed ]] && cmp -s "$prepend_source" "$installed"; then
    say "prepend at $installed is already current"
else
    say "installing $prepend_source -> $installed"
    run sudo install -o root -g root -m 0644 -D "$prepend_source" "$installed"
fi

# 2. The directive, once, in PHP's configuration rather than in a vhost.
#
# Written to every SAPI directory that exists. apache2 is what serves the panel
# today and fpm is what will; installing both now means the FPM cutover inherits
# the guard instead of having to remember it.
installed_into=0
for sapi in apache2 fpm; do
    dir=/etc/php/$php_version/$sapi/conf.d
    [[ -d $dir ]] || continue
    installed_into=$((installed_into + 1))
    target=$dir/$ini_name
    # The sealed ini, byte for byte. A hand-written copy here drifted from it
    # (no realpath or opcache bounds) and would not match its bundle digest.
    if [[ -r $target ]] && cmp -s "$ini_source" "$target"; then
        say "sealed ini already installed for $sapi"
        continue
    fi
    say "installing $ini_source -> $target"
    run sudo install -o root -g root -m 0644 "$ini_source" "$target"
done

# 3. Take the directive out of the vhosts, so there is one source for it.
#
# Left in both places the two would drift, and the vhost copy is the one that
# points at the old file name after this runs.
for vhost in /etc/apache2/sites-available/am2-webadmin-internal.conf \
             /etc/apache2/sites-enabled/am2-webadmin-staging.conf; do
    [[ -r $vhost ]] || continue
    if sudo grep -q '^\s*php_value auto_prepend_file' "$vhost"; then
        say "removing the vhost directive from $vhost"
        run sudo cp -p "$vhost" "$vhost.bak-$(date +%Y%m%d%H%M%S)"
        run sudo sed -i '/^\s*php_value auto_prepend_file/d' "$vhost"
    else
        say "no vhost directive in $(basename "$vhost")"
    fi
done

# 4. One session store per lane. Optional, and it signs everyone out.
#
# Production (:8080) and staging (:8081) share /var/lib/php/sessions today, with
# no per-vhost override -- so a session id obtained on staging is a valid
# session id on production. The cookie domains differ, which stops a browser
# carrying one across; nothing stops curl. Splitting the store closes it, and
# the task is already written down in
# .hermes/plans/2026-08-19_004859-minimum-environment-separation.md:87.
if (( drain )); then
    for pair in "am2-webadmin-internal.conf:/var/lib/php/sessions/am2" \
                "am2-webadmin-staging.conf:/var/lib/php/sessions/am2-staging"; do
        vhost=/etc/apache2/sites-available/${pair%%:*}
        [[ -r $vhost ]] || vhost=/etc/apache2/sites-enabled/${pair%%:*}
        [[ -r $vhost ]] || continue
        dir=${pair#*:}
        say "session store for $(basename "$vhost") -> $dir"
        run sudo install -d -o root -g www-data -m 1730 "$dir"
        if ! sudo grep -q "session.save_path" "$vhost"; then
            run sudo sed -i "/DocumentRoot/a\\    php_value session.save_path $dir" "$vhost"
        fi
    done
    say "NOTE: every operator on both lanes is signed out when Apache reloads."
else
    say "session store: unchanged (pass --drain-sessions to split it per lane)"
fi

# Fail closed if the CLI PHP version maps to no supported web SAPI directory.
if (( installed_into == 0 )); then
    echo "REFUSED: no conf.d directory found under /etc/php/$php_version/" >&2
    echo "  php -v reports $php_version, which is the CLI binary. The web SAPI may be" >&2
    echo "  a different version -- check: apache2ctl -M | grep php, or the FPM unit." >&2
    exit 1
fi

if (( apply )); then
    sudo apache2ctl configtest
    say
    say "Config test passed. Reload Apache to pick this up:"
    say "  sudo systemctl reload apache2"
    say "Then prove the net is live -- a file that never requires config.php"
    say "must still be refused:"
    say "  infra/scripts/verify-webadmin-guard.sh"
else
    say
    say "Nothing was changed. Re-run with --apply."
fi
