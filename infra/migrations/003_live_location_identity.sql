-- 003: describe what a LiveTrack point represents and when that point arrived.
--
-- users.updated_at is account/session activity as well as location activity: a
-- login or rename can move it without a new GPS sample.  Freshness must use a
-- timestamp which only the location writers touch.  Existing rows deliberately
-- remain NULL rather than presenting mixed historical timestamps as GPS time.
--
-- entity_type is assigned by an operator.  Inferring it from an id, device id,
-- name or GPS accuracy would turn a display guess into stored truth.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS entity_type varchar(16) NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'users_entity_type_check'
           AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_entity_type_check
            CHECK (entity_type IN ('user', 'tracker'));
    END IF;
END $$;

COMMENT ON COLUMN public.users.entity_type IS
    'Operator-assigned LiveTrack identity: user or tracker; never inferred from id/device/GPS.';
COMMENT ON COLUMN public.users.location_updated_at IS
    'Server receipt time of the latest accepted location sample; account/session updates must not touch it.';
