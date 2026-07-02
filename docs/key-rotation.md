# Master key rotation procedure

The install `MASTER_KEY` (32 bytes, base64; provisioned by the appliance secret store) derives
three purpose keys via HKDF-SHA256:

| purpose | info string | used for |
|---|---|---|
| KEK | `vibe1099:kek:v1` | wrapping per-record DEKs (TINs, JWKs, TOTP secrets, W-9 PDFs) |
| HMAC | `vibe1099:tin-hmac:v1` | `tin_hash` lookup index (ADR-002) |
| Token | `vibe1099:token:v1` | signing/hashing portal, invite, W-9, and reset tokens |

## Rotation steps

1. **Freeze writes**: `docker compose stop api worker`.
2. **Backup**: run a full `pg_dump` (see docs/backup-restore.md).
3. Run the rotation script with both keys:
   ```
   OLD_MASTER_KEY=... NEW_MASTER_KEY=... npx tsx scripts/rotate-master-key.ts
   ```
   The script re-encrypts, in one transaction per table:
   - `recipients.tin_encrypted` + recompute `recipients.tin_hash`
   - `payers.tin_encrypted`
   - `firms.iris_jwk_encrypted`, `users.totp_secret_encrypted`
   - `blobs` rows with `encrypted = true`
   - `w9_requests.submitted_data.tinEncrypted`
4. Update `MASTER_KEY` in the appliance secret store / `.env`.
5. `docker compose up -d api worker`.
6. **Consequences to expect:** all outstanding signed links (client invites, recipient portal,
   W-9 links, password resets) are invalidated because the token key changes. Reissue from the
   respective staff screens.

> The rotation script ships as part of the appliance console integration (Addendum A).
