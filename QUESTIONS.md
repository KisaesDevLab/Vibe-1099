# QUESTIONS — open decisions for the operator

## Resolved 2026-07-02 (operator Q&A)

- ~~TY2026 NEC/MISC threshold value~~ → **admin-configurable per (form type, year)**:
  Settings → *Federal filing thresholds* (app_settings `federal_thresholds`, cents, overrides
  registry defaults; warn-only either way). Registry defaults remain $2,000 (OBBBA) for TY2026.
- ~~SMS provider default~~ → **TextLink** ships as `SMS_PROVIDER` default; firm-level
  credentials are set in **Settings → SMS provider** (stored envelope-encrypted in
  `firms.sms_override`; overrides env; Twilio also selectable there).
- ~~Pressure-seal stock~~ → **uniform Z-fold** (3.667″ thirds) as built; calibration sheet
  covers drift.
- ~~Combined recipient statement~~ → stays deferred (Addendum B); **one sheet per form** in v1.
- ~~IRIS enrollment~~ → not started; mock defaults remain until TCC/API Client ID arrive.
- ~~MO A-record withholding-ID position (715–728)~~ → confirm against the current MO handbook
  **before the first real submission**; golden tests pin the current layout.
- ~~Git~~ → initial commit created.

## Still open

1. **IRIS endpoint paths + XSDs** — when the firm enrolls, confirm Pub 5718 paths in
   `packages/core/src/iris/client.ts:irisEndpoints` and drop the IRS schema package into
   `render/xsd/<taxYear>/IRTransmission.xsd`.
2. **TextLink API shape** — the driver targets `POST /api/send-sms` with bearer auth; verify
   against the account's actual plan/endpoint on first real send (key goes in Settings → SMS).
3. **10DLC sender registration** — account-level task at TextLink before January volume.
4. **MO handbook check** — see resolved note above; the one-line position change + golden-test
   update is expected work before the first MO filing.
5. **Pub 1220 record terminator** — the writer emits 750 data characters **plus** CR/LF (752
   bytes per line). Pub 1220 defines positions 749–750 as "blank or CR/LF" (i.e. 748 data +
   CR/LF inside the 750). Most vendors ship 750 + CR/LF and line-oriented readers accept it, but
   MO DOR's tolerance is undocumented — upload a `testFile` to mytax.mo.gov before the first
   real submission; if it is rejected for record length, switch `writer.ts` to 748 + CR/LF and
   update the golden test's 750-character assertion.
6. **Proxy hop count for the staff IP allowlist** — `TRUST_PROXY_HOPS` defaults to 2 (appliance:
   Caddy + nginx). In the standalone compose there is only nginx in front of the API, and nginx
   *appends* to `X-Forwarded-For`, so a LAN client can pre-load one hop and choose its own
   `req.ip` — which `STAFF_IP_ALLOWLIST` and the per-IP rate limits key on. Decide per
   deployment: set `TRUST_PROXY_HOPS=1` for LAN/Tailscale-only standalone installs (tunnel
   traffic then rate-limits per tunnel, not per client), or keep 2 only where a sanitizing proxy
   (Caddy/Cloudflare) is guaranteed in front of nginx.
