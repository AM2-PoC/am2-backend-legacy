-- A credential the handset can hold, and the operator can lose.
--
-- The field app stores the operator's password so it can sign in again after
-- a restart. That password is the same one they use everywhere else in this
-- system, it works from any device, and it cannot be taken back: a lost
-- handset means changing it for the person, not for the phone.
--
-- A token is per device and revocable. Only its SHA-256 is kept here, so a
-- copy of this table is a copy of nothing usable -- the same reason a password
-- column holds a bcrypt hash rather than a password.
--
-- device_id is recorded rather than enforced. It is Settings.Secure.ANDROID_ID
-- on the handset, which changes when the signing key does, and refusing a
-- token because a build was re-signed would lock out exactly the units a
-- staging round is meant to reach.
CREATE TABLE IF NOT EXISTS public.device_tokens (
    token_hash   char(64) PRIMARY KEY,
    user_id      character varying(50) NOT NULL,
    device_id    text,
    issued_at    timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_used_at timestamp without time zone
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON public.device_tokens (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_tokens TO admin;
