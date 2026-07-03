# Glossary

## People & entities
- **Firm** — your accounting practice; the tenant that runs the appliance.
- **Payer / issuer / entity** — a business you file 1099s for. A firm serves many payers.
- **Recipient** — a contractor or vendor who receives a 1099; stored once in the firm-wide **vault** and reusable across payers.
- **Form record** — one 1099 for one recipient, one payer, one tax year.

## Roles & zones
- **admin / reviewer / preparer** — staff roles (see [Overview](overview.md#roles)).
- **Reviewer gate** — optional setting requiring reviewer approval before a form can be queued.
- **Staff / Client / Recipient zone** — the three separate access levels (session login / payer-scoped magic link / recipient-scoped signed link).

## Form statuses
- **draft** — being entered; editable and deletable.
- **ready** — checked and staged; still editable/deletable.
- **queued** — staged for a filing run.
- **transmitted** — sent to the IRS/Tax1099; awaiting acknowledgement.
- **accepted** — the IRS accepted it.
- **accepted_with_errors** — accepted overall, but some records were rejected.
- **rejected** — failed; returns to draft to fix and re-queue.
- **corrected** — a correction was filed against it.

## Filing
- **IRIS A2A** — the IRS Information Returns Intake System; your firm files as the **Transmitter**.
- **TCC** — Transmitter Control Code; the IRS credential required to transmit via IRIS.
- **JWK** — the cryptographic signing key IRIS uses to authenticate your firm.
- **ATS** — the IRS test environment you must pass before going to Production.
- **Tax1099 (Zenwork)** — a managed filing backend that transmits on the payer's behalf, so no firm TCC is needed.
- **Acknowledgement (ack)** — the IRS response that moves records to accepted / accepted-with-errors / rejected.
- **UTID / Receipt ID** — identifiers for a transmission and its IRS receipt.

## Corrections
- **As-filed snapshot** — the immutable copy of a form captured at transmit; corrections diff against it.
- **Type 1** — one-transaction correction (e.g. wrong amount).
- **Type 2** — two-transaction correction (a zeroing record + a new original), used when identifying info was wrong.

## Delivery
- **Copy B** — the recipient's copy of the 1099; **always mailed** on paper.
- **Z-fold pressure-seal** — the single-sided, tri-panel mailer format for Copy B.
- **Portal courtesy copy** — an optional online copy delivered via a secure recipient link.
- **Paper-only** — a recipient with no email/mobile; gets the mailed copy but no portal link.

## State
- **Pub 1220** — the IRS/state fixed-width file format; Missouri accepts it for direct filing.
- **MO-source** — a record flagged as Missouri-sourced, included in the MO file.

## Data & money
- **Vault** — the firm-wide store of recipients, deduplicated by tax ID.
- **Integer cents** — amounts are stored to the cent, never as rounded dollars.
- **TIN** — Taxpayer Identification Number (SSN or EIN), encrypted at rest and shown truncated to the last four digits on payee-facing output.
- **Backup withholding** — a recipient flag indicating tax was withheld because a valid TIN wasn't provided.
