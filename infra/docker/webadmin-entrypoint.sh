#!/bin/sh
#
# config.php reads secrets from a file at AM2_ENV_FILE (default
# /etc/am2/webadmin.env.production), not from getenv() of the process
# environment directly. Whether Apache's mod_php forwards its own process
# environment to PHP or strips it is a real difference between Apache
# builds -- this container is not the place to find out which the base
# image does, so it writes the file config.php already knows how to read,
# from the environment docker-compose set on this container.
set -eu

mkdir -p /etc/am2
env | grep '^AM2_' > /etc/am2/webadmin.env.production || true

exec "$@"
