-- 004: let an admin deletion cascade through owned users without making the
-- users audit trigger refer to the admin row being removed.
--
-- public.users.admin_id is ON DELETE CASCADE. PostgreSQL deletes the admin row
-- before the cascade fires the users AFTER DELETE trigger, so OLD.admin_id no
-- longer satisfies admin_activity_logs_admin_id_fkey. Preserve the audit event,
-- but make its actor NULL when that actor no longer exists. The FK deliberately
-- already uses ON DELETE SET NULL, so this is the same historical representation
-- used for logs belonging to deleted admins.
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

    -- An ON DELETE CASCADE may already have removed the referenced admin before
    -- this AFTER DELETE trigger runs. Never let audit logging roll back the real
    -- delete because its actor is now historical.
    IF (v_admin IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.admin WHERE id = v_admin)) THEN
        v_admin := NULL;
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
