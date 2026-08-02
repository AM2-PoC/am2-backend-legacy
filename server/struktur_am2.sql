--
-- PostgreSQL database dump
--

\restrict 6ZYoNvKviZPg1OTQtobZeqUa58iZ9qgkakho71y5kGs0NOamq10Sut4XORGMY8R

-- Dumped from database version 14.22 (Ubuntu 14.22-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 14.22 (Ubuntu 14.22-0ubuntu0.22.04.1)

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
-- Name: user_status; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.user_status AS ENUM (
    'online',
    'offline'
);


ALTER TYPE public.user_status OWNER TO admin;

--
-- Name: log_admin_activity(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.log_admin_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v_id int; v_nm text;
BEGIN
 IF(TG_OP='DELETE')THEN v_id:=OLD.created_by;IF(v_id IS NULL AND TG_TABLE_NAME='users')THEN v_id:=OLD.admin_id;END IF;v_nm:=OLD.name;
 ELSE v_id:=NEW.created_by;IF(v_id IS NULL AND TG_TABLE_NAME='users')THEN v_id:=NEW.admin_id;END IF;v_nm:=NEW.name;
 END IF;
 IF(TG_OP='INSERT')THEN INSERT INTO public.admin_activity_logs(admin_id,aksi,tabel_target,data_id,keterangan)VALUES(v_id,'CREATE',TG_TABLE_NAME,NEW.id::text,'Tambah '||TG_TABLE_NAME||': '||COALESCE(v_nm,''));
 ELSIF(TG_OP='UPDATE')THEN IF(OLD.name<>NEW.name)THEN INSERT INTO public.admin_activity_logs(admin_id,aksi,tabel_target,data_id,keterangan)VALUES(v_id,'UPDATE',TG_TABLE_NAME,NEW.id::text,'Ubah '||OLD.name||' ke '||NEW.name);END IF;
 ELSIF(TG_OP='DELETE')THEN INSERT INTO public.admin_activity_logs(admin_id,aksi,tabel_target,data_id,keterangan)VALUES(v_id,'DELETE',TG_TABLE_NAME,OLD.id::text,'Hapus '||TG_TABLE_NAME||': '||COALESCE(v_nm,''));
 END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;


ALTER FUNCTION public.log_admin_activity() OWNER TO admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin; Type: TABLE; Schema: public; Owner: admin
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


ALTER TABLE public.admin OWNER TO admin;

--
-- Name: admin_activity_logs; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.admin_activity_logs (
    id integer NOT NULL,
    admin_id integer,
    aksi character varying(20),
    tabel_target character varying(50),
    data_id character varying(50),
    keterangan text,
    waktu timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.admin_activity_logs OWNER TO admin;

--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.admin_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.admin_activity_logs_id_seq OWNER TO admin;

--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.admin_activity_logs_id_seq OWNED BY public.admin_activity_logs.id;


--
-- Name: admin_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.admin_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.admin_id_seq OWNER TO admin;

--
-- Name: admin_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.admin_id_seq OWNED BY public.admin.id;


--
-- Name: admin_managed_channels; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.admin_managed_channels (
    admin_id integer NOT NULL,
    channel_id integer NOT NULL,
    assigned_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.admin_managed_channels OWNER TO admin;

--
-- Name: app_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_versions (
    version_code integer NOT NULL,
    version_name character varying(20) NOT NULL,
    force_update boolean DEFAULT false,
    release_notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.app_versions OWNER TO postgres;

--
-- Name: channel_members; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.channel_members (
    user_id character varying(50) NOT NULL,
    channel_id character varying(50) NOT NULL
);


ALTER TABLE public.channel_members OWNER TO admin;

--
-- Name: channels_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.channels_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.channels_id_seq OWNER TO admin;

--
-- Name: channels; Type: TABLE; Schema: public; Owner: admin
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


ALTER TABLE public.channels OWNER TO admin;

--
-- Name: ptt_logs; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.ptt_logs (
    id integer NOT NULL,
    user_id character varying(50) NOT NULL,
    channel_id integer,
    event_type character varying(20) NOT NULL,
    event_time timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.ptt_logs OWNER TO admin;

--
-- Name: ptt_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.ptt_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ptt_logs_id_seq OWNER TO admin;

--
-- Name: ptt_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.ptt_logs_id_seq OWNED BY public.ptt_logs.id;


--
-- Name: user_app_permissions; Type: TABLE; Schema: public; Owner: admin
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


ALTER TABLE public.user_app_permissions OWNER TO admin;

--
-- Name: user_channels; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_channels (
    user_id character varying(50) NOT NULL,
    channel_id integer NOT NULL,
    is_default boolean DEFAULT false,
    permission character varying(20) DEFAULT 'rxtx'::character varying,
    CONSTRAINT user_channels_permission_check CHECK (((permission)::text = ANY (ARRAY['RX'::text, 'TX'::text, 'FULL DUPLEX'::text, 'rxtx'::text])))
);


ALTER TABLE public.user_channels OWNER TO admin;

--
-- Name: users; Type: TABLE; Schema: public; Owner: admin
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
    is_speaking boolean DEFAULT false
);


ALTER TABLE public.users OWNER TO admin;

--
-- Name: admin id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin ALTER COLUMN id SET DEFAULT nextval('public.admin_id_seq'::regclass);


--
-- Name: admin_activity_logs id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.admin_activity_logs_id_seq'::regclass);


--
-- Name: ptt_logs id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.ptt_logs ALTER COLUMN id SET DEFAULT nextval('public.ptt_logs_id_seq'::regclass);


--
-- Name: admin_activity_logs admin_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_activity_logs
    ADD CONSTRAINT admin_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_managed_channels admin_managed_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT admin_managed_channels_pkey PRIMARY KEY (admin_id, channel_id);


--
-- Name: admin admin_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT admin_pkey PRIMARY KEY (id);


--
-- Name: admin admin_username_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin
    ADD CONSTRAINT admin_username_key UNIQUE (username);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (version_code);


--
-- Name: channel_members channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_pkey PRIMARY KEY (user_id, channel_id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: channels name_unique; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT name_unique UNIQUE (name);


--
-- Name: ptt_logs ptt_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT ptt_logs_pkey PRIMARY KEY (id);


--
-- Name: user_channels unique_user_channel; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT unique_user_channel UNIQUE (user_id, channel_id);


--
-- Name: user_app_permissions user_app_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_app_permissions
    ADD CONSTRAINT user_app_permissions_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_amc_admin_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_amc_admin_id ON public.admin_managed_channels USING btree (admin_id);


--
-- Name: idx_ptt_logs_event_time; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_ptt_logs_event_time ON public.ptt_logs USING btree (event_time);


--
-- Name: idx_users_admin_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX idx_users_admin_id ON public.users USING btree (admin_id);


--
-- Name: channels trg_channels_log; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_channels_log AFTER INSERT OR DELETE OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.log_admin_activity();


--
-- Name: users trg_users_log; Type: TRIGGER; Schema: public; Owner: admin
--

CREATE TRIGGER trg_users_log AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.log_admin_activity();


--
-- Name: admin_activity_logs admin_activity_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_activity_logs
    ADD CONSTRAINT admin_activity_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: admin_managed_channels fk_admin; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT fk_admin FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE CASCADE;


--
-- Name: admin_managed_channels fk_channel; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.admin_managed_channels
    ADD CONSTRAINT fk_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: user_channels fk_channel; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT fk_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channels fk_channel_created_by; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT fk_channel_created_by FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: users fk_created_by; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES public.admin(id) ON DELETE SET NULL;


--
-- Name: users fk_last_channel; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_last_channel FOREIGN KEY (last_channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: ptt_logs fk_logs_channel; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT fk_logs_channel FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: ptt_logs fk_logs_user; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.ptt_logs
    ADD CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_app_permissions fk_user; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_app_permissions
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_channels fk_user; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_channels
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users fk_user_admin; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_user_admin FOREIGN KEY (admin_id) REFERENCES public.admin(id) ON DELETE CASCADE;


--
-- Name: TABLE app_versions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.app_versions TO admin;


--
-- PostgreSQL database dump complete
--

\unrestrict 6ZYoNvKviZPg1OTQtobZeqUa58iZ9qgkakho71y5kGs0NOamq10Sut4XORGMY8R

