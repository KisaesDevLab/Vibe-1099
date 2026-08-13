# Recipients (the vault)

**Sidebar:** People → **Recipients**

**What it's for:** the firm-wide **vault** of contractors and vendors. One recipient record holds a person/company's name, address, and tax ID, and can be reused across many payers and years.

## One record, many entities
A recipient is stored **once per firm**, keyed by their tax ID. If the same contractor is paid by three of your client entities, that's **one** vault record linked to three payers through their form records — never a duplicate. Editing the recipient's address updates it everywhere it's used.

## Adding & finding recipients
- **+ Add recipient** — as you type a 9-digit TIN, the app does a **lookup**: if the vault already has that TIN, it offers to reuse the existing record instead of creating a duplicate.
- **Search** by name or last-4 of TIN, and **filter** by: missing address, no email/mobile, no W-9, stale W-9, or backup withholding.
- **CSV import** — bulk-load recipients (`tin,tinType,name1,name2,line1,line2,city,state,zip,email,mobile`) with a dedupe-by-TIN preview.
- **Import from PDF** — upload a prior-year 1099 print PDF from your old filing software. The forms are parsed into a payer + recipient list you review and edit before anything is saved (scanned images can't be read; TINs must be full, not truncated).

## Bringing over a client's filing history (PDF import)

The PDF import can also record the parsed amounts as **filed forms** for the year you choose — tick *"Also record these amounts as filed forms"*, set the **tax year**, **form type** (data-only prints don't say which form they are), and the **amount box** (e.g. NEC box 1, or MISC box 1 rents). Each row with an amount becomes an **accepted** record marked *filed outside Vibe 1099*, including recipients that were already in the vault.

What those records do and don't do:
- They make the prior year read complete, so **Rollforward** on the forms grid pre-lists the client's recipient set for the new season (amounts blank).
- They **cannot be re-transmitted** — there is no path from `accepted` back to the filing queue, so imported history can never double-file.
- They **cannot be corrected here** — the original was transmitted by the old software, which is where a correction must be filed.
- They **can be deleted** if the import was wrong (unlike normally-filed accepted records), so a botched import is recoverable.

## Per-recipient actions
- **Edit** — update name, address, contact info, backup-withholding flag.
- **TIN check** — real-time IRS TIN/name matching via Tax1099 (if configured). A mismatch flags the recipient's W-9 status so it shows in the grid.
- **History** — see prior name/address values and where each came from (staff, client, W-9, import).
- **Merge** — mark a recipient as a duplicate of another; all its form records re-point to the survivor and the duplicate is tombstoned.
- **Reveal** — show the full TIN. This is **recorded in the audit log**.

## W-9 status
Each recipient shows a W-9 badge: **none**, **requested**, **on file**, or **stale**. Use **request** to send a [W-9 request](w9.md) when it's missing.

**Tips:**
- Because addresses are shared across entities, keep one canonical mailing address per contractor — that's what Copy B is mailed to for every payer.
- Run **TIN check** before filing to catch name/TIN mismatches that would otherwise come back as IRS errors.
