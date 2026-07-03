# Recipients (the vault)

**Sidebar:** People → **Recipients**

**What it's for:** the firm-wide **vault** of contractors and vendors. One recipient record holds a person/company's name, address, and tax ID, and can be reused across many payers and years.

## One record, many entities
A recipient is stored **once per firm**, keyed by their tax ID. If the same contractor is paid by three of your client entities, that's **one** vault record linked to three payers through their form records — never a duplicate. Editing the recipient's address updates it everywhere it's used.

## Adding & finding recipients
- **+ Add recipient** — as you type a 9-digit TIN, the app does a **lookup**: if the vault already has that TIN, it offers to reuse the existing record instead of creating a duplicate.
- **Search** by name or last-4 of TIN, and **filter** by: missing address, no email/mobile, no W-9, stale W-9, or backup withholding.
- **CSV import** — bulk-load recipients (`tin,tinType,name1,name2,line1,line2,city,state,zip,email,mobile`) with a dedupe-by-TIN preview.

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
