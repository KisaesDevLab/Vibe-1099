# VIBE 1099 — AUTONOMOUS BUILD PLAN

**Product:** Vibe 1099 — self-hosted 1099 preparation, recipient delivery, and IRS IRIS A2A e-filing appliance for CPA firms
**Owner:** KisaesDevLab / Kisaes LLC
**License:** PolyForm Internal Use 1.0.0; commercial license required for client-portal access (MyBooks model, three tiers)
**Stack:** React 18, TypeScript, Node.js 24, Express, Drizzle ORM, PostgreSQL 16, Redis 7, BullMQ, pnpm workspaces
**PDF render:** WeasyPrint sidecar container (Jinja2 templates + external CSS — reuse Vibe T&B invoice template pattern)
**Deployment:** Docker Compose appliance; Vibe Appliance manifest integration (Addendum A)
**Compliance frame:** IRC §7216/§6713, FTC Safeguards/GLBA, IRS Pub 4557/5708 (WISP), Pub 1179 (substitute forms), Pub 5718 (IRIS A2A), Pub 1220 (MO state file)

---

## LOCKED DECISIONS (from Q&A)

| # | Decision |
|---|----------|
| 1 | Standalone Docker appliance (not a T&B module) |
| 2 | Form scope v1: 1099-NEC, 1099-MISC, 1099-INT, 1099-DIV |
| 3 | Master recipient/TIN vault lives in this app only (no cross-app federation in v1) |
| 4 | Per-firm IRIS TCC: firm enters TCC + API Client ID + JWK in Settings; firm is the Transmitter |
| 5 | Standalone auth: firm staff accounts + magic-link client invitations (no T&B credential reuse) |
| 6 | Delivery policy (b): ALWAYS mail paper Copy B via pressure-seal; portal link is a courtesy copy. No Pub 1179 §4.6 consent machinery in v1. |
| 7 | Pressure-seal: 8.5×11 Z-fold, fully blank 28# stock — app prints form AND backer instructions, duplex |
| 8 | SMS: provider-agnostic adapter; ship TextLink and Twilio drivers |
| 9 | W-9 request/collection workflow in v1 |
| 10 | TIN verification: internal vault lookup + IRIS real-time validation only (no e-Services TIN Matching) |
| 11 | State: Missouri direct file (Pub 1220 .txt) only; CF/SF election flagged in IRIS submission for participating states (AR benefits automatically); state config table stubbed for expansion |
| 12 | Full corrections lifecycle in v1 (one-transaction and two-transaction) |
| 13 | Node 24 / PostgreSQL 16; PolyForm Internal Use + commercial tiers |

---

## ARCHITECTURE OVERVIEW

Containers:
1. `vibe1099-web` — React SPA (staff app + client entry portal + recipient portal, route-separated)
2. `vibe1099-api` — Express API, Drizzle, BullMQ producers
3. `vibe1099-worker` — BullMQ consumers (IRIS transmit/poll, PDF batch render, delivery send, W-9 processing)
4. `vibe1099-render` — WeasyPrint sidecar (HTTP: template + JSON → PDF)
5. `postgres:16`, `redis:7`
6. Caddy handled at appliance level (Addendum A)

Trust zones:
- **Staff zone** — session auth, full data
- **Client zone** — magic-link scoped to engagement (payer + tax year); client sees only their payer's recipients/amounts
- **Recipient zone** — HMAC-signed expiring token + last-4 TIN challenge; sees only their own form PDF (T&B third-party-share pattern: signed URL semantics, single-resource scope, expiry, revocation)

Money storage: **integer cents** everywhere in this app. (Deviation from suite whole-dollar convention — required because MO Pub 1220 money fields carry cents with assumed decimal, and IRIS XML carries decimals. Document in ADR-001.)

TIN storage: AES-256-GCM at rest (per-install master key, envelope pattern from Vibe Connect MFK work). Plaintext TIN never logged, never in URLs, truncated (XXX-XX-1234 / XX-XXX1234) on all payee-facing output.

