# ADR-001 — Money is stored as integer cents

**Status:** Accepted (Phase 1)
**Context:** The wider Vibe suite stores money as whole dollars. Vibe 1099 cannot:

- **MO Pub 1220** money fields carry **cents with an assumed decimal and no rounding**
  (a payment of $12,500.00 is written `000001250000` in a 12-character field). Whole-dollar
  storage would force lossy reconstruction.
- **IRIS XML** amount elements carry decimal values (`12500.00`). Cents must survive round-trips.
- 1099-INT/DIV amounts routinely carry cents (interest of $1,525.75 is normal).

**Decision:** Every money value in this app — `form_records.box_values`, K-record totals,
report totals — is an **integer number of cents**. Serialization is explicit and one-way at the
boundary:

- UI input → `parseCents()` (`packages/shared/src/money.ts`)
- IRIS XML → `centsToDecimalString()` → `"12500.00"`
- Pub 1220 → `centsToPub1220()` → `"000001250000"` (unsigned, right-justified, zero-filled)
- Display → `formatCents()` / `formatUsd()`

Floats are never used for money. Validation rejects non-integer cent values (`E_NOT_CENTS`).

**Consequences:** Any future cross-app data exchange with whole-dollar Vibe apps must convert
at the boundary and document rounding. Tests: `tests/money.test.ts`, `tests/mo1220.golden.test.ts`.
