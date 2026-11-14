BEGIN;
CREATE TABLE sale_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  return_date DATE NOT NULL,
  settlement_method TEXT NOT NULL CHECK (settlement_method IN ('CASH','UPI','CARD','OTHER')),
  credit_amount NUMERIC(12,2) NOT NULL CHECK (credit_amount >= 0),
  cost_reversal NUMERIC(24,2) CHECK (cost_reversal IS NULL OR cost_reversal >= 0),
  replacement_sale_id UUID UNIQUE REFERENCES sales(id) ON DELETE RESTRICT,
  settlement_amount NUMERIC(12,2) NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 300),
  request_key UUID NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sale_returns_sale_idx ON sale_returns (sale_id);
CREATE INDEX sale_returns_date_idx ON sale_returns (return_date);
CREATE TABLE sale_return_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id UUID NOT NULL REFERENCES sale_returns(id) ON DELETE RESTRICT,
  sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999999),
  condition TEXT NOT NULL CHECK (condition IN ('SELLABLE','DAMAGED','QUARANTINE')),
  unit_refund NUMERIC(12,2) NOT NULL CHECK (unit_refund >= 0),
  unit_cost NUMERIC(18,6) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  UNIQUE (return_id,sale_item_id)
);
CREATE INDEX sale_return_items_sale_item_idx ON sale_return_items (sale_item_id);
ALTER TABLE inventory_movements ADD COLUMN return_id UUID REFERENCES sale_returns(id) ON DELETE RESTRICT;
CREATE INDEX inventory_movements_return_idx ON inventory_movements (return_id) WHERE return_id IS NOT NULL;
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='inventory_movements'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP EXECUTE format('ALTER TABLE inventory_movements DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movement_kind CHECK (kind IN ('OPENING','RECEIPT','DAMAGE','COUNT','SALE','CORRECTION','VOID','RETURN_SELLABLE','RETURN_DAMAGED','RETURN_QUARANTINE')),
  ADD CONSTRAINT inventory_movement_source CHECK (
    (kind IN ('SALE','CORRECTION','VOID','RETURN_SELLABLE','RETURN_DAMAGED','RETURN_QUARANTINE') AND sale_id IS NOT NULL) OR
    (kind IN ('OPENING','RECEIPT','DAMAGE','COUNT') AND sale_id IS NULL)),
  ADD CONSTRAINT inventory_movement_direction CHECK (
    (kind='SALE' AND quantity_delta<0) OR (kind IN ('RECEIPT','VOID','RETURN_SELLABLE') AND quantity_delta>0) OR
    (kind='DAMAGE' AND quantity_delta<0) OR (kind='OPENING' AND quantity_delta>=0) OR
    (kind IN ('RETURN_DAMAGED','RETURN_QUARANTINE') AND quantity_delta=0) OR kind IN ('COUNT','CORRECTION')),
  ADD CONSTRAINT inventory_movement_return_source CHECK (kind NOT IN ('RETURN_SELLABLE','RETURN_DAMAGED','RETURN_QUARANTINE') OR return_id IS NOT NULL);
COMMIT;
