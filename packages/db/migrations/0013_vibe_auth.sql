-- Vibe Auth (single sign-on) — Phase 8 step 5.
--
-- auth_identities / auth_settings / auth_revocations are the three tables
-- @kisaesdevlab/vibe-auth ships in sql/auth_identities.sql, copied verbatim so
-- they stay in step with the package's query-backed stores. auth_sessions_oidc
-- is ours: staff sessions stay in Redis (identity-free), so the identity behind
-- an SSO login (issuer, subject, IdP session id, ID token) is parked here keyed
-- by the HMAC of the v1099_sid cookie value. Back-channel logout resolves rows
-- by oidc_sid / (issuer, subject) / user_id and ends every Redis session of
-- those users.

-- Vibe Auth client tables (Phase 3). Add to the product's migration set.
-- user_id is TEXT so it fits uuid and text primary keys alike; products may
-- add a FOREIGN KEY to their users table in their own migration.

CREATE TABLE IF NOT EXISTS auth_identities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email           TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_issuer_subject_uq UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

-- Settings → Authentication values (mode, issuer, wrapped client secret, role map...).
CREATE TABLE IF NOT EXISTS auth_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revocation list for stateless-JWT products (D16). Keys: "u:<user_id>" or "s:<sid>".
-- Tokens issued at or before revoked_at are rejected until revoked_until (max token lifetime).
CREATE TABLE IF NOT EXISTS auth_revocations (
  subject_key    TEXT PRIMARY KEY,
  revoked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_until  TIMESTAMPTZ NOT NULL
);
ALTER TABLE auth_revocations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS auth_revocations_until_idx ON auth_revocations (revoked_until);

-- Vibe 1099: identity behind an SSO-born staff session (see apps/api/src/lib/vibeAuth.ts).
CREATE TABLE IF NOT EXISTS auth_sessions_oidc (
  sid_hash    TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issuer      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  oidc_sid    TEXT,
  id_token    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_oidc_user_id_idx ON auth_sessions_oidc (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_oidc_issuer_subject_idx ON auth_sessions_oidc (issuer, subject);
CREATE INDEX IF NOT EXISTS auth_sessions_oidc_oidc_sid_idx ON auth_sessions_oidc (oidc_sid);
