-- SSO hardening: an SSO-created account must not bootstrap a local credential
-- from its mailbox (self-service password reset).
--
-- users.password_hash is NOT NULL and a just-in-time (JIT) user gets a random,
-- unmatchable argon2 hash, so nothing on the row says "this account never had a
-- usable local password". sso_only_since is that signal:
--   NULL      = the account has (or had) a local password  (every pre-existing row,
--               POST /auth/users, bootstrap/seed, the break-glass CLI)
--   timestamp = JIT-provisioned from a Vibe Auth identity at that time and never
--               given a local password since. Cleared when an ADMIN sets one
--               (POST /auth/users/:id/reset-password) or the break-glass CLI does.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_only_since TIMESTAMPTZ;

-- Backfill accounts JIT-provisioned before this column existed. audit_log is
-- append-only, so "provisioned by Vibe Auth and no password ever set since" is exact:
-- vibe.auth.user.provisioned / user.reset-password / password.reset.complete all
-- carry the user id as entity_id.
UPDATE users u
   SET sso_only_since = u.created_at
 WHERE u.sso_only_since IS NULL
   AND EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.action = 'vibe.auth.user.provisioned' AND a.entity_id = u.id::text)
   AND NOT EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.action IN ('user.reset-password', 'password.reset.complete') AND a.entity_id = u.id::text);
