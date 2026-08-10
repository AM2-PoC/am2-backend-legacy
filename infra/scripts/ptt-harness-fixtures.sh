#!/usr/bin/env bash
# Give the contract-test units a real password and a channel, so the WebSocket
# harness can complete an app_login. Staging database only.
#
# CT_A1 and CT_A2 share ct_channel_a; CT_A3 sits in ct_channel_a2 instead. That
# third unit is not decoration -- app_login refuses a user with no default
# channel, so without it there was no way to have an authenticated caller who is
# *outside* the channel under test, and "the attacker received the audio" could
# not be told apart from "the attacker received the channel broadcast like any
# other member".
set -euo pipefail
DB=am2_staging
[ "$DB" = "am2_staging" ] || { echo "REFUSING"; exit 1; }
ENVF=/etc/am2/contract-test.env
. "$ENVF"

if ! grep -q '^CT_PTT_PASS=' "$ENVF"; then
    P=$(openssl rand -base64 18 | tr -d '/+=' | head -c 18)
    printf 'CT_PTT_PASS=%s\n' "$P" >> "$ENVF"
    CT_PTT_PASS=$P
fi
H=$(P="$CT_PTT_PASS" php -r 'echo password_hash(getenv("P"), PASSWORD_BCRYPT);')
case "$H" in \$2y\$*) ;; *) echo "REFUSING: bad hash"; exit 1;; esac

sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
UPDATE public.users SET password = '$H' WHERE id IN ('CT_A1','CT_A2','CT_A3','CT_B1');

-- Video capability is the conjunction of the per-user switch below and the
-- owning admin's branch-level capability. Keep both enabled for protocol tests.
UPDATE public.admin a
SET can_manage_p2p = true,
    can_manage_video = true
WHERE a.id IN (
    SELECT DISTINCT u.admin_id
    FROM public.users u
    WHERE u.id IN ('CT_A1','CT_A2','CT_A3','CT_B1')
);

INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
SELECT v.uid, c.id, true, 'FULL DUPLEX'
FROM (VALUES ('CT_A1'),('CT_A2')) AS v(uid)
JOIN public.channels c ON c.name = 'ct_channel_a'
ON CONFLICT (user_id, channel_id) DO UPDATE
   SET is_default = true, permission = 'FULL DUPLEX';

UPDATE public.users u SET last_channel_id = c.id
FROM public.channels c WHERE c.name = 'ct_channel_a' AND u.id IN ('CT_A1','CT_A2');

-- The outsider: authenticated, same tenant, different channel.
INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
SELECT 'CT_A3', c.id, true, 'FULL DUPLEX'
FROM public.channels c WHERE c.name = 'ct_channel_a2'
ON CONFLICT (user_id, channel_id) DO UPDATE
  SET is_default = true, permission = 'FULL DUPLEX';

UPDATE public.users u SET last_channel_id = c.id
FROM public.channels c WHERE c.name = 'ct_channel_a2' AND u.id = 'CT_A3';

-- Cross-tenant peer: authenticated under branch B and placed on branch B's
-- channel so app_login can complete without weakening the default-channel
-- invariant.
INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
SELECT 'CT_B1', c.id, true, 'FULL DUPLEX'
FROM public.channels c WHERE c.name = 'ct_channel_b'
ON CONFLICT (user_id, channel_id) DO UPDATE
  SET is_default = true, permission = 'FULL DUPLEX';

UPDATE public.users u SET last_channel_id = c.id
FROM public.channels c WHERE c.name = 'ct_channel_b' AND u.id = 'CT_B1';

INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode)
VALUES ('CT_A1', true, true, true, 'FULL DUPLEX'), ('CT_A2', true, true, true, 'FULL DUPLEX'),
       ('CT_A3', true, true, true, 'FULL DUPLEX'), ('CT_B1', true, true, true, 'FULL DUPLEX')
ON CONFLICT (user_id) DO UPDATE
   SET enable_p2p = true, enable_ptt_video = true, duplex_mode = 'FULL DUPLEX';
COMMIT;
SQL
sudo -u postgres psql -d "$DB" -tAc \
 "SELECT u.id||' channel='||coalesce(u.last_channel_id::text,'-')||' perm='||coalesce(uc.permission,'-')
  FROM public.users u LEFT JOIN public.user_channels uc ON uc.user_id=u.id
  WHERE u.id IN ('CT_A1','CT_A2','CT_A3','CT_B1');"
