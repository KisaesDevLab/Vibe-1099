# Payers

**Sidebar:** People → **Payers**

**What it's for:** managing the businesses (entities/issuers) you file 1099s for. A payer holds the legal name, tax ID, address, and filing preferences that print on every form.

## Adding a payer
Click **+ Add payer** and fill in:
- **Legal name** and optional **DBA**.
- **TIN** (EIN or SSN) — stored encrypted, shown masked afterward.
- **Address** and **phone**.
- **MO withholding ID** and **MO-source default** (for Missouri filers).
- **Default form types** — presets the form types offered on invites and the grid.
- **Filing backend** — *Firm default*, or override this payer to **IRIS** (self-file) or **Tax1099** (managed). See [IRS transmissions](filing-irs-and-tax1099.md).

## Importing many at once
Use **Payer CSV import** to onboard a whole book of business. Paste rows with a header line:
```
legalName,dbaName,tin,tinType,line1,line2,city,state,zip,phone,contactEmail,contactMobile,moWithholdingId,defaultFormTypes
```
- `defaultFormTypes` accepts a `|`-separated list, e.g. `NEC|MISC`.
- Import **dedupes by legal name**, so re-running won't create duplicates.

## The list
- **Search** by name and page through large books.
- Each payer shows a masked TIN; the full TIN is only revealed where filing requires it.
- Edit a payer to change contact info, MO settings, or its filing backend.

**Tips:**
- Set the **filing backend override** on payers whose clients don't want you (or them) to obtain an IRS TCC — route just those to Tax1099 while everyone else self-files via IRIS.
- The payer's **address and phone** are what recipients see as the payer block on Copy B, so keep them current.
