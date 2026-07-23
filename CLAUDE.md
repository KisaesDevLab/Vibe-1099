# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**All 12 phases + Addendum A are built and verified** (see `PHASES.md` for per-item status and
partials, `STATE.md` for the verification journal, `QUESTIONS.md` for open operator decisions).
`VIBE_1099_BUILD_PLAN.md` remains the source of truth for LOCKED DECISIONS (13 of them) and scope.

## Commands

```bash
pnpm install
pnpm typecheck        # tsc --noEmit over shared/db/core/api/worker + tests
pnpm lint             # eslint flat config (correctness rules only)
pnpm test             # vitest; single file: pnpm vitest run tests/mo1220.golden.test.ts
pnpm --filter @vibe1099/web build   # web typecheck + vite build
pnpm seed             # migrations + demo data (needs DATABASE_URL, MASTER_KEY)
pnpm dev:api | dev:worker | dev:web
pnpm --filter @vibe1099/worker mock-iris   # mock IRS on :8299 (IRIS_MOCK_BASE_URL)
pnpm --filter @vibe1099/worker mock-tax1099      # mock Tax1099 on :8300 (TAX1099_MOCK_BASE_URL)
pnpm --filter @vibe1099/worker mock-taxbandits   # mock TaxBandits on :8301 (TAXBANDITS_MOCK_BASE_URL)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis render
#   dev ports: postgres :55432, redis :56379, render :8212
```

Dev env vars for local api/worker: `DATABASE_URL=postgres://vibe1099:vibe1099@localhost:55432/vibe1099`,
`REDIS_URL=redis://localhost:56379/3`, `RENDER_URL=http://localhost:8212`, `MASTER_KEY=<32B base64>`.
Demo login after seed: `admin@demo.firm` / `vibe1099-demo-password`.

## What is being built

Vibe 1099 — a **self-hosted Docker appliance** for CPA firms to prepare, deliver, and e-file 1099 forms. Standalone (not a T&B module). v1 form scope: **1099-NEC, 1099-MISC, 1099-INT, 1099-DIV**. It e-files to the IRS via **IRIS A2A** (the firm is the Transmitter, using its own TCC), direct-files Missouri via **Pub 1220 .txt**, mails **Copy B** via Z-fold pressure-seal, and exposes courtesy portal/W-9 flows.

## Planned stack & toolchain (not yet scaffolded)

- **Monorepo:** pnpm workspaces — `apps/web` (React 18 + TS SPA), `apps/api` (Express + Drizzle + BullMQ producers), `apps/worker` (BullMQ consumers), `packages/shared` (zod schemas + form-type registry), `packages/db` (Drizzle schema/migrations).
- **Runtime:** Node.js 24, PostgreSQL 16, Redis 7, BullMQ.
- **PDF:** `vibe1099-render` sidecar — WeasyPrint + Jinja2 templates + external CSS, exposed as `POST /render` (template name + JSON → PDF bytes). Reuses the Vibe T&B invoice template pattern.
- **Deploy:** Docker Compose (`vibe1099-web`, `vibe1099-api`, `vibe1099-worker`, `vibe1099-render`, `postgres:16`, `redis:7`). Caddy is handled at the Vibe Appliance level (Addendum A).
- **Ports:** API **8210**, web **8211**, render **8212** (registered in the suite port table).

When you scaffold commands (build/lint/test/dev), record them here so future instances don't have to rediscover them.

## Non-obvious conventions — do not violate

These deviate from intuition or from the wider Vibe suite; getting them wrong corrupts filings or leaks PII.

- **Money is integer cents everywhere** (ADR-001). This deviates from the suite's whole-dollar convention. Required because MO Pub 1220 money fields carry cents (assumed decimal, no rounding) and IRIS XML carries decimals. Never store or compute form amounts as dollars or floats.
- **TIN encryption:** AES-256-GCM at rest via envelope pattern (per-install master key → per-record DEK). Plaintext TIN is **never logged, never in URLs**. It is truncated (`XXX-XX-1234` / `XX-XXX1234`) on all payee-facing output. Payer TIN is shown in full only where filing rules require.
- **TIN lookup without decryption:** `tin_hash = HMAC-SHA256(TIN, install key)` with `UNIQUE(firm_id, tin_hash)` (ADR-002). Vault matching (lookup-as-you-type, dedupe) goes through the hash, not decryption.
- **Three trust zones**, enforced at the query layer and covered by tests:
  - **Staff zone** — session auth, full data.
  - **Client zone** — magic-link JWT scoped to `payer_id` + `tax_year` claims only; a client can never see other payers/years/staff data. Client-side vault lookups return masked matches (no full TIN echoed to the client).
  - **Recipient zone** — HMAC-signed expiring URL (T&B third-party-share pattern) + last-4-TIN challenge; sees only its own form PDF.
- **Delivery policy (b):** paper Copy B is **always mailed**; the portal link is a courtesy copy. No Pub 1179 §4.6 consent machinery in v1 — do not build consent capture.
- **Form definitions are registry-driven and tax-year-keyed:** `packages/shared` holds a form-type registry keyed by `(form_type, tax_year)` mapping each box to its IRIS XML element, MO Pub 1220 amount-field position, and Copy B template slot. Add forms/years by extending the registry, not by branching logic.
- **Corrections come from an immutable as-filed snapshot** taken on transmit; corrected records diff against that snapshot. Only `accepted` records are correctable. Type 1 = one-transaction; Type 2 = two-transaction (zeroing record + new original, transmitted as a linked pair).
- **`audit_log` is append-only**; all mutations go through audit middleware.
- **Licensing:** MIT (see LICENSE). Separately, an optional runtime flag (`LICENSE_REQUIRED`, default `0`) gates commercial features (client-portal access) via the later-phase activation server (`licensing.kisaes.com`) — a product feature, not the copyright license.

## Compliance frame

The plan is written against specific IRS/state authorities — cite these when a decision needs justification: IRC §7216/§6713, FTC Safeguards/GLBA, IRS Pub 4557/5708 (WISP), Pub 1179 (substitute forms), Pub 5718 (IRIS A2A), Pub 1220 (MO state file). The firm-onboarding critical path (IRIS TCC + ATS testing) is **2–4 months** — noted at the end of the plan.

## Status machine (form records)

`draft → ready → queued → transmitted → accepted | rejected → corrected(n)`. Transitions are guarded; a config flag can require reviewer approval before `queued`. Records are deletable only in `draft`/`ready`; anything transmitted requires the correction path.
