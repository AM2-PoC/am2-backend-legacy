#!/usr/bin/env bash
# Protocol tests share staging users, channels, and a single relay. Running the
# files concurrently makes one file's permission/session mutation race another.
#
# On the VPS the fixtures are prepared here rather than left to whoever is
# running this. They are not optional -- app_login refuses a unit with no
# default channel, and the contract suite deliberately ends by deleting the
# rows this one needs: channel-access.test.mjs clears CT_A1 and nulls its
# last_channel_id, which is correct for that file and leaves this one unable to
# log anybody in.
#
# Without this, running the two suites in the order anyone would try them fails
# inside a `before` hook with "the admin has not set a default channel for you",
# cancels 27 tests, and reads exactly like a broken relay. It is not: it is an
# empty fixture, and the fix was always a second script that nothing told you
# to run.
#
# Not in CI. There the relay and its database come up under compose, the job
# seeds that database itself, and it hands us CT_ENV_FILE pointing at its own
# credentials -- so that variable is the signal to keep our hands off. The
# scripts would fail there anyway: both target am2_staging through
# `sudo -u postgres`, and neither exists on a runner.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${CT_ENV_FILE:-}" ] && [ -f /etc/am2/contract-test.env ]; then
    ./infra/scripts/contract-test-fixtures.sh > /dev/null
    ./infra/scripts/ptt-harness-fixtures.sh   > /dev/null
fi

# The admin routes are reached with the relay's own key, so the suite needs it
# for the same reason it needs the fixture rows: without it those routes answer
# 401 and the failure reads as a broken feature rather than a missing input.
# One file, one variable, never echoed.
if [ -z "${AM2_API_KEY:-}" ]; then
    for candidate in "${CT_RELAY_ENV_FILE:-}" /etc/am2/api.staging.env; do
        [ -n "$candidate" ] && [ -r "$candidate" ] || continue
        AM2_API_KEY=$(sed -ne 's/^AM2_API_KEY=//p' "$candidate" | head -1)
        [ -n "$AM2_API_KEY" ] && export AM2_API_KEY && break
    done
fi

exec node --test --test-concurrency=1 tests/protocol/*.test.mjs
