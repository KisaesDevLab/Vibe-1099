# PHASES — build checklist state

Source plan: `VIBE_1099_BUILD_PLAN.md`. ✅ done · 🟡 partial (see note) · ⬜ open

## Phase 1 — Scaffold & appliance base
- ✅ pnpm workspace (apps/web, apps/api, apps/worker, packages/shared, packages/db, packages/core*)
- ✅ Docker Compose (web, api, worker, render, postgres, redis) + healthchecks + named volumes
- ✅ Env schema validation (zod, fail-fast boot)
- ✅ Migration runner on boot (SQL files + advisory lock; drizzle-orm for queries)
- ✅ Redis + BullMQ wiring; queue dashboard (Settings → Queues)
- ✅ WeasyPrint sidecar `POST /render` + `/merge` + `/validate-xml` (Jinja2, external CSS)
- ✅ pino logging, request IDs, PII redaction (TIN scrubbing, boxValues redacted)
- ✅ Backup volume layout + pg_dump runbook (docs/backup-restore.md)
- ✅ ADR-001 integer cents · ✅ ADR-002 tin_hash
- ✅ Seed: demo firm, 2 payers, 12 recipients, NEC/MISC/INT/DIV records
- ✅ CI (typecheck, tests, web build, docker builds) — lint wired via eslint config
- ✅ CLAUDE.md, PHASES.md, STATE.md, QUESTIONS.md
- ✅ License: MIT via package.json license field (no runtime license gating)
- ✅ Ports 8210/8211/8212 · ✅ /api/about version endpoint · ✅ error taxonomy (shared/errors.ts)
- ✅ README with appliance install stub

## Phase 2 — Auth & tenancy — **all items ✅**
argon2id sessions, roles, CSRF, TOTP, magic-link invites (30-day default, revoke/reissue),
client scope enforcement at query layer, recipient HMAC tokens + last-4 challenge + lockout
alerts, rate limiting on all public endpoints, audit middleware, password reset, inactivity
timeout (rolling Redis TTL), IP allowlist, helmet/CSP, login/audit views, pen-test checklist
(docs/pen-test-checklist.md).

## Phase 3 — Recipient vault — **all items ✅**
Envelope encryption + key-rotation doc, tin_hash unique index, CRUD with masked TIN +
audited reveal, SSN/EIN/ITIN heuristics, lookup-as-you-type (staff + client), address history,
name-change confirm-on-match flow, merge tool, CSV import with dedupe preview, rollforward,
W-9 status field + stale detection, backup-withholding flag, filtered list views, encrypted
export, vault stats widget, unit tests.

## Phase 4 — Form engine — **all items ✅**
Registry (form_type, tax_year) with IRIS/MO/CopyB mappings; TY2025+TY2026; all four forms' boxes;
validation layer (negatives, interdependencies, backup-withholding context, registry-driven
TY2026 OBBBA threshold warn-only); second-TIN-notice; account-number auto-gen; guarded status
machine + reviewer gate; keyboard-first grid (Enter = down-column); inline vault lookup; bulk CSV
import with report; duplicate detection; 1096-equivalent summary; delete rules; multi-year;
snapshot-on-transmit; notes; exhaustive transition tests.

## Phase 5 — Client entry portal — **all items ✅**
Invite flow with email/SMS send, landing/scope confirmation, form-type picker, contractor grid
with prior-year prefill, masked client-side lookup ("We have JOHN D—…"), new-recipient +
W-9-request button, save-and-return drafts, submit → client_submitted review queue, staff
promote, scope enforced at query layer, mobile-responsive, progress + confirmation with totals,
client activity audit, re-open flow. 🟡 E2E browser tests not automated (manual walkthrough
verified; API-level flows covered).

## Phase 6 — Substitute forms & pressure-seal — **✅ (2 partials)**
Pub 1179 Copy B templates (registry-driven grid + per-type instructions), TIN truncation on all
payee output, portal PDF (Copy B + instructions, verified 2 pages), Z-fold imposition at 3.667"
folds with mailer face + backer, ±1/16" calibration offsets + test-pattern sheet, batch builder
(deterministic order, manifest page, chunked BullMQ render, 50-form chunks), duplex verified in
PDF structure (exactly 2 pages/sheet), reprint subsets, batch lifecycle → deliveries, one sheet
per form. ✅ Copy 2 state variant (`GET /api/batches/preview/copy2/:formId`, guarded to
state-withholding forms). 🟡 Golden-file visual regression: structural PDF tests done;
pixel-diff harness open.

