#!/usr/bin/env bash
# Fixtures: dedicated accounts in am2_staging for the contract tests.
# Never touches existing rows. Idempotent. Staging database only.
set -euo pipefail

DB=am2_staging
ENVF=/etc/am2/contract-test.env

# Refuse to run against production, however this script is invoked.
[ "$DB" = "am2_staging" ] || { echo "REFUSING: not the staging database"; exit 1; }

if [ -f "$ENVF" ]; then
    echo "== kredensial sudah ada, dipakai ulang"
    . "$ENVF"
else
    CT_SUPER_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    CT_BRANCH_A_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    CT_BRANCH_B_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
    umask 077
    cat > "$ENVF" <<EOF
# Contract-test accounts. Staging only. Not in git.
CT_BASE_URL=https://staging-webadmin.am2-poc.com
CT_NODE_URL=http://127.0.0.1:5001
CT_SUPER_USER=ct_super
CT_SUPER_PASS=$CT_SUPER_PASS
CT_BRANCH_A_USER=ct_branch_a
CT_BRANCH_A_PASS=$CT_BRANCH_A_PASS
CT_BRANCH_B_USER=ct_branch_b
CT_BRANCH_B_PASS=$CT_BRANCH_B_PASS
EOF
    chmod 600 "$ENVF"
    . "$ENVF"
    echo "== kredensial baru ditulis ke $ENVF (mode 600)"
fi

# P must be exported into php's environment. Passing "P=..." as an argument
# instead leaves getenv('P') false, which silently hashes the empty string and
# makes every one of these accounts accept a blank password.
hash_pw() { P="$1" php -r 'echo password_hash(getenv("P"), PASSWORD_BCRYPT);'; }

H_SUPER=$(hash_pw "$CT_SUPER_PASS")
H_A=$(hash_pw "$CT_BRANCH_A_PASS")
H_B=$(hash_pw "$CT_BRANCH_B_PASS")

for h in "$H_SUPER" "$H_A" "$H_B"; do
    case "$h" in \$2y\$*) ;; *) echo "REFUSING: bad bcrypt hash"; exit 1;; esac
done
# Never let a blank password verify against what we are about to store.
H="$H_SUPER" php -r 'exit(password_verify("", getenv("H")) ? 1 : 0);' \
    || { echo "REFUSING: hash accepts an empty password"; exit 1; }

sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
BEGIN;

-- Admins ----------------------------------------------------------------
INSERT INTO public.admin (username, password_hash, role, status,
                          user_quota, channel_quota,
                          can_manage_maps, can_manage_p2p, can_manage_video)
VALUES ('ct_super',    '$H_SUPER', 'superadmin', 'active', 100, 100, true, true, true),
       ('ct_branch_a', '$H_A',     'admin',      'active',  50,  50, true, true, false),
       ('ct_branch_b', '$H_B',     'admin',      'active',  50,  50, true, true, false)
ON CONFLICT DO NOTHING;

UPDATE public.admin SET password_hash='$H_SUPER' WHERE username='ct_super';
UPDATE public.admin SET password_hash='$H_A'     WHERE username='ct_branch_a';
UPDATE public.admin SET password_hash='$H_B'     WHERE username='ct_branch_b';

-- Users, four under branch A and one under branch B ----------------------
--
-- One unit per test file that mutates one. Sharing a fixture between files is
-- how this suite has already produced two intermittent failures: the files run
-- in parallel, and the second writer wins whichever assertion the first was
-- making. The owners:
--
--   CT_A1  channel-access.test.mjs
--   CT_A2  session-order.test.mjs
--   CT_A3  panel-endpoints.test.mjs
--   CT_A4  activity-log.test.mjs
--   CT_B1  the other tenant, for isolation assertions
INSERT INTO public.users (id, name, role, status, admin_id, created_by, password, entity_type)
SELECT v.id, v.name, 'user', 'offline', a.id, a.id, '\$2y\$10\$notarealloginhashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', v.entity_type
FROM (VALUES ('CT_A1','CT USER A1','ct_branch_a','user'),
             ('CT_A2','CT USER A2','ct_branch_a','user'),
             ('CT_A3','CT USER A3','ct_branch_a','tracker'),
             ('CT_A4','CT USER A4','ct_branch_a','user'),
             ('CT_B1','CT USER B1','ct_branch_b','user')) AS v(id,name,owner,entity_type)
JOIN public.admin a ON a.username = v.owner
ON CONFLICT (id) DO UPDATE SET entity_type = EXCLUDED.entity_type;

INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode)
VALUES ('CT_A1', false, false, false, 'HALF DUPLEX'),
       ('CT_A3', false, false, false, 'HALF DUPLEX'),
       ('CT_A2', false, false, false, 'HALF DUPLEX'),
       ('CT_A4', false, false, false, 'HALF DUPLEX'),
       ('CT_B1', false, false, false, 'HALF DUPLEX')
ON CONFLICT (user_id) DO NOTHING;

-- A channel owned by branch A -------------------------------------------
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'ct_channel_a', 'CT CHANNEL A', 'public', a.id
FROM public.admin a WHERE a.username='ct_branch_a'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name='ct_channel_a');

-- A third channel, so the file that puts a unit on a channel and asserts it
-- is still there does not share one with the file that empties a channel's
-- roster to prove that emptying it works.
--
--   ct_channel_a   channel-access.test.mjs, settings-authz.test.mjs
--   ct_channel_a2  channel-access.test.mjs (somewhere to move a default to)
--   ct_channel_a3  panel-endpoints.test.mjs
--   ct_channel_b   the other tenant
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'ct_channel_a3', 'CT CHANNEL A3', 'public', a.id
FROM public.admin a WHERE a.username='ct_branch_a'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name='ct_channel_a3');

-- A second channel for the same tenant: the default-channel invariants need
-- somewhere to move the default to.
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'ct_channel_a2', 'CT CHANNEL A2', 'public', a.id
FROM public.admin a WHERE a.username='ct_branch_a'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name='ct_channel_a2');

-- And one belonging to the other tenant, to have something to be refused.
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'ct_channel_b', 'CT CHANNEL B', 'public', a.id
FROM public.admin a WHERE a.username='ct_branch_b'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name='ct_channel_b');

COMMIT;
SQL

echo "== fixture aktif =="
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT a.username||' role='||a.role||' users='||count(u.id)
   FROM public.admin a LEFT JOIN public.users u ON u.admin_id=a.id AND u.role='user'
   WHERE a.username LIKE 'ct\_%' GROUP BY a.username, a.role ORDER BY a.username;"
sudo -u postgres psql -d "$DB" -tAc \
  "SELECT 'channel '||name||' by admin '||created_by FROM public.channels WHERE name='ct_channel_a';"

echo
echo "== sanity: produksi TIDAK punya akun ini =="
sudo -u postgres psql -d am2 -tAc \
  "SELECT count(*)||' akun ct_* di produksi (harus 0)' FROM public.admin WHERE username LIKE 'ct\_%';"
