-- The units the WebSocket protocol suite signs in as.
--
-- tests/protocol drives a real two-client exchange -- login, join, key the mic,
-- relay a frame, release -- and until now it could only run by hand against
-- staging, because these identities existed only there. So the one suite that
-- exercises the actual wire never ran in CI, and a protocol test that was broken
-- could reach main and sit there. That happened.
--
-- Kept apart from 02-seed.sql on purpose. That file is demo data for a human
-- looking at a local stack; this is machine fixture data with an exact shape the
-- tests depend on. Mixing them would make either one unsafe to edit.
--
-- The shape matters and is not arbitrary:
--
--   CT_A1, CT_A2  share ct_channel_a. Two units in one channel is the minimum
--                 for "the listener heard it".
--   CT_A3         is authenticated, same branch, but sits in ct_channel_a2.
--                 app_login refuses a user with no default channel, so without
--                 this there was no way to have a caller who is *outside* the
--                 channel under test -- and "the attacker received the audio"
--                 could not be told apart from "the attacker is a member".
--   CT_B1         belongs to a different branch entirely, which is what makes
--                 the cross-tenant refusals testable.
--
-- The password hash is the same "devpassword123" the demo units use. That is
-- fine here for the same reason it is fine there and for no other: this file is
-- the source of truth for a container nobody but CI and your laptop can reach.

INSERT INTO public.admin
    (username, password_hash, role, status, user_quota, channel_quota,
     can_manage_maps, can_manage_p2p, can_manage_video)
VALUES
    ('ct_branch_a', '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke', 'admin', 'active', 50, 10, true, true, true),
    ('ct_branch_b', '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke', 'admin', 'active', 50, 10, true, true, true)
ON CONFLICT (username) DO UPDATE
    SET can_manage_p2p = true, can_manage_video = true;

-- channels.name has no unique constraint, so this follows the WHERE NOT EXISTS
-- pattern the app's own handlers use.
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT v.slug, v.display, 'public', a.id
FROM (VALUES ('ct_channel_a',  'CT CHANNEL A',  'ct_branch_a'),
             ('ct_channel_a2', 'CT CHANNEL A2', 'ct_branch_a'),
             ('ct_channel_b',  'CT CHANNEL B',  'ct_branch_b')) AS v(slug, display, owner)
JOIN public.admin a ON a.username = v.owner
WHERE NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.name = v.slug);

INSERT INTO public.users (id, name, password, role, status, admin_id, created_by, entity_type)
SELECT v.id, v.name, '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke',
       'user', 'offline', a.id, a.id, 'user'
FROM (VALUES ('CT_A1', 'CT USER A1', 'ct_branch_a'),
             ('CT_A2', 'CT USER A2', 'ct_branch_a'),
             ('CT_A3', 'CT USER A3', 'ct_branch_a'),
             ('CT_B1', 'CT USER B1', 'ct_branch_b')) AS v(id, name, owner)
JOIN public.admin a ON a.username = v.owner
ON CONFLICT (id) DO UPDATE SET admin_id = EXCLUDED.admin_id;

-- Video capability is the conjunction of this switch and the owning branch's
-- can_manage_video above. Both are on, so a test that needs video can have it
-- and a test that needs it withdrawn can withdraw it.
INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode)
VALUES ('CT_A1', true, true, true, 'FULL DUPLEX'),
       ('CT_A2', true, true, true, 'FULL DUPLEX'),
       ('CT_A3', true, true, true, 'FULL DUPLEX'),
       ('CT_B1', true, true, true, 'FULL DUPLEX')
ON CONFLICT (user_id) DO UPDATE
    SET enable_p2p = true, enable_ptt_video = true, duplex_mode = 'FULL DUPLEX';

INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
SELECT 'CT_A1', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'ct_channel_a'
UNION ALL
SELECT 'CT_A2', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'ct_channel_a'
UNION ALL
SELECT 'CT_A3', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'ct_channel_a2'
UNION ALL
SELECT 'CT_B1', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'ct_channel_b'
ON CONFLICT (user_id, channel_id) DO UPDATE SET is_default = true, permission = 'FULL DUPLEX';

UPDATE public.users u SET last_channel_id = c.id
FROM public.channels c
WHERE (c.name = 'ct_channel_a'  AND u.id IN ('CT_A1', 'CT_A2'))
   OR (c.name = 'ct_channel_a2' AND u.id = 'CT_A3')
   OR (c.name = 'ct_channel_b'  AND u.id = 'CT_B1');
