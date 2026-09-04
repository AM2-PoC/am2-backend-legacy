-- Schema only. Generated from staging with `pg_dump --schema-only`,
-- which touches zero rows -- structure is not sensitive, the data behind
-- it is. See infra/docker/seed/02-seed.sql for what actually populates
-- this database: synthetic accounts, never a copy of anything real.
--
-- Regenerated: 2026-08-30T02:52:19Z

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'online',
    'offline'
);


--
-- Name: log_admin_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_admin_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash text NOT NULL,
    role character varying(20) DEFAULT 'admin'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    max_channels integer DEFAULT 5,
    status character varying(20) DEFAULT 'active'::character varying,
    user_quota integer DEFAULT 0,
    channel_quota integer DEFAULT 0,
    expired_at date,
    can_manage_p2p boolean DEFAULT false,
    can_manage_maps boolean DEFAULT false,
    can_manage_video boolean DEFAULT false
);


--
-- Name: admin_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_activity_logs (
    id integer NOT NULL,
    admin_id integer,
    aksi character varying(20),
    tabel_target character varying(50),
    data_id character varying(50),
    keterangan text,
    waktu timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    event_code character varying(48),
    event_params jsonb
);


--
-- Name: COLUMN admin_activity_logs.event_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admin_activity_logs.event_code IS 'What happened, as a catalog key: log.<code> in WebAdmin/lang/. NULL on rows written before migration 002 -- those still render from keterangan.';


--
-- Name: COLUMN admin_activity_logs.event_params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admin_activity_logs.event_params IS 'The values the sentence needs. A string value beginning with @ is itself a catalog key.';


--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_activity_logs_id_seq OWNED BY public.admin_activity_logs.id;


--
-- Name: admin_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_id_seq OWNED BY public.admin.id;


--
-- Name: admin_managed_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_managed_channels (
    admin_id integer NOT NULL,
    channel_id integer NOT NULL,
    assigned_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: app_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_versions (
    version_code integer NOT NULL,
    version_name character varying(20) NOT NULL,
    force_update boolean DEFAULT false,
    release_notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: channel_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_members (
    user_id character varying(50) NOT NULL,
    channel_id character varying(50) NOT NULL
);


--
-- Name: channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channels_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id integer DEFAULT nextval('public.channels_id_seq'::regclass) NOT NULL,
    name character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    category character varying(20) DEFAULT 'public'::character varying,
    created_by integer,
    no_timeout boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: device_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tokens (
    token_hash character(64) NOT NULL,
    user_id character varying(50) NOT NULL,
    device_id text,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_used_at timestamp without time zone
);


--
-- Name: ptt_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ptt_logs (
    id integer NOT NULL,
    user_id character varying(50) NOT NULL,
    channel_id integer,
    event_type character varying(20) NOT NULL,
    event_time timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: ptt_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ptt_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ptt_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ptt_logs_id_seq OWNED BY public.ptt_logs.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_app_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_app_permissions (
    user_id character varying(50) NOT NULL,
    enable_maps boolean DEFAULT true,
    enable_p2p boolean DEFAULT true,
    enable_ptt_video boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    duplex_mode character varying(20) DEFAULT 'HALF DUPLEX'::character varying,
    CONSTRAINT check_duplex_mode CHECK (((duplex_mode)::text = ANY (ARRAY['FULL DUPLEX'::text, 'HALF DUPLEX'::text])))
);


--
-- Name: user_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_channels (
    user_id character varying(50) NOT NULL,
    channel_id integer NOT NULL,
    is_default boolean DEFAULT false,
    permission character varying(20) DEFAULT 'rxtx'::character varying,
    CONSTRAINT user_channels_permission_check CHECK (((permission)::text = ANY (ARRAY['RX'::text, 'TX'::text, 'FULL DUPLEX'::text, 'rxtx'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'offline'::character varying,
    current_channel character varying(255) DEFAULT NULL::character varying,
    last_channel_id integer,
    latitude numeric(10,8),
    longitude numeric(11,8),
    address text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    admin_id integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    accuracy double precision DEFAULT 0,
    password text,
    role character varying(20) DEFAULT 'superadmin'::character varying,
    current_device_id text,
    force_logout boolean DEFAULT false,
    is_speaking boolean DEFAULT false,
    entity_type character varying(16) DEFAULT 'user'::character varying NOT NULL,
    location_updated_at timestamp with time zone,
    CONSTRAINT users_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['user'::character varying, 'tracker'::character varying])::text[])))
);


--
-- Name: COLUMN users.entity_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.entity_type IS 'Operator-assigned LiveTrack identity: user or tracker; never inferred from id/device/GPS.';


--
-- Name: COLUMN users.location_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.location_updated_at IS 'Server receipt time of the latest accepted location sample; account/session updates must not touch it.';


--
-- Name: admin id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin ALTER COLUMN id SET DEFAULT nextval('public.admin_id_seq'::regclass);


--
-- Name: admin_activity_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.admin_activity_logs_id_seq'::regclass);


--
-- Name: ptt_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ptt_logs ALTER COLUMN id SET DEFAULT nextval('public.ptt_logs_id_seq'::regclass);


--
-- Name: admin_activity_logs admin_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_activity_logs
    ADD CONSTRAINT admin_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_managed_channels admin_managed_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT admin_managed_channels_pkey PRIMARY KEY (admin_id, channel_id);


--
-- Name: admin admin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT admin_pkey PRIMARY KEY (id);


--
-- Name: admin admin_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT admin_username_key UNIQUE (username);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (version_code);


--
-- Name: channel_members channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_pkey PRIMARY KEY (user_id, channel_id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: channels name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT name_unique UNIQUE (name);


--
-- Name: ptt_logs ptt_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT ptt_logs_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: user_channels unique_user_channel; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT unique_user_channel UNIQUE (user_id, channel_id);


--
-- Name: user_app_permissions user_app_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_app_permissions
    ADD CONSTRAINT user_app_permissions_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_admin_activity_logs_waktu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_activity_logs_waktu ON public.admin_activity_logs USING btree (waktu DESC);


--
-- Name: idx_amc_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_amc_admin_id ON public.admin_managed_channels USING btree (admin_id);


--
-- Name: idx_device_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_tokens_user ON public.device_tokens USING btree (user_id);


--
-- Name: idx_ptt_logs_channel_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptt_logs_channel_time ON public.ptt_logs USING btree (channel_id, event_time);


--
-- Name: idx_ptt_logs_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptt_logs_event_time ON public.ptt_logs USING btree (event_time);


--
-- Name: idx_users_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_admin_id ON public.users USING btree (admin_id);


--
-- Name: channels trg_channels_log; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_channels_log AFTER INSERT OR DELETE OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.log_admin_activity();


--
-- Name: users trg_users_log; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_log AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.log_admin_activity();


--
-- Name: admin_activity_logs admin_activity_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_activity_logs
    ADD CONSTRAINT admin_activity_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: admin_managed_channels fk_admin; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT fk_admin FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE CASCADE;


--
-- Name: admin_managed_channels fk_channel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT fk_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: user_channels fk_channel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT fk_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channels fk_channel_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT fk_channel_created_by FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: users fk_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: users fk_last_channel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_last_channel FOREIGN KEY (last_channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: ptt_logs fk_logs_channel; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT fk_logs_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: ptt_logs fk_logs_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_app_permissions fk_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_app_permissions
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_channels fk_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users fk_user_admin; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_user_admin FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


