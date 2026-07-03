# Corrections

**Sidebar:** Season → **Corrections**

**What it's for:** fixing a 1099 **after the IRS accepted it**. Before acceptance you just edit the draft; after acceptance, the only compliant way to change a form is a correction, which the app builds for you.

## When you can correct
- Only **accepted** (or accepted-with-errors) records are correctable.
- Corrections are derived from an **immutable as-filed snapshot** taken when the form was transmitted, so the app knows exactly what the IRS has on file and diffs against it.

## Type 1 vs Type 2 (the app picks the right one)
- **Type 1 — one transaction.** Used for wrong dollar amounts or similar single-record fixes. One corrected record is filed.
- **Type 2 — two transactions.** Used when identifying info was wrong (e.g. wrong TIN or recipient). The app files a **zeroing record** (voids the original) **plus a new original**, transmitted as a linked pair.

## How to file a correction
1. Find the payer and recipient (search + pagination; a **recipient picker** helps for Type 2's "new" recipient).
2. Choose what changed; the app determines Type 1 vs Type 2.
3. Enter the corrected values.
4. Queue and transmit like any other filing — the corrected records carry the **CORRECTED** indicator and link back to the original.

## Downstream effects
- A corrected form produces a new **Copy B** that recipients see marked **CORRECTED**.
- Missouri corrections follow the state's own constraints — see the guidance shown on the [Missouri](missouri.md) screen.

**Tip:** Don't try to "edit" an accepted form by other means — always come through Corrections so the as-filed snapshot and IRS linkage stay intact.
