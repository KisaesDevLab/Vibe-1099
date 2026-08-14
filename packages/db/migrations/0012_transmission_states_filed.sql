-- Which state returns a transmission actually filed, so the state direct-file
-- paths (MO Pub 1220 today) can stand down for records a provider already
-- state-filed instead of filing the same return a second time.
--
-- Semantics: for Tax1099/TaxBandits the provider files the state directly, so
-- this is every state code present on the submitted records. For IRIS the IRS
-- only forwards states in the CF/SF election, so it is the elected states the
-- records actually touch. NULL = unknown (rows written before this migration);
-- those are treated as "not state-filed" to preserve today's behaviour.
ALTER TABLE transmissions ADD COLUMN IF NOT EXISTS states_filed jsonb;
