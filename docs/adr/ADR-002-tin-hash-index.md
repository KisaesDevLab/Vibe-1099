# ADR-002 — HMAC tin_hash index for encrypted-TIN lookup

**Status:** Accepted (Phase 1/3)
**Context:** TINs are AES-256-GCM envelope-encrypted at rest (per-record DEK wrapped by an
HKDF-derived KEK from the install `MASTER_KEY`). GCM ciphertexts are non-deterministic, so the
encrypted column cannot back a uniqueness constraint or an exact-match lookup — but the app
needs both: *lookup-as-you-type* vault matching and *unique TIN per firm*.

**Decision:** Store a second column, `tin_hash = HMAC-SHA256(normalized_tin, K_hmac)`, where
`K_hmac` is HKDF-derived from `MASTER_KEY` with the info string `vibe1099:tin-hmac:v1`
(a different derivation than the KEK — compromise of one purpose key does not expose the other).

- `UNIQUE (firm_id, tin_hash) WHERE merged_into_id IS NULL` — active-row uniqueness; merged
  tombstones keep their hash for history.
- Lookup: normalize input → HMAC → index equality. **No decryption on the lookup path.**
- The HMAC is keyed and per-install: a stolen database without the master key does not permit
  offline TIN dictionary attacks (the 9-digit TIN space is trivially enumerable with an
  unkeyed hash).

**Key rotation:** rotating `MASTER_KEY` requires re-encrypting `tin_encrypted` **and**
recomputing `tin_hash` for every row in one transaction (procedure: docs/key-rotation.md).

**Consequences:** TIN equality is the only queryable predicate (no partial-TIN search — by
design). Tests: `tests/crypto.test.ts`.
