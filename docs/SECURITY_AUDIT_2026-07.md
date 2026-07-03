# Vibe 1099 — Security & Compliance Audit

**Date:** 2026-07-03
**Scope:** Full monorepo (`apps/api`, `apps/worker`, `apps/web`, `packages/*`, `render/`, `docker-compose*`, `docs/`)
**Method:** Six parallel dimension auditors (crypto/key-mgmt, authz/trust-zones, PII leakage, audit/integrity, app-hardening, third-party/compliance); top findings independently re-verified against source.
**Regulatory frame:** IRC §7216/§6713, FTC Safeguards Rule (16 CFR 314), IRS Pub 4557/5708 (WISP), Pub 5718 (IRIS A2A), Pub 1179/§301.6109-4 (substitute forms / TIN truncation), AICPA ET §1.700 & SOC 2 CC6.

## Overall posture

The **core security architecture is sound and well-tested.** Verified-correct: AES-256-GCM envelope encryption (fresh 96-bit IV + auth tag per record, master key never persisted), HMAC-SHA256 `tin_hash` under an HKDF-separated key, scoped HMAC tokens with nonce + expiry + `timingSafeEqual`, argon2id password hashing with constant-time dummy-hash anti-enumeration, RFC-6238 TOTP with Redis replay guard, uniform firm-scoping on every staff query (no IDOR found), Drizzle-parameterized SQL throughout, Jinja2 autoescape with SSRF/XXE/path-traversal mitigations in the render sidecar, helmet CSP, no `localStorage` token storage, and an append-only `audit_log` enforced by a DB trigger.

The findings below are **gaps against that posture**, not a broken foundation. Three HIGH items are the priority: they directly contradict the product's own stated controls (the WISP appendix and the LOCKED "no TIN in URLs / encrypted at rest" rules).

---

## HIGH

### H1 — Filing artifacts with full plaintext TINs stored unencrypted at rest
*Corroborated by 3 independent auditors (crypto, PII, compliance).*
`putBlob` encrypts only when `encrypt: true` is passed (`packages/core/src/blobs.ts:31`); the **only** caller that does is the W-9 PDF (`apps/api/src/routes/w9.ts:432`). Every transmission artifact is written **without** it:
- `apps/api/src/services/iris.ts:185-191` — `iris_xml` (Pub 5718 XML: payer TIN + all recipient TINs/names/addresses/amounts)
- `apps/api/src/services/iris.ts:196-202` — `tax1099_payload` (JSON with plaintext `recipient.tin`)
- `apps/api/src/routes/mo.ts:203-209` — `mo_txt` (MO Pub 1220 file, full TINs)
- `apps/worker/src/jobs/iris.ts:148-154` — `iris_ack`
- `apps/worker/src/jobs/render.ts:175-181` — `batch_pdf` (full payer TIN/addresses/amounts)

A `pg_dump`, backup, disk image, or SQLi exposes every filed TIN in cleartext, nullifying the column-level envelope encryption. `docs/wisp-appendix.md:11` tells firms "TINs … encrypted at rest (AES-256-GCM envelope)" — this makes that WISP representation **materially inaccurate** (ET §1.700 / SOC 2 CC6.1 misstatement risk). `docs/backup-restore.md` uses plain `pg_dump`, so the plaintext flows into backups too.
**Regs:** FTC Safeguards 314.4(c)(3); Pub 4557; IRC §6713.
**Fix:** pass `encrypt: true` at those call sites (worker reads already round-trip through `getBlob`, which auto-decrypts); one-time migration to encrypt existing rows; correct the WISP wording; document that `pg_dump` output must itself be encrypted.

### H2 — Full plaintext TIN in a GET query string (staff vault lookup)
*Violates a LOCKED project rule.* `apps/api/src/routes/recipients.ts:103-110` reads `?tin=` from the query string; `apps/web/src/staff/Recipients.tsx:73` fires it automatically at 9 typed digits. The SSN/EIN lands verbatim in reverse-proxy access logs, browser history, and pino-http app logs (the `req.url` binding is not covered by the log redaction, which only scrubs `cookie`/`authorization` headers and TIN-shaped log args). The client-zone equivalent is correctly a POST body (`client-portal.ts:150-153`).
**Regs:** IRC §7216/§6713; FTC Safeguards 314.4(c); Pub 4557. Contradicts CLAUDE.md "plaintext TIN never in URLs."
**Fix:** convert `/lookup` to POST with a body (one-line route + one-line frontend change).

