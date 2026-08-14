# Missouri (Pub 1220 direct file)

**Sidebar:** Filing & delivery → **Missouri**

**What it's for:** generating the Missouri **Pub 1220 `.txt`** file for MO-source 1099s, which you upload yourself at **mytax.mo.gov**, then track its status.

## When you don't need this screen

If the records were filed through an **API filing provider** (Tax1099 or TaxBandits), **the provider already filed Missouri for you** — it files federal *and* state from the same submission. Those records are automatically **excluded** from the Pub 1220 file and shown as *"already filed with Missouri by …"* in the preview, so you can never upload a duplicate return. If every MO record for a payer was provider-filed, generating is refused with a message saying Missouri already has them.

This screen is for the records Missouri still needs from you directly — chiefly **IRIS A2A** filings, because Missouri is not a Combined Federal/State Filing participant, so the IRS does not forward MO returns. Records filed before this behaviour shipped (v0.1.21) are treated as *not* provider-filed and still appear here; check them against your provider's filing history before uploading.

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
- The "already filed with Missouri" exclusion is **absolute** — overriding the $1,200 threshold cannot pull a provider-filed record back into the file.
