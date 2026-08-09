-- Sample data for local development. Never a copy of anything real.
--
-- Every account and unit here is named demo_ or DEMO_ on purpose, so nothing
-- from this database can be mistaken for staging or production data in a
-- screenshot or a bug report. The password on both admin accounts is
-- "devpassword123" -- fine for a container nobody but your laptop can reach,
-- not fine anywhere this file is not the source of truth.

INSERT INTO public.admin
    (username, password_hash, role, status, user_quota, channel_quota,
     can_manage_maps, can_manage_p2p, can_manage_video)
VALUES
    ('demo_super',  '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke', 'superadmin', 'active', 999999, 999999, true, true, true),
    ('demo_branch', '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke', 'admin',      'active', 50,     10,     true, true, false)
ON CONFLICT (username) DO NOTHING;

-- channels.name has no unique constraint (only id is), so this follows the
-- WHERE NOT EXISTS pattern the app's own handlers use rather than an
-- ON CONFLICT that would fail with "no unique constraint matches".
INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'demo_ops', 'DEMO OPS', 'public', a.id
FROM public.admin a WHERE a.username = 'demo_branch'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name = 'demo_ops');

INSERT INTO public.channels (name, display_name, category, created_by)
SELECT 'demo_dispatch', 'DEMO DISPATCH', 'public', a.id
FROM public.admin a WHERE a.username = 'demo_branch'
  AND NOT EXISTS (SELECT 1 FROM public.channels WHERE name = 'demo_dispatch');

INSERT INTO public.users (id, name, password, role, status, admin_id, created_by)
SELECT v.id, v.name, '$2y$10$S1Ag0zstlwpHEZYKW5MpqOCjadTaXsZl/pkBMSGTiIrI5fqqQRLke', 'user', 'offline', a.id, a.id
FROM (VALUES ('DEMO_UNIT_1', 'DEMO UNIT 1'),
             ('DEMO_UNIT_2', 'DEMO UNIT 2'),
             ('DEMO_UNIT_3', 'DEMO UNIT 3')) AS v(id, name)
JOIN public.admin a ON a.username = 'demo_branch'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_app_permissions (user_id, enable_maps, enable_p2p, enable_ptt_video, duplex_mode)
VALUES ('DEMO_UNIT_1', true, true, true, 'FULL DUPLEX'),
       ('DEMO_UNIT_2', true, true, false, 'FULL DUPLEX'),
       ('DEMO_UNIT_3', false, false, false, 'HALF DUPLEX')
ON CONFLICT (user_id) DO NOTHING;

-- DEMO_UNIT_1 and DEMO_UNIT_2 can sign in: each has a default channel. Three
-- is deliberately left with none, the same way the panel's "no default
-- channel" chip has something real to show against a fresh database instead
-- of an empty state.
INSERT INTO public.user_channels (user_id, channel_id, is_default, permission)
SELECT 'DEMO_UNIT_1', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'demo_ops'
UNION ALL
SELECT 'DEMO_UNIT_2', c.id, true, 'FULL DUPLEX' FROM public.channels c WHERE c.name = 'demo_ops'
UNION ALL
SELECT 'DEMO_UNIT_2', c.id, false, 'RX' FROM public.channels c WHERE c.name = 'demo_dispatch'
ON CONFLICT (user_id, channel_id) DO NOTHING;

UPDATE public.users u SET last_channel_id = c.id
FROM public.channels c
WHERE c.name = 'demo_ops' AND u.id IN ('DEMO_UNIT_1', 'DEMO_UNIT_2');

-- So /api/check-update answers something other than 404 out of the box.
INSERT INTO public.app_versions (version_code, version_name, force_update, release_notes)
VALUES (1, '1.0.0-dev', false, 'Local development seed. Not a real release.')
ON CONFLICT (version_code) DO NOTHING;
