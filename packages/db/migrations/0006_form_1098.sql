-- Form 1098 (Mortgage Interest Statement) support: widen the form_records
-- form_type CHECK to admit '1098' alongside the 1099 income forms.

ALTER TABLE form_records DROP CONSTRAINT IF EXISTS form_records_form_type_check;
ALTER TABLE form_records
  ADD CONSTRAINT form_records_form_type_check CHECK (form_type IN ('NEC', 'MISC', 'INT', 'DIV', '1098'));