### H3 — §7216 disclosure to Tax1099.com / Zenwork has no operator acknowledgment or documentation
Selecting the Tax1099 provider ships full payee SSNs, names, addresses, and amounts to Zenwork with only a settings dropdown. There is **no** acknowledgment step, and the operator docs never state that recipient PII is transmitted (`apps/web/src/staff/Settings.tsx:289-312` says only "files on our behalf (no TCC)"; `docs/knowledge-base/filing-irs-and-tax1099.md`, `settings-and-admin.md` are silent). The `§7216` string appears only in a code comment (`packages/core/src/filing/provider.ts:8`). Related: `/iris/tin-match` (`apps/api/src/routes/iris.ts:132-151`) sends plaintext TIN+name to Zenwork for **any** firm with a saved key, with no provider check; and every W-9 request auto-fires `client.requestW9(...)` to Zenwork when the firm default is tax1099 (`apps/api/src/routes/w9.ts:101-111`), swallowed with `catch {}` and not recorded as an external disclosure in the audit entry.

The disclosure itself is likely **permissible without consent** under Treas. Reg. §301.7216-2(d) (auxiliary services for return preparation) — but the firm carries the oversight duty (Pub 4557 / FTC 314.4(f)) and needs the framing to cite. Shipping payee SSNs to a SaaS vendor with zero operator notice is the gap.
**Regs:** IRC §7216 / §301.7216-2(d); FTC Safeguards 314.4(f) service-provider oversight; Pub 4557.
**Fix:** one-time admin acknowledgment on selecting `tax1099` (naming the data elements and citing §301.7216-2(d)); document in KB + WISP appendix; audit-log first enablement; gate tin-match and auto-W-9 behind the same acknowledgment and scope them to tax1099-routed payers.

### H4 — Mock base URLs unconditionally override production endpoints (silent unfiled-return risk)
`apps/api/src/services/filing.ts:52-54` and `apps/worker/src/jobs/iris.ts:44-47,51` resolve the base URL as `env.*_MOCK_BASE_URL || (production ? PROD : SANDBOX)` — a mock URL wins **even in production**, with no `NODE_ENV` guard (`packages/core/src/env.ts:49,55`). The mock returns realistic `Accepted` acks that drive records to `accepted` (`apps/worker/src/mock-tax1099.ts:43-88`). A production appliance with `TAX1099_MOCK_BASE_URL` still set would show green "accepted" records that were **never filed with the IRS** — an invisible §6721 late-filing failure. The `TAX1099_*`/`EMAILIT_*` vars aren't in `.env.example`, so the risk is undocumented.
**Regs:** §6721; FTC Safeguards 314.4(c).
**Fix:** refuse to boot (or refuse production transmissions) when a mock URL is set and `NODE_ENV=production`; add the vars to `.env.example` with a warning; stamp the resolved base URL onto the `transmissions` row.

