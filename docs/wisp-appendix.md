# WISP appendix — how Vibe 1099 maps to IRS Pub 4557 / Pub 5708 controls

For inclusion in the firm's Written Information Security Plan (FTC Safeguards Rule / GLBA).
Vibe 1099 is self-hosted: the firm remains the data controller; this appendix covers the
technical controls the appliance provides.

| Pub 4557 control area | Vibe 1099 implementation |
|---|---|
| Access control | Role-based staff accounts (admin/preparer/reviewer); argon2id password hashing; optional TOTP 2FA; session inactivity timeout (default 30 min, configurable); IP allowlist for the staff zone |
| Identify & authenticate users | Individual accounts (no shared logins seeded beyond demo); password resets via expiring single-use tokens; account deactivation preserves audit trail |
| Protect stored client data | TINs, IRIS private keys, TOTP secrets, and W-9 PDFs encrypted at rest (AES-256-GCM envelope, per-record DEKs, HKDF purpose keys); keyed HMAC lookup index prevents offline TIN enumeration; Postgres inside the appliance boundary |
| Protect data in transit | TLS at the appliance Caddy layer; public portals exposed only via Cloudflare Tunnel with path allowlists; staff zone LAN/Tailscale-only |
| Monitor & audit | Append-only audit log (DB-trigger enforced) of every mutation, TIN reveal, portal access, lockout, export; viewer + CSV export; structured logs with TIN redaction |
| Third-party disclosure (§7216/§6713) | Recipient portal is single-form scoped with identity challenge; client portal is payer+year scoped with masked vault echoes; no cross-client visibility |
| Data retention & disposal | Configurable retention (4-year minimum default); automated sweep of derived artifacts; encrypted vault export for offboarding; uninstall procedure documented |
| Incident indicators | 5-attempt lockouts alert staff by email and audit-log the event; transmission failures alert admins; queue failures visible in Settings → Queues |
| Backup & recovery | Nightly pg_dump into a Duplicati-target volume; documented restore + quarterly restore drill script; master key held in the appliance secret store's sealed backup |
| Employee training hooks | Pen-test checklist (docs/pen-test-checklist.md) and this appendix double as season-start review material |

**Residual risks the firm must own:** host OS patching, physical access to the appliance,
relay-account security (SMTP/SMS credentials), Cloudflare account hygiene, and secure storage of
the `MASTER_KEY` backup.
