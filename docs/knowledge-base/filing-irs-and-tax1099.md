# IRS transmissions (IRIS & Tax1099)

**Sidebar:** Filing & delivery → **IRS transmissions**

**What it's for:** e-filing 1099s to the IRS and tracking each transmission through to an acknowledgement. The app supports two filing backends.

## Two backends
Choose a firm default in **Settings → E-file**, and optionally override per payer (Payers → *Filing backend*):

| Backend | Who transmits | What you need |
|---|---|---|
| **IRIS A2A** | **Your firm** is the IRS Transmitter | An IRS **TCC** (Transmitter Control Code) + a signing **JWK** key |
| **Tax1099 (Zenwork)** | **Tax1099** files on the payer's behalf | A Tax1099 **API key** — **no IRS TCC required** |

Use **Tax1099** for firms or entities that don't want to obtain and maintain their own IRS account. Everything upstream (data entry, review, corrections, the transmit button) works the same regardless of backend.

> **§7216 disclosure — one-time acknowledgment.** Filing or mailing through Tax1099 transmits recipient TINs (SSNs/EINs), names, addresses, and dollar amounts to **Zenwork, Inc.** as an auxiliary service provider (Treas. Reg. §301.7216-2(d)). Before any Tax1099 filing, TIN-match, or hosted-W-9 call is allowed, an admin must tick the acknowledgment box under **Settings → E-file → Tax1099**. Until then, Tax1099 filing stays disabled. The acceptance is recorded in the audit log as a disclosure event. IRIS filing (your own TCC) does not involve this third party.

## Transmitting
- From **Form entry** you can transmit a single payer's queued forms.
- From **[Fleet operations](fleet-operations.md)** you can transmit across many payers at once.
- Each transmission is built per payer, sent, and given a receipt.

## Acknowledgements (automatic)
After sending, the app **polls for the result** with backoff and updates records automatically:
- **Accepted** — done.
- **Accepted with errors** — the transmission went through but some records were rejected; those land in an exception list to fix and re-file as corrections.
- **Rejected** — the whole transmission failed; records return to draft to fix and re-queue.

You'll get a **notification** on the result, and admins are alerted on failures.

## The transmissions log
- See every transmission for the year: backend/environment, receipt ID, status, record count, and errors.
- Admins can download the raw filing (XML for IRIS) and the acknowledgement, and **re-poll** a stuck transmission.

## Deadlines & extensions
The screen shows the **deadlines** for the selected year:
- **1099-NEC** — recipient copies **and** IRS e-file both due **Jan 31**.
- **MISC / INT / DIV** — IRS e-file due **Mar 31** (recipient copies Jan 31).
- It also explains **Form 8809** (extension of time to file) — note NEC has no automatic 30-day extension.

## Setting up IRIS (admin)
IRIS onboarding is a multi-week process handled in **Settings → E-file**:
1. Apply for an **IRIS A2A TCC** (Transmitter role) — ID.me-verified officials; allow several weeks.
2. Apply for the **API Client ID**.
3. **Generate the signing keypair** in-app and register the public JWK with the IRS.
4. Pass **ATS** (test) scenarios in ATS mode.
5. The IRS flips your TCC to Production — switch the environment toggle.

## Setting up Tax1099 (admin)
In **Settings → E-file**, choose **Tax1099**, paste your **API key** (stored encrypted), pick **sandbox** or **production**, and optionally let Tax1099 **USPS-mail** recipient copies. Then route payers to it via the firm default or per-payer override.