---

## DATA MODEL (Drizzle schema targets)

- `firms` (single row typical; multi-firm capable) — name, EIN, address, IRIS TCC, API Client ID, JWK (encrypted), environment (ATS|PROD)
- `users` — staff auth (argon2id), roles: admin, preparer, reviewer
- `payers` — firm's clients issuing 1099s: legal name, DBA, EIN/SSN (encrypted), address, phone, MO withholding ID (nullable), contact email/mobile
- `client_invites` — magic-link tokens per payer + tax year, expiry, revocation
- `recipients` — master vault: TIN (encrypted) + TIN type (SSN|EIN), name1/name2, address, email, mobile, w9_status, created_from (staff|client|w9), UNIQUE(firm_id, tin_hash) where tin_hash = HMAC-SHA256(TIN, install key) for lookup without decryption
- `recipient_address_history` — versioned name/address changes with source + timestamp
- `form_records` — payer_id, recipient_id, tax_year, form_type (NEC|MISC|INT|DIV), box values (jsonb, cents), state fields, status: draft → ready → queued → transmitted → accepted | rejected → corrected(n)
- `transmissions` — IRIS submission batches: xml blob ref, UTID, Receipt ID, status, ack payload (jsonb), error details
- `state_files` — MO Pub 1220 batches: file blob ref, tax_year, payer scope, K-record totals, status
- `deliveries` — form_record_id, channel (paper|email|sms), token, sent_at, viewed_at, paper_batch_id
- `paper_batches` — imposition PDF ref, page count, printed_at
- `w9_requests` — recipient link token, status (sent|opened|completed|expired), completed W-9 PDF ref, esign metadata (IP, timestamp, typed/drawn signature)
- `audit_log` — append-only, actor, action, entity, before/after hash

---

## PHASES

### Phase 1 — Scaffold & Appliance Base (18 items)
- [ ] pnpm workspace: `apps/web`, `apps/api`, `apps/worker`, `packages/shared` (zod schemas, form-type registry), `packages/db`
- [ ] Docker Compose: web, api, worker, render, postgres, redis; healthchecks; named volumes
- [ ] Env schema validation (zod) with fail-fast boot
- [ ] Drizzle config + migration runner on boot
- [ ] Redis + BullMQ wiring, queue dashboard (staff-only route)
- [ ] WeasyPrint sidecar: Flask/FastAPI micro-endpoint `POST /render` (template name + JSON → PDF bytes); Jinja2 env; external CSS convention from T&B invoices
- [ ] Structured logging (pino), request IDs, PII redaction rule: never log TIN, box values at debug only
- [ ] Backup hooks: pg_dump cron target + volume layout compatible with Duplicati (Vibe-Linux-Setup convention)
- [ ] ADR-001: integer-cents storage (deviation from whole-dollar suite convention, rationale: Pub 1220 + IRIS decimals)
- [ ] ADR-002: tin_hash HMAC index for encrypted-TIN lookup
- [ ] Seed script: demo firm, 2 payers, 12 recipients, sample NEC/MISC/INT/DIV records
- [ ] CI: typecheck, lint, unit tests, docker build
- [ ] `CLAUDE.md`, `PHASES.md`, `STATE.md`, `QUESTIONS.md` (autonomous-build kit pattern)
- [ ] License headers: PolyForm Internal Use 1.0.0; commercial-feature gate flag scaffold
- [ ] Port assignment: API 8210, web 8211, render 8212 (register in suite port table)
- [ ] Version/about endpoint
- [ ] Error taxonomy (app error codes) shared package
- [ ] README with appliance install stub (superseded by Addendum A)

