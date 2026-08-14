-- Transmissions carry their payer so the transmissions screen can identify
-- rows even after a rejection unlinks the form records. Backfill from any
-- still-linked record; fully-unlinked historical rows stay NULL (shown as —).
ALTER TABLE transmissions ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES payers(id);

UPDATE transmissions t
SET payer_id = f.payer_id
FROM (
  SELECT DISTINCT ON (transmission_id) transmission_id, payer_id
  FROM form_records
  WHERE transmission_id IS NOT NULL
) f
WHERE f.transmission_id = t.id AND t.payer_id IS NULL;

CREATE INDEX IF NOT EXISTS transmissions_payer_idx ON transmissions (payer_id);
