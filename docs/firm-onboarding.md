# Firm onboarding runbook

> **Critical path warning:** TCC + ATS testing = **2–4 months**. A firm onboarding for a January
> season must start IRS paperwork by **September**.

1. **Apply for an IRIS A2A TCC** (Transmitter role; add Issuer if the firm files its own 1099s)
   via the IR Application for TCC on irs.gov. Responsible Officials must be ID.me-verified.
   Allow **45+ days** for approval.
2. **Apply for the API Client ID** after the TCC is approved (A2A-specific step in the IR
   application).
3. **Generate the signing keypair** in Vibe 1099 → Settings → IRIS e-file → *Generate keypair*.
   Register the displayed **public JWK** with the IRS A2A enrollment. Rotation: generate a new
   pair, re-register, transmissions continue.
4. **Pass ATS testing.** Keep Settings → environment = **ATS**; run the communication test and
   required scenarios (docs/ats-checklist.md). When the IRS flips the TCC to Production, switch
   the environment toggle to **PROD**.
5. **Missouri:** confirm the firm's/payers' **MOID + PIN** for the Online W-2/1099 Submission
   System (mytax.mo.gov). Enter payer MO withholding IDs on the Payers screen.
6. **Pressure-seal:** print Settings → *calibration sheet*, run it through the sealer, adjust the
   X/Y offsets in 1/16″ steps until the fold lines land on the stock's perforations and the
   address block is fully visible. Verify sealer fold spec = **Z-fold 8.5×11, 28# fully blank**.
7. **Load recipients** before the season: CSV import (Recipients screen) or a W-9 campaign
   (W-9 requests screen).
8. **SMTP/SMS:** point SMTP at the firm relay (SPF/DKIM: docs/dkim-smtp.md); register the SMS
   sender (10DLC) with TextLink or Twilio before January volume.

## Season flow (once onboarded)

client invites → entries reviewed → forms ready → queued → transmit (Jan 31 NEC!) →
paper batch printed & mailed by Jan 31 → portal links composed → MO file by end of Feb →
MISC/INT/DIV e-file by Mar 31 → corrections as acks come back.
