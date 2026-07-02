# MO Pub 1220 layout — implemented field positions

Implementation: `packages/core/src/mo1220/writer.ts` · position-asserted golden tests:
`tests/mo1220.golden.test.ts`. Fixed 750-char records, CR/LF, uppercase ASCII. **Money fields
carry cents with an assumed decimal and no rounding** (ADR-001). Record sequence
`T → (A → B×n → C → K)×group → F`, one group per payer × form type. Sequence number: 500–507
on every record.

## T (transmitter)
| pos | field |
|---|---|
| 1 | 'T' |
| 2–5 | payment year |
| 6 | prior-year indicator 'P' |
| 7–15 | transmitter TIN |
| 28 | test-file indicator 'T' |
| 30–69 | transmitter name |
| 110–149 | company name |
| 190–229 | address |
| 230–269 | city |
| 270–271 | state |
| 272–280 | ZIP |
| 296–303 | total payees (right-just, zero-fill) |
| 304–343 | contact name |
| 344–358 | contact phone |
| 359–408 | contact email |
| 518 | vendor indicator 'I' (in-house) |

## A (payer, per form type)
| pos | field |
|---|---|
| 1 | 'A' · 2–5 year · 6 CF/SF flag '1' |
| 12–20 | payer TIN |
| 21–24 | name control |
| 26–27 | type of return (NEC='NE', MISC='A ', INT='6 ', DIV='1 ') |
| 28–43 | amount codes (derived from registry `moAmountCode`s, digits then letters) |
| 53–92 | payer name · 134–173 address · 174–213 city · 214–215 state · 216–224 ZIP · 225–239 phone |
| 715–728 | **MO withholding ID** (state-defined block — confirm against current MO handbook) |

## B (payee)
| pos | field |
|---|---|
| 1 | 'B' · 2–5 year · 6 corrected (G/C) |
| 7–10 | name control · 11 TIN type (1=EIN, 2=SSN) · 12–20 TIN |
| 21–40 | account number |
| 55–270 | payment amounts, 12 chars each, **fixed position per amount code**: 1→55, 2→67, 3→79, 4→91, 5→103, 6→115, 7→127, 8→139, 9→151, A→163, B→175, C→187, D→199, E→211, F→223, G→235, H→247, J→259 |
| 288–327 | payee name 1 · 328–367 name 2 |
| 368–407 | address · 448–487 city · 488–489 state · 490–498 ZIP |
| 723–734 | state income tax withheld (cents) |
| 747–748 | CF/SF state code — Missouri = **26** |

## C (payer totals) / K (Missouri state totals)
| pos | field |
|---|---|
| 2–9 | payee count |
| 16–339 | control totals, 18 chars each, one slot per amount code in the fixed order above (16 + slot×18) |
| K 707–724 | state income tax withheld total |
| K 725–742 | local income tax withheld total (zero) |
| K 745–746 | state code 26 |

## F (end)
| pos | field |
|---|---|
| 2–9 | number of A records · 10–30 zeros · 50–57 total payees |

Scoping: `form_records.mo_source = true`, statuses accepted/transmitted, **$1,200 threshold**
(`states_config.threshold_cents`, override available; any state withholding is always included).
MO rejects whole files — the regenerate flow marks the rejected file `superseded`.
