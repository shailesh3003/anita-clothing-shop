BEGIN;

CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number BETWEEN 0 AND 99),
  item_name TEXT NOT NULL CHECK (length(trim(item_name)) BETWEEN 1 AND 120),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999999),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sale_id, line_number)
);

CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx ON sale_items (sale_id, line_number);

COMMIT;
