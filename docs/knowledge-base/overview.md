# Overview

## What Vibe 1099 does
Vibe 1099 is a standalone, self-hosted application a CPA firm runs to handle the full 1099 lifecycle for the businesses it serves:

- **Prepare** — enter (or let clients enter) payment amounts for contractors and vendors.
- **E-file to the IRS** — either through **IRIS A2A** (your firm is the transmitter) or through **Tax1099 (Zenwork)** as a managed backend (no IRS account needed).
- **Direct-file Missouri** — generate the MO Pub 1220 `.txt` file for upload at mytax.mo.gov.
- **Deliver Copy B** — always mail a paper Copy B (Z-fold pressure-seal), with optional online courtesy copies via secure portal links.
- **Collect W-9s** — request missing tax IDs from contractors through a secure link.

**Form types supported:** 1099-NEC, 1099-MISC, 1099-INT, 1099-DIV.

## Key vocabulary
- **Firm** — your accounting practice (the tenant that runs the appliance).
- **Payer / entity** — a business you file *for* (also called the *issuer*). The firm can serve many payers.
- **Recipient** — a contractor or vendor who receives a 1099. Recipients live in a firm-wide **vault** and can be associated with more than one payer.
- **Form record** — one 1099 for one recipient, one payer, one tax year.

## Roles
Every staff user has one role:

| Role | Can do |
|---|---|
| **admin** | Everything, including Settings (firm profile, e-file credentials, email/SMS, users, filing years). |
| **reviewer** | Prepare and review, approve client submissions, and transmit filings. |
| **preparer** | Prepare forms and manage people/data; cannot change firm-wide settings. |

A configurable **reviewer gate** (Settings → Advanced) can require a reviewer to approve records before they are queued for filing.

## Trust zones (who sees what)
The app enforces three separate access zones:

1. **Staff zone** — your team. Session login, CSRF protection, optional two-factor (TOTP), and an inactivity timeout.
2. **Client zone** — a payer's contact, reached by a **magic link**. Scoped to a single payer + tax year. Clients never see other payers, other years, or staff data. Vault lookups show only masked matches.
3. **Recipient zone** — a single contractor, reached by an **expiring signed link** plus a **last-4 of TIN challenge**. Sees only their own form.

## How money and tax IDs are handled
- **Amounts are stored to the cent.** What you type as `22,000.00` is stored exactly; there is no rounding drift.
- **TINs are encrypted at rest** and shown **truncated** (e.g. `XXX-XX-1234`) on anything a recipient or client can see. A payer's own TIN is shown in full only where filing rules require it. Revealing a full TIN in the staff app is recorded in the audit log.

## The form status lifecycle
```
draft → ready → queued → transmitted → accepted | rejected → corrected
```
- **draft / ready** — editable; can be deleted.
- **queued** — staged for a filing run.
- **transmitted** — sent to the IRS (or Tax1099); awaiting an acknowledgement.
- **accepted / accepted_with_errors** — the IRS accepted it. Now it can only be changed through the **Corrections** path.
- **rejected** — returns to draft for fixing and re-queuing.

See the [Glossary](glossary.md) for every status and term.
