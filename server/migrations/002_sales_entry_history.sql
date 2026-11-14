BEGIN;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES profiles(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS sales_idempotency_key_unique
  ON sales (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_total_amount_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_total_amount_positive') THEN
    ALTER TABLE sales ADD CONSTRAINT sales_total_amount_positive CHECK (total_amount > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_description_length') THEN
    ALTER TABLE sales ADD CONSTRAINT sales_description_length CHECK (description IS NULL OR length(description) <= 250) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sales_voided_at_idx ON sales (voided_at) WHERE voided_at IS NOT NULL;

COMMIT;
