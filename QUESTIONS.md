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
