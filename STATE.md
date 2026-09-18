# STATE — build journal

## 2026-09-17 — Phase 8 step 5: single sign-on via `@kisaesdevlab/vibe-auth`

Staff realm only (recipient/client portals untouched). Verified on this machine:

- `pnpm typecheck` / `pnpm lint` clean; `pnpm test` 163/163 (+ `tests/vibe-auth-users.test.ts`)
- `pnpm --filter @vibe1099/web build` clean (LoginPanel + AuthSettingsPage from the package's React entry)
- `pnpm test:sso-e2e` 14/14 against docker postgres/redis + the fake IdP: status local/both, PKCE login → JIT
  (role map, both cookies, CSRF-protected POST from the SSO session), email link + role sync, unverified email
  denied, `/auth/settings` 403/200 + CSRF on PUT, `oidc_only` boot refusal without break-glass, RP-initiated and
  `?local=1` logout, back-channel logout ending every Redis session (replay refused), fresh login after it,
  break-glass CLI (the exact in-image `node --import tsx … cli.js` command) + local login + audit,
  `oidc_only` guard on `/api/auth/login` while portals and the TaxBandits webhook probe still answer
- Migration `0013_vibe_auth.sql` (package SQL verbatim + `auth_sessions_oidc`) applied idempotently on boot
- Deviations from the Vibe-Auth plan and the appliance-side follow-ups are listed in `docs/SSO.md`

## 2026-07-02 — full autonomous build (Phases 1–12 + Addendum A)

Built in one pass from `VIBE_1099_BUILD_PLAN.md`. Verified live on this machine:

- `pnpm typecheck` clean; `pnpm test` 68/68 (money, TIN, registry validation, status machine
  exhaustive-pair, crypto round-trip/tamper, Pub 1220 golden positions, IRIS XML, TOTP RFC vector,
  templates, E.164, PII redaction)
- `pnpm --filter @vibe1099/web build` clean (vite, 312 kB bundle)
- Live E2E against docker postgres/redis + render sidecar + mock IRIS:
  - migrations + seed (argon2, envelope encryption, tin_hash)
  - staff login → CSRF → payers/recipients/forms
  - IRIS settings + in-app JWK generation
  - 6 records draft → ready → queued → **transmit** (UTID, snapshot) → Receipt ID → poll →
    partial acceptance (5 accepted / 1 rejected with translated TIN-mismatch error — deliberate:
    seeded TIN ending in 99 triggers the mock's error path)
  - Copy B portal PDF (2 pages), Z-fold sheet (exactly 2 pages — duplex pair), calibration sheet
  - render sidecar /merge pageCount used as the structural duplex test

### Known partials (tracked in PHASES.md)
1. Copy 2 (state) staff button — template supports it via `copy_label`; route wiring open.
2. Pixel-diff golden tests for templates (structural tests in place).
3. Browser-automation E2E for portals (API-level flows verified).
4. Real IRIS XSDs not bundled (IRS distributes to enrolled transmitters).
5. 5k-record load test scripted but not executed here.
6. Appliance-console wiring (external repo).

### Environment notes
- Dev override `docker-compose.dev.yml` maps postgres→55432, redis→56379.
- `.env` on this machine holds a generated MASTER_KEY (gitignored).
- Mock IRIS: `pnpm --filter @vibe1099/worker mock-iris` on :8299; behaviors documented in the
  file header (TIN …99 → record error; UTID sha ending 'f' → whole-file reject; first poll →
  Processing).