## Phase 7 — W-9 — **all items ✅**
Staff + client-initiated requests, current-revision fields with certification text, typed/drawn
e-sign with ESIGN consent + IP/UTC/UA capture, PDF render → encrypted blob → vault upsert
(source=w9), TIN-mismatch flag (never silent overwrite) + staff resolve, lifecycle with
reminders (configurable day offsets, hourly sweep), dashboard with aging, client-visible status,
stale detection + bulk re-request, audited PDF retrieval, backup-withholding prompt (exception
queue surfaces missing W-9s).

## Phase 8 — Delivery — **all items ✅**
SMTP adapter + DKIM doc, SMS adapter interface + TextLink & Twilio drivers + E.164 + STOP
opt-out flag, editable templates with placeholders, recipient portal (token → last-4 → PDF),
Oct-15 availability policy, courtesy-copy framing, bulk composer, channel resolution
(email → SMS → paper-only badge), tracking (sent/bounced/viewed/downloaded), resend +
regenerate-token, corrected re-delivery with CORRECTED banner, no PII in URLs, brute-force
lockout + per-IP throttle.

## Phase 9 — IRIS A2A — **✅ (verified against bundled mock)**
Settings (TCC/ClientID/JWK encrypted, ATS|PROD), JWK generate/rotate/export, OAuth JWT
assertion flow with token cache, registry-driven XML generator with pinned schema versions,
XSD validation endpoint (bundled-XSD, skip-gracefully), CF/SF election (AR 05 documented),
batch composer with UTID idempotency + 100MB cap, transmit worker (Receipt ID capture), ack
polling (exp backoff → hourly, stall alerting), partial acceptance (accepted lock, rejected →
errors → edit → requeue), error translation table (admin-editable, seeded), duplicate-submission
guard (UTID unique + in-flight check + mock 409), ATS banner + checklist, transmission log with
raw XML/ack download, Receipt ID retention, deadline dashboard, 8809 guidance (NEC no-auto-ext
flagged), retry/backoff + circuit breaker, failure alerting, mock IRIS harness. 🟡 Real IRS XSD
files not bundled (IRS distributes to enrolled transmitters — drop into render/xsd/<year>/).

## Phase 10 — Missouri Pub 1220 — **all items ✅ (golden-file verified)**
750-char CR/LF uppercase writer, T→A→B→C→K→F, cents money fields, MO-source scoping +
$1,200 threshold with override, withholding fields + K-record reconciliation, builder UI with
preview, filename/encoding, position-asserted golden tests, manual status tracking
(generated→uploaded→accepted/rejected), whole-file rejection + supersede flow, correction
constraints surfaced in-app, states_config stub (MO live, AR CF/SF row), MOFTP deferred (Add. B).

## Phase 11 — Corrections — **all items ✅**
Type 1/Type 2 classifier, one-transaction flow, two-transaction zero+new linked pair,
filed-in-error void, corrected(n) chains with only-latest-correctable guard, diff-from-snapshot
preview, reviewer gate, corrected Copy B (CORRECTED checkbox) re-render both formats,
re-delivery (new token + notification; paper via new batch), MO impact prompt, prior-year via
registry, reason codes/notes, outstanding dashboard. 🟡 Mock-IRIS correction round-trip: engine
verified; scripted E2E for both correction types is open.

## Phase 12 — Dashboard & ops — **all items ✅**
Season progress by payer + countdowns, payer detail with delivery matrix, exception queue
(rejects/TIN failures/missing addresses/missing W-9s), filing summary PDF, audit viewer +
CSV export, retention config (4-year min sweep), year-end close locks, health/status endpoints,
backup/restore runbook + restore test script, usage metering (payer count/portal seats),
WISP appendix, load-test script (scripts/load-test.md). 🟡 Full 5k-record load test not executed
in this environment.

## Addendum A — Appliance integration
- ✅ Manifest fragment (appliance/manifest.yaml), compose, ports registered
- ✅ Caddy route + split-exposure doc · ✅ compatibility addendum · ✅ secrets via env/secret store
- ✅ SMTP/SMS inherited via env · ✅ uninstall/export procedure · ✅ MIT license (no runtime gating)
- ✅ Health contract: `/api/status` verdict = bundled deps only (postgres/redis/render/queues);
  IRIS reachability is informational and never flips it (was gating → permanent 503 pre-enrollment
  / restricted egress). Regression test `tests/appliance-status.test.ts`.
- ✅ Migration-on-upgrade smoke test (`scripts/upgrade-smoke.sh`) — probes in-container via
  `docker compose exec` (api is `expose`-only; the old `curl localhost:8210` never connected).
- ⬜ Wire into the actual appliance console repo (lives outside this repo)

## Addendum B — deferred (unchanged)
MOFTP, combined statements, more form types, more states, §4.6 e-consent, bulk TIN matching,
vault federation, 1042-S.