### Phase 2 — Auth & Tenancy (14 items)
- [ ] Staff auth: argon2id, session cookies, CSRF, optional TOTP
- [ ] Roles: admin (settings, TCC, users), preparer (data entry, queue), reviewer (approve/transmit)
- [ ] Magic-link client invites: token per (payer, tax_year), configurable expiry (default 30 days), revoke + reissue
- [ ] Client session: scoped JWT — payer_id + tax_year claims only
- [ ] Recipient tokens: HMAC-signed URL (T&B third-party-share pattern), 90-day default expiry, per-form scope, revocation list
- [ ] Recipient identity challenge: last-4 of TIN, 5-attempt lockout, lockout alert to staff
- [ ] Rate limiting on all public endpoints (portal, W-9, recipient)
- [ ] Audit log middleware (all mutations)
- [ ] Password reset flow (staff)
- [ ] Session inactivity timeout (Safeguards Rule alignment)
- [ ] IP allowlist option for staff zone (config)
- [ ] Security headers (helmet), strict CSP for portal routes
- [ ] Login/audit views in staff UI
- [ ] Pen-test checklist doc for public routes

### Phase 3 — Recipient Vault & TIN Intelligence (16 items)
- [ ] AES-256-GCM encryption service (envelope: install master key → per-record DEK), key rotation procedure doc
- [ ] tin_hash generation + unique index (firm scope)
- [ ] Recipient CRUD (staff) with TIN masked display, reveal-on-click with audit entry
- [ ] TIN format validation: SSN vs EIN heuristics, ITIN detection, obviously-invalid rejection (000-, 666-, 9xx SSN rules)
- [ ] **Lookup-as-you-type**: TIN entry → hash → vault match → return most current name + address + last-used payer/year → "Confirm / Update" diff UI
- [ ] Address history versioning: every change appends `recipient_address_history` with source
- [ ] Name-change handling: prompt "name changed since last year — use new name on this form?" (uses current by default)
- [ ] Merge tool: duplicate recipients (same human, TIN typo history) with form_record re-pointing
- [ ] CSV import: recipients (staff), column mapper, dedupe-by-TIN preview
- [ ] Prior-year rollforward: clone recipient set from payer's prior year into new-year draft grid (amounts blank)
- [ ] W-9 status field: none | requested | on_file | stale (>3 yrs configurable)
- [ ] Backup-withholding flag on recipient (drives box 4 prompts)
- [ ] Recipient list views: by payer, by year, missing-TIN, missing-address filters
- [ ] Export (staff only): encrypted zip
- [ ] Vault stats widget (dashboard)
- [ ] Unit tests: hash lookup, encryption round-trip, dedupe

