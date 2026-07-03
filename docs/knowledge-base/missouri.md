# Missouri (Pub 1220 direct file)

**Sidebar:** Filing & delivery → **Missouri**

**What it's for:** generating the Missouri **Pub 1220 `.txt`** file for MO-source 1099s, which you upload yourself at **mytax.mo.gov**, then track its status.

## How it works
1. Pick the **tax year** and the **payers** to include (search-and-add, or **All MO-source**).
2. Choose whether to apply the **$1,200 threshold** (default) or override to include everything.
3. **Preview counts & totals** — a per-payer table shows included vs under-threshold records, total payments, MO withheld, and flags any payer **missing its MO withholding ID**.
4. **Generate .txt file** — the app writes the Pub 1220 file from your data.
5. **Download** it and upload at mytax.mo.gov.
6. Mark the file **Uploaded**, then **Accepted** or **Rejected** as MO responds.

## Money precision
Pub 1220 money fields carry **cents with an assumed decimal**. Because the app stores amounts to the cent, they're written straight through — no rounding.

## Corrections & rejections
- If MO **rejects** a file, you can **supersede** it: fix the records and generate a new full file.
- Missouri correction rules differ from the IRS. The screen shows **MO correction guidance** (withholding vs non-withholding errors, and the portal to use).

**Tips:**
- Only records in **accepted/transmitted** status and flagged **MO-source** are included — set MO-source defaults on your [Payers](payers.md).
- Fix any "missing MO withholding ID" flags before generating, or those payers won't file cleanly.