### H5 — Client-zone TIN lookup crosses the payer boundary (cross-client confirmation)
`apps/api/src/routes/client-portal.ts:150-172` → `lookupByTin(db, scope.firmId, ...)` (`packages/core/src/services/vault.ts:63-96`) scopes to **`firmId`, not `scope.payerId`**. The client zone is defined as scoped to `payer_id` + `tax_year` only. A magic-link client for payer A who enters any full 9-digit TIN receives the masked name, masked address, `w9Status`, and `recipientId` of a recipient associated only with payer B — cross-client taxpayer-data confirmation (attacker must supply the full TIN, and output is masked, which bounds impact).
**Regs:** IRC §7216 (disclosure of one client's data to another); FTC Safeguards 314.4(c)(1).
**Fix:** constrain the client `/lookup` to recipients linked to `scope.payerId`, or drop `recipientId` from the masked echo.

### H6 — Worker-side mutations are entirely unaudited
The design claim "**all** mutations go through audit middleware" is false. Zero `audit()` calls exist in `apps/worker` or the core job code, yet the workers perform the most consequential state changes: `transmitted`/`failed`/`accepted`/`rejected` transitions (`apps/worker/src/jobs/iris.ts`, `packages/core/src/iris/apply.ts:30-54`), delivery `sentAt`/`bouncedAt` (`delivery.ts:110-121`), and retention **blob deletion** (`housekeeping.ts:30-107`). None leave an `audit_log` row.
**Regs:** FTC Safeguards 314.4(c) monitoring/logging; Pub 4557 activity logging.
**Fix:** route worker mutations through the same `audit()` sink (actorType `system`), especially transmit/ack transitions and retention deletions.

### H7 — Two filing-correctness state bugs create uncorrectable returns (§6721/§6722)
Both verified against source:
- **Rejected records cannot be re-filed.** `applyAckToRecords` sets `status: 'rejected'` but never clears `transmissionId` (`packages/core/src/iris/apply.ts:30-46`); `composeTransmission` throws `E_CONFLICT` on any record with a non-null `transmissionId` (`apps/api/src/services/iris.ts:89-93`, and again at the `FOR UPDATE` claim). Editing rejected→draft doesn't clear it either. A rejected record is permanently unfileable without manual SQL.
- **Deleting a draft correction strands the original.** `createCorrection` immediately marks the original `corrected` (`apps/api/src/services/corrections.ts:224`), a terminal status with no outgoing transitions and `isCorrectable` = false. The form DELETE checks only `assertDeletableStatus` (draft/ready) with no correction-chain guard (`apps/api/src/routes/forms.ts:252-266`), so deleting the still-draft correction leaves the original terminally `corrected` and uncorrectable; for Type-2 it also breaks the linked-pair invariant.
**Regs:** §6721/§6722 (inability to timely file a correct return).
**Fix:** clear `transmissionId` when a record is rejected (or on rejected→draft edit); block deletion of a record that is part of an active correction chain, or roll the original back to `accepted` when its sole correction draft is deleted.

---

## MEDIUM

| # | Finding | Location | Reg |
|---|---------|----------|-----|
| M1 | Portal/W-9 bearer tokens in URL path/query → written to proxy + app logs (redaction covers headers, not `req.url`); recipient tokens live until Oct 15 of the following year | `recipient-portal.ts`, `w9.ts`, `middleware/auth.ts:102,138` | FTC 314.4(c) |
| M2 | Magic links + **raw** password-reset token persisted in Redis via BullMQ job payloads (`removeOnComplete: {count:1000}`, `removeOnFail: {count:5000}`) — harvestable from Redis/BullMQ dashboard | `deliveries.ts:111`, `auth.ts:130-138`, `queues.ts:24-28` | FTC 314.4(c) |
| M3 | `trust proxy` hop count (default 2) doesn't match topology → `X-Forwarded-For` spoofable → per-IP rate-limit/lockout bypass + forged audit-log IPs | `env.ts:61`, `app.ts:41` | FTC 314.4(c) |
| M4 | API container port published `8210:8210` to host, bypassing the nginx proxy and staff IP-allowlist framing (render is correctly `expose`-only) | `docker-compose.yml:78-79` | FTC 314.4(c) |
| M5 | TOTP can be disabled/re-enrolled with only a live session (no password/current-OTP re-verify, no dedicated audit) → 2FA downgrade from a hijacked session | `apps/api/src/routes/auth.ts:171-183` | FTC 314.4(c)(5) |
| M6 | Audit logging is fail-open + fire-and-forget post-response (`.catch(()=>{})`, `res.on('finish')`) — a DB error drops the row silently while the mutation commits | `apps/api/src/middleware/audit.ts:12-39` | Pub 4557 |
| M7 | `createCorrection` is not transactional (up to 2 inserts + original-update as separate statements) — a crash mid-way leaves a half-pair or forked chain | `corrections.ts:119-226` | Pub 4557 |
| M8 | `filed_snapshot` has no DB-level immutability trigger (app-convention only) and omits payer TIN/name — no as-filed record of payer identity | `0001_init.sql:181`, `iris.ts:244-254` | Pub 4557 / §6722 |
| M9 | Type-2 "linked pair" is not enforced at transmit — the zeroing record and new original can be filed separately | `corrections.ts:176-220`, `iris.ts:82` | Pub 5718 |
| M10 | No disposal path for the highest-PII artifacts — retention sweep deletes only `batch_pdf`/`report_pdf`/`export_zip`; `w9_pdf`, `form_pdf`, `iris_xml`, `tax1099_payload`, `mo_txt` retained forever | `housekeeping.ts:96-107` | FTC 314.4(c)(6) |
| M11 | Transmit retry after a lost response can double-file — terminal failure nulls `transmissionId`, records return to `queued`, recompose mints a **new** UTID (no idempotency key catches it) | `apps/worker/src/jobs/iris.ts:107-124` | §6721 |
| M12 | Post-compose de-queue + edit race — a de-queued record edited after its XML was frozen shows edited amounts as "accepted" while the IRS received the old ones (snapshot preserves truth) | `status.ts:26`, `forms.ts:207-250` | §6721 |
| M13 | Weak default Postgres password fallback `vibe1099` in prod compose (contrast MASTER_KEY, correctly `:?`-required); DB not host-published in prod, so blast radius is intra-network | `docker-compose.yml:11,54` | FTC 314.4(c) |
| M14 | Third-party service inventory absent from WISP appendix + KB — Zenwork (full SSNs), Emailit/SMTP (emails+links), TextLink/Twilio (phone numbers) not listed for the firm's 314.4(f) diligence | `docs/wisp-appendix.md:14`, `settings-and-admin.md:20` | FTC 314.4(f) |

---

## LOW / INFO

- **No absolute session lifetime** — rolling 30-min inactivity TTL only; a session touched at least every 30 min never expires (`middleware/auth.ts:31-34`). *(FTC 314.4(c)(5))*
- **Per-account login-lockout DoS** — 8 bad passwords lock an account 15 min, keyed on email not IP; a known admin email can be locked out repeatedly (`auth.ts:40`). Login-lockout message claims "Staff has been notified" but no alert is enqueued (only recipient-portal lockouts alert) — cosmetic.
- **Sandbox/ATS filings can masquerade as done** — no banner/confirm at the transmit action when environment is sandbox; sandbox acceptance still inserts paper-delivery rows (`apps/worker/src/jobs/iris.ts:174-191`). *(§6721 operational)*
- **No executable master-key rotation** — `docs/key-rotation.md` documents `scripts/rotate-master-key.ts`, which does not exist. On compromise there is no rotation path. *(FTC 314.4(c))*
- **Provider raw response bodies** (`raw.slice(0,1000)`) attach to `AppError.details`, surface to staff HTTP responses, and are written to `transmissions.errorDetails` + Redis `failedReason`; provider validation errors can echo TIN/name (staff-zone only). *(§6713 posture)*
- **Containers run as root** — no `USER` directive in any Dockerfile; widens impact of an RCE in WeasyPrint/lxml/pypdf (parse untrusted bytes). *(Pub 4557 least privilege)*
- **Filing endpoints not scheme-restricted** — `IRIS_*`/`TAX1099_*` bases are `z.string()` not https-constrained; SMTP adapter sets `secure` only (no `requireTLS`), default `SMTP_SECURE=0`; emailed portal links default to `http://localhost` until overridden. No `rejectUnauthorized:false` anywhere (verified clean). *(FTC 314.4(c))*
- **Append-only trigger gaps** — `BEFORE UPDATE OR DELETE` row trigger doesn't fire on `TRUNCATE`, and the app connects as table owner (can `DROP TRIGGER`); no separate migration role / `REVOKE`. *(FTC 314.4(c) tamper-resistance)*
- **Enabled-filing-years is UI-only** — server accepts any year 2020–2100; `PUT /admin/settings/filing_years` (`value: z.unknown()`) bypasses `addFilingYear` bounds; a fat-fingered year can create/transmit a wrong-year record. *(§6721)*
- **Concurrent ack-poll double-applies** — scheduled poll + manual re-poll with no lock → duplicate `deliveries` rows + double `mailRecipients` (duplicate USPS copies, Tax1099 billing). *(operational)*
- **`mark-delivered` has no state guard** (`batches.ts:276-288`) — a `building`/`failed` batch can jump to `delivered`, unlike `mark-printed`.
- **Migration 0003 omits CHECK constraints** on the new enum columns (`filing_provider`, `filing_provider_override`, `tax1099_environment`, `provider`) that 0001's convention has everywhere; defaults themselves are correct.
- **Substitute Copy B masks the payer TIN** (`renderSubstitutePdf` → `maskPayerTin:true`, `render.ts:142-151`) — Pub 1179 / §301.6109-4 permit truncating only the **recipient** TIN on payee statements; payer TIN must be full. The actually-furnished portal/Z-fold copies are correct. Privacy-conservative, not a leak.
- **TOTP code compared with `===`** (not constant-time); exploitability negligible given the 30-s window + lockout (`services/totp.ts:68`).
- **Cookie `Secure` depends on two config values** — a prod install with an `http` base URL silently drops `Secure` (`auth.ts:75-77`).
- **`.env` in the working tree holds a live MASTER_KEY** — verified **not** committed (`.gitignore` + `git ls-files` clean); dev-machine hygiene only.

---

## Positive assurance (verified sound, with evidence)

Cryptography: AES-256-GCM envelope with per-record random DEK + 96-bit IV + auth tag, master key HKDF-derived and never persisted, dual fail-fast validation (`crypto.ts`, `env.ts`, `tests/crypto.test.ts`). `tin_hash` = HMAC-SHA256 under an HKDF-separated key, domain-separated by firm+type (ADR-002). Scoped tokens carry scope+id+expiry+nonce, verified with `timingSafeEqual` + DB `token_hash` match + revocation. Argon2id (m=19456,t=2,p=1) with constant-time dummy-hash anti-enumeration; single-use hashed reset tokens that burn all sessions. RFC-6238 TOTP with Redis NX replay guard. No inbound JWT surface (no alg-confusion risk); IRIS OAuth assertion is RS256/ES256 with the firm's encrypted private JWK. Vendor API keys envelope-encrypted, returned only as `has*Key` booleans, never echoed.

Authorization: every staff query derives `firmId` from the session and pairs every by-id lookup with a firm predicate — no IDOR found across all routes. Blob access is mandatory firm-scoped. Client/recipient zones are token-scoped with layered verification; recipient PDF access additionally gated by a last-4 challenge bound to an HttpOnly `SameSite=strict` cookie with lockout + staff alert. Privilege changes destroy all sessions immediately.

Application: all SQL is Drizzle-parameterized (no injection surface). Render sidecar has Jinja2 autoescape + `StrictUndefined`, a template-name allowlist, an SSRF-blocking URL fetcher, and an XXE-hardened XSD parser; it is internal-only (`expose`) in prod. Helmet CSP (`default-src 'self'`, `frame-ancestors 'none'`), same-origin CORS, no `dangerouslySetInnerHTML`, no `localStorage` token storage, CSV formula-injection neutralized.

Integrity: `audit_log` append-only enforced by a DB trigger (zero UPDATE/DELETE against it anywhere in code); status machine exhaustively pairwise-tested; no status/`filedSnapshot`/`transmissionId` mass-assignment (zod whitelists); snapshot-on-transmit taken inside an advisory-locked `FOR UPDATE` transaction; correction diffs read the immutable snapshot, not live data; **money is integer cents everywhere** (no float/`parseFloat`/`toFixed` on amounts — ADR-001 verified clean); UTID uniqueness enforced by DB index. Audit before/after stored as SHA-256 hashes, never raw TINs.

PII: no whole-row serializers (masked DTOs throughout); BullMQ render/iris payloads carry IDs only (no TINs/amounts); emails/SMS carry name+link only (no TIN, no amounts, no attachments); staff grids show masked TINs; full-TIN reveal is POST-only, firm-scoped, and audited.

---

*Priority order for remediation: **H1, H2, H4** (each a small, localized change that closes a direct contradiction of a stated control), then **H3, H5, H6, H7**, then the MEDIUM table.*

---

## Remediation status (2026-07-03)

All HIGH and MEDIUM findings, and the localized LOW/INFO items, were fixed in this pass.
`pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm test` (78 passing), and the web build all pass.

| # | Fix |
|---|-----|
| H1 | `encrypt: true` on all TIN-bearing blob writes (iris_xml, tax1099_payload, mo_txt, iris_ack, batch_pdf, report_pdf); `scripts/backfill-encrypt-blobs.ts` for existing rows; WISP appendix corrected |
| H2 | Staff `/recipients/lookup` moved from GET query to POST body; web caller updated |
| H3 | §7216 disclosure acknowledgment column + Settings checkbox; all Zenwork calls gated in `loadTax1099Config` and worker `providerFor`; acceptance audited; KB + WISP document the disclosure and vendor inventory |
| H4 | Boot refuses mock base URLs + non-https vendor/base URLs in production (`env.ts` superRefine); mock vars added to `.env.example`; transmit made at-most-once |
| H5 | Client `/lookup` scoped to `scope.payerId` (new `opts.payerId` on `lookupByTin`) |
| H6 | Worker transmit/accepted/rejected/failed transitions and retention deletions now audited (system actor) |
| H7 | Rejected records clear `transmissionId` (re-fileable); deleting the last correction draft rolls the original back to `accepted`; dependent-record delete guard |
| M1–M14 | URL-token log redaction; delivery-queue payloads dropped on complete/fail; trust-proxy + API port no longer host-published; TOTP re-enroll requires password; audit fail-open now logs loudly; `createCorrection` transactional; payer identity in snapshot; Type-2 linked-pair transmit enforced; retention disposal extended to filing artifacts; concurrent-ack atomic claim; weak-Postgres-default boot guard; vendor inventory in WISP |
| LOW | Absolute session lifetime cap; https/TLS enforcement + SMTP `requireTLS`; non-root container users; migration-0004 CHECK constraints + audit_log TRUNCATE guard; `mark-delivered` state guard; constant-time TOTP compare; provider-error scrubbing in the error handler; `filing_years`/`data_retention_years` value validation |

Deferred (infra/ops, not code): running the app under a dedicated least-privilege DB role (vs. table owner) for full audit_log tamper-resistance; encrypting `pg_dump` output at the backup layer (the blobs inside are now encrypted regardless).