### Phase 4 — Form Engine (NEC / MISC / INT / DIV) (20 items)
- [ ] Form-type registry (`packages/shared`): per-form, per-tax-year box definitions — id, label, cents|checkbox|code, IRIS XML element, MO Pub 1220 amount-field position, Copy B template slot
- [ ] Tax-year dimension: registry keyed by (form_type, tax_year); TY2026 definitions seeded; TY2025 for prior-year/corrections
- [ ] 1099-NEC: box 1, box 2 (direct sales checkbox), box 4, state boxes 5–7
- [ ] 1099-MISC: boxes 1–15 incl. box 7 checkbox, gross proceeds to attorney (10), state boxes
- [ ] 1099-INT: boxes 1–17 incl. FATCA checkbox, state boxes
- [ ] 1099-DIV: boxes 1a–16 incl. 199A (5), FATCA, state boxes
- [ ] Validation layer (zod per form/year): required combos, negative-amount rules, box interdependencies (e.g., NEC box 4 requires backup-withholding context), threshold warnings (sub-$2,500 NEC federal-threshold note — warn, don't block; TY2026 OBBBA threshold from registry)
- [ ] Second-TIN-notice flag support
- [ ] Account-number field auto-generation (required when multiple forms same payer/recipient/type)
- [ ] Status machine: draft → ready → queued → transmitted → accepted | rejected → corrected(n); guarded transitions; reviewer-gate config (require reviewer approval before queue)
- [ ] Staff grid entry: payer → form type → recipient rows with amount columns; keyboard-first (tab/enter navigation, ten-key friendly)
- [ ] Inline recipient add from grid (invokes Phase 3 lookup)
- [ ] Bulk CSV import of form data with validation report
- [ ] Duplicate detection: same payer/recipient/type/year warning
- [ ] Payer-level summary: count + totals by form type (1096-equivalent view, screen only)
- [ ] Void/delete rules: deletable only in draft/ready; transmitted requires correction path
- [ ] Multi-year support: work TY(n) and TY(n-1) concurrently
- [ ] Snapshot on transmit: immutable copy of record as-filed (corrections diff against this)
- [ ] Form-level notes field (internal)
- [ ] Unit tests: every validation rule, status transitions

### Phase 5 — Client Entry Portal (15 items)
- [ ] Invite flow: staff selects payer + tax_year + form types allowed → generates magic link → send via email/SMS (Phase 8 adapters)
- [ ] Client landing: payer name confirmation, plain-language instructions, engagement scope
- [ ] Form-type picker (only staff-enabled types shown; e.g., "NEC")
- [ ] Contractor grid: prior-year recipients pre-listed, amount field per row, add-contractor row
- [ ] Client-side TIN entry → vault lookup → confirm/update flow (client sees masked match: "We have JOHN D— at 123 M— St — is this current?" — no full TIN echo to client)
- [ ] New-recipient form: name, address, TIN, email, mobile — with "don't have their TIN? request a W-9" button (Phase 7)
- [ ] Client save-and-return (draft persistence per token)
- [ ] Client submit → records land as `draft` flagged `client_submitted`, staff review queue
- [ ] Staff review screen: diff client entries vs vault, accept/adjust, promote to ready
- [ ] Client cannot see other payers, other years, staff data — enforced at query layer + tests
- [ ] Mobile-responsive grid (many clients will do this on a phone)
- [ ] Progress indicator + confirmation screen with summary totals
- [ ] Client activity events → audit log + staff notification
- [ ] Re-open flow: staff can unlock a submitted engagement for client edits
- [ ] E2E tests: full client journey

### Phase 6 — Substitute Form Rendering & Pressure-Seal Output (17 items)
- [ ] Pub 1179-compliant Copy B templates per form type (Jinja2 + CSS in render sidecar): required box layout, payer/recipient blocks, "This is important tax information..." legend, instructions content
- [ ] TIN truncation on ALL payee output (XXX-XX-1234 / XX-XXX1234); payer TIN shown in full per rules
- [ ] Copy 2 (state filing copy) variant when state withholding present
- [ ] Portal PDF: 8.5×11 portrait, Copy B + instructions page(s)
- [ ] **Z-fold imposition (8.5×11, blank stock, duplex):** panel geometry at 3.667" folds — FRONT: top panel = mailer face (payer return block, recipient address positioned for Z-fold display, USPS automation clearances, "Important Tax Return Document Enclosed" legend); middle/bottom panels = form content or blank per layout spec; BACK: recipient instructions printed by app (blank-stock decision)
- [ ] Imposition config: adjustable panel offsets (±1/16") in settings to calibrate to firm's sealer
- [ ] Batch builder: select payer(s)/form type/year → single print-ready PDF, one sheet per form, deterministic order (payer → recipient name), batch manifest page
- [ ] Duplex correctness: front/back page pairing verified in PDF structure tests
- [ ] Test-pattern sheet: alignment calibration page (fold lines, address window box) printable from settings
- [ ] Reprint: single form or subset from a batch
- [ ] Mask option: suppress recipient email/phone from printed output
- [ ] Paper batch lifecycle: built → printed (staff confirms) → delivered mark; feeds `deliveries` channel=paper
- [ ] Multi-form recipient handling: one sheet per form (v1; combined statement deferred)
- [ ] Render performance: 500-form batch under 60s target; BullMQ chunked render jobs
- [ ] Golden-file PDF tests: visual regression on templates per form type
- [ ] Font embedding + print-safe CSS (no external assets)
- [ ] Sample output pack for firm QA (all four form types, dummy data)

### Phase 7 — W-9 Request & Collection (12 items)
- [ ] W-9 request from staff or client portal: recipient email/mobile → tokenized link
- [ ] Recipient W-9 form (current revision fields): name, business name, federal tax classification, exemptions, address, TIN with confirm-entry, certification text verbatim
- [ ] E-signature: typed or drawn, ESIGN/UETA consent checkbox, capture IP + UTC timestamp + user agent
- [ ] Completed W-9 → PDF render (sidecar) → stored encrypted; recipient vault upsert (TIN, name, address) with source=w9
- [ ] TIN mismatch handling: if vault already has different TIN for matched name, flag for staff review (never silent overwrite)
- [ ] Request lifecycle: sent → opened → completed → expired; reminders (configurable schedule) via email/SMS
- [ ] Staff W-9 dashboard: outstanding requests, aging, resend
- [ ] Client-visible W-9 status per contractor ("W-9 requested 1/12, not yet returned")
- [ ] Stale-W-9 detection + bulk re-request tool
- [ ] W-9 PDF retrieval with audit entry
- [ ] Backup-withholding prompt when recipient fails to return W-9 by cutoff (informational)
- [ ] E2E test: request → complete → vault update → form entry uses new data

### Phase 8 — Delivery: Email, SMS, Recipient Portal (14 items)
- [ ] Email adapter: SMTP config (firm's relay), templated messages, DKIM guidance doc
- [ ] SMS adapter interface + drivers: **TextLink**, **Twilio** (config-selected); E.164 normalization; opt-out handling (STOP)
- [ ] Message templates: 1099-available notification, W-9 request, client invite; editable in settings with variable placeholders
- [ ] Recipient portal: token link → last-4 TIN challenge → view/download Copy B PDF
- [ ] Portal availability: forms remain accessible through Oct 15 of following year (config), then token auto-expiry
- [ ] Courtesy-copy framing in UI/messages ("Your paper copy has been mailed; you may also download here") — policy (b), no consent capture
- [ ] Delivery composer: after batch accepted/printed, bulk-send portal links to recipients with email/mobile on file
- [ ] Per-recipient channel resolution: email preferred, SMS fallback, none → paper-only badge
- [ ] Delivery tracking: sent, bounced (SMTP), viewed (portal hit), downloaded
- [ ] Resend + regenerate-token (invalidates old)
- [ ] Corrected-form re-delivery: new token, "CORRECTED" banner in message + PDF
- [ ] Link hygiene: no TIN, no name in URL; short token IDs
- [ ] Abuse controls: token brute-force lockout, per-IP throttle
- [ ] E2E: email + SMS + portal happy path and lockout path

### Phase 9 — IRIS A2A Transmission (22 items)
- [ ] Settings: TCC, API Client ID, JWK upload/generate (encrypted at rest), environment toggle ATS | Production; per-firm
- [ ] JWK tooling: generate keypair in-app, export public JWK for IRS enrollment, rotation procedure
- [ ] OAuth token flow per Pub 5718 (JWT assertion signed with firm key → bearer token), token cache + refresh
- [ ] IRIS XML generator per current-year XSD: transmission manifest, submission, form records (NEC/MISC/INT/DIV) from registry mapping
- [ ] XSD validation pass before transmit (bundle current schemas; schema-version pin per tax year)
- [ ] CF/SF election in submission for participating states (registry-driven; AR code 05 benefit documented)
- [ ] Batch composer: queue `ready` records → submissions respecting IRIS size limits (100MB / record caps), UTID generation + persistence
- [ ] Transmit worker: POST intake, capture Receipt ID, persist raw response
- [ ] Ack polling worker: status retrieval by Receipt ID/UTID, exponential backoff, terminal-state handling
- [ ] Ack parsing: accepted / accepted-with-errors / rejected; per-record error extraction to form_record level
- [ ] Error translation table: IRIS error codes → plain-English fixes (living table, admin-editable — codes are under-documented)
- [ ] Partial-acceptance handling: accepted records lock; rejected records → `rejected` with errors, edit → requeue
- [ ] Real-time TIN/name validation errors surfaced prominently (primary TIN-check mechanism per decision #10)
- [ ] Duplicate-submission guard: UTID idempotency, prevent double-transmit of same record set
- [ ] ATS mode: canned test scenario support, clearly-marked test banner, ATS checklist doc for firm onboarding
- [ ] Transmission log UI: batches, Receipt IDs, statuses, raw XML/ack download (admin)
- [ ] Receipt ID retention policy + display (IRS support requires UTID/Receipt ID)
- [ ] Deadline dashboard: recipient-furnish (Jan 31), IRS e-file (Mar 31), MO (last day Feb) with countdown + unfiled counts
- [ ] Extension helper: Form 8809 guidance page (info only, filed via IRIS; NEC has no automatic extension — flag)
- [ ] Retry/backoff + circuit breaker on IRS endpoint failures; queue durability across restarts
- [ ] Alerting: transmission failures → staff email
- [ ] Integration test harness: mock IRIS server with recorded ATS-style responses

### Phase 10 — Missouri Direct File (Pub 1220) (13 items)
- [ ] Pub 1220 writer: fixed 750-char records, CR/LF, uppercase ASCII, .txt output
- [ ] Record sequence: T → A (per payer/form type) → B (payees) → C (totals) → K (Missouri state totals / reconciliation) → F
- [ ] **Cents in money fields** (assumed decimal, no rounding) — direct from integer-cents storage
- [ ] MO-source scoping: payer/record flag for MO-source payments; $1,200 threshold filter with override
- [ ] MO withholding fields: state income tax withheld, MO withholding ID on A/B records; K-record reconciliation totals
- [ ] File builder UI: tax year → payer scope → preview counts/totals → generate .txt download
- [ ] Filename + encoding per MO handbook; file manifest stored in `state_files`
- [ ] Validation: record length assertions, field position tests against handbook layout, golden-file fixtures
- [ ] MO status tracking: generated → uploaded (staff confirms manual upload to MO Online Submission System) → accepted/rejected (manual mark) with notes
- [ ] Whole-file rejection guidance: MO rejects entire file — regenerate flow after fixes
- [ ] MO correction constraints documented in-app: withholding-amount errors = amended MO-941 + paper (out-of-band checklist); non-withholding = request DOR delete + resubmit full file
- [ ] State config table stub: state, participates_cfsf, direct_required, threshold, format, portal URL (MO row live; schema ready for expansion)
- [ ] MOFTP system-to-system: deferred — Addendum B placeholder

### Phase 11 — Corrections Lifecycle (14 items)
- [ ] Correction classifier: Type 1 (one-transaction: wrong amount/code/checkbox, or filed-in-error) vs Type 2 (two-transaction: wrong/missing TIN, wrong name, wrong form type)
- [ ] One-transaction flow: corrected record (CORRECTED indicator) generated from as-filed snapshot + edits → IRIS correction submission per Pub 5718
- [ ] Two-transaction flow: (1) zeroing record against original TIN/name, (2) new original with correct data — composed and transmitted as a pair, linked in DB
- [ ] Filed-in-error: one-transaction zero-out with void semantics
- [ ] Correction chain: corrected(n) versioning; only latest correctable; full chain visible in record history
- [ ] Guardrails: corrections only from `accepted` records; diff-from-snapshot display before queue
- [ ] Reviewer approval gate on all corrections (config)
- [ ] Corrected Copy B: "CORRECTED (if checked)" box checked on substitute form; re-render portal + pressure-seal
- [ ] Re-delivery: corrected form auto-queues paper reprint + new portal token + notification (Phase 8)
- [ ] MO impact prompt: if corrected record was in a MO file, surface MO correction checklist (Phase 10 constraints)
- [ ] Prior-year corrections: registry-driven (TY2025 via IRIS after FIRE sunset noted)
- [ ] Correction reason codes + notes (workpaper trail)
- [ ] Dashboard: outstanding corrections, ack status
- [ ] E2E: Type 1 and Type 2 round-trip against mock IRIS

### Phase 12 — Dashboard, Reporting & Ops (12 items)
- [ ] Firm dashboard: season progress by payer (entered / ready / transmitted / accepted / delivered), deadline countdowns
- [ ] Payer detail: form counts + dollar totals by type, delivery status matrix (paper/email/SMS/viewed)
- [ ] Exception queue: rejected records, TIN validation failures, missing addresses, missing W-9s — one worklist
- [ ] Filing summary report (PDF via sidecar): per-payer season summary for client delivery/workpapers
- [ ] Audit log viewer with filters + export
- [ ] Data retention config: encrypted archives per §6103-adjacent firm policy; 4-year minimum default
- [ ] Year-end close: lock tax year (read-only except corrections)
- [ ] Health endpoints + appliance status page (queue depth, render sidecar, IRIS reachability)
- [ ] Backup/restore runbook + restore test script
- [ ] Usage metering hooks for commercial license tiers (payer count / client-portal seats)
- [ ] WISP appendix doc: how Vibe 1099 maps to Pub 4557 controls
- [ ] Load test: 5,000 form records, 500-form batch render, 1,000-record IRIS batch

---

## ADDENDUM A — Vibe Appliance Integration (10 items)
- [ ] Manifest entry: `vibe-1099` (compose fragment, images, volumes, ports 8210–8212, env schema)
- [ ] Caddy route: `1099.{firm-domain}` (staff/client) — recipient/W-9 portal routes require public exposure via Cloudflare Tunnel; document split-exposure pattern (staff LAN/Tailscale-only, portal tunnel-public)
- [ ] Compatibility addendum doc (suite pattern): resource footprint, Postgres major version, Redis sharing policy (dedicated DB index)
- [ ] Appliance console: install/upgrade/backup actions wired
- [ ] Shared secrets: master encryption key provisioning via appliance secret store
- [ ] SMTP + SMS config inherited from appliance-level settings where present
- [ ] Migration-on-upgrade smoke test in appliance pipeline
- [ ] Uninstall/data-export procedure
- [ ] Licensing check integration (licensing.kisaes.com)
- [ ] Add to appliance seven-addenda compatibility review

## ADDENDUM B — Deferred / v1.5 Candidates
- MOFTP system-to-system MO submission
- Combined recipient statement (multi-form single mailer)
- Additional form types (1099-R, 1099-S, 1099-K, W-2G)
- Full state config table population + additional direct-file generators
- Pub 1179 §4.6 electronic-only delivery with consent machinery (drop paper for consenting recipients)
- IRS e-Services bulk TIN Matching
- Cross-app recipient vault federation (T&B contacts / MyBooks vendors)
- 1042-S support via IRIS

---

## FIRM ONBOARDING RUNBOOK (ship as doc)
1. Apply for IRIS A2A TCC (Transmitter role; Issuer if filing own firm's forms) — ID.me-verified Responsible Officials; allow 45+ days
2. Apply for API Client ID after TCC approval
3. Generate JWK in Vibe 1099 settings → register public key with IRS
4. Pass ATS communication/scenario testing in ATS mode → IRS flips TCC to Production
5. Missouri: confirm MOID + PIN for Online W-2/1099 Submission System
6. Calibrate pressure-seal alignment with test-pattern sheet; verify sealer fold spec = Z-fold 8.5×11
7. Load recipients (CSV or W-9 campaign) before season

**Critical path warning:** TCC + ATS = 2–4 months. Firms onboarding for a January season must start paperwork by September.
