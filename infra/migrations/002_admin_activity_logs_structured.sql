-- 002: give admin_activity_logs an event code and parameters.
--
-- Every row said what happened in one Indonesian sentence, built by string
-- concatenation at the moment it was written -- in PHP for most events, and in
-- a PL/pgSQL trigger for the rest. That sentence is the only record of the
-- event, so the Logs page can only ever be as bilingual as the database is,
-- which is not at all.
--
-- The code and its parameters are what actually happened; the sentence is one
-- rendering of it, and belongs at display time next to every other string the
-- panel translates.
--
-- Additive on purpose. The 5,464 rows already here keep their keterangan and
-- go on rendering from it, and they clear themselves within 30 days --
-- runCleanup() in server.js deletes anything older than that, so no backfill
-- is worth writing.
--
-- The Indonesian column names stay. aksi, tabel_target, keterangan and waktu
-- are read by api_logs.php, which feeds the Admin Native log screen; renaming
-- them is a mobile release, not a migration.

ALTER TABLE public.admin_activity_logs
    ADD COLUMN IF NOT EXISTS event_code   varchar(48),
    ADD COLUMN IF NOT EXISTS event_params jsonb;

COMMENT ON COLUMN public.admin_activity_logs.event_code IS
    'What happened, as a catalog key: log.<code> in WebAdmin/lang/. NULL on rows written before migration 002 -- those still render from keterangan.';
COMMENT ON COLUMN public.admin_activity_logs.event_params IS
    'The values the sentence needs. A string value beginning with @ is itself a catalog key.';

-- Both log pages read the newest hundred rows and nothing else. 5,464 rows is
-- small enough that the planner sorts them without complaint today; it will
-- not stay small, and the index costs nothing to add now.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_activity_logs_waktu
    ON public.admin_activity_logs (waktu DESC);

-- The trigger writes codes now.
--
-- It also stops writing a sentence at all: two renderings of one event drift
-- apart, and the PHP writers have already shown how -- "Update akses X ke: …"
-- in one file and the same event with " (via Mobile)" glued on the end in
-- another, which no reader can group and no translator can reach.
CREATE OR REPLACE FUNCTION public.log_admin_activity() RETURNS trigger AS $$
DECLARE
    v_admin int;
    v_name  text;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        v_admin := OLD.created_by;
        IF (v_admin IS NULL AND TG_TABLE_NAME = 'users') THEN v_admin := OLD.admin_id; END IF;
        v_name := OLD.name;
    ELSE
        v_admin := NEW.created_by;
        IF (v_admin IS NULL AND TG_TABLE_NAME = 'users') THEN v_admin := NEW.admin_id; END IF;
        v_name := NEW.name;
    END IF;

    IF (TG_OP = 'INSERT') THEN
        INSERT INTO public.admin_activity_logs
            (admin_id, aksi, tabel_target, data_id, event_code, event_params)
        VALUES (v_admin, 'CREATE', TG_TABLE_NAME, NEW.id::text, 'row.create',
                jsonb_build_object('table', '@log.tbl_' || TG_TABLE_NAME,
                                   'name', COALESCE(v_name, ''),
                                   'id', NEW.id::text));

    ELSIF (TG_OP = 'UPDATE') THEN
        IF (OLD.name IS DISTINCT FROM NEW.name) THEN
            INSERT INTO public.admin_activity_logs
                (admin_id, aksi, tabel_target, data_id, event_code, event_params)
            VALUES (v_admin, 'UPDATE', TG_TABLE_NAME, NEW.id::text, 'row.rename',
                    jsonb_build_object('table', '@log.tbl_' || TG_TABLE_NAME,
                                       'from', COALESCE(OLD.name, ''),
                                       'to', COALESCE(NEW.name, ''),
                                       'id', NEW.id::text));
        END IF;

    ELSIF (TG_OP = 'DELETE') THEN
        INSERT INTO public.admin_activity_logs
            (admin_id, aksi, tabel_target, data_id, event_code, event_params)
        VALUES (v_admin, 'DELETE', TG_TABLE_NAME, OLD.id::text, 'row.delete',
                jsonb_build_object('table', '@log.tbl_' || TG_TABLE_NAME,
                                   'name', COALESCE(v_name, ''),
                                   'id', OLD.id::text));
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- OLD.name <> NEW.name was the previous comparison, and it is false when
-- either side is NULL: renaming a row that had no name recorded nothing at
-- all. IS DISTINCT FROM above is the fix.
