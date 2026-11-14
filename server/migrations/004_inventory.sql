BEGIN;

-- Existing sale lines intentionally remain unlinked. Opening stock is today's physical count.
CREATE TABLE inventory_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE CHECK (length(sku) BETWEEN 1 AND 50 AND sku = upper(trim(sku))),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  size TEXT NOT NULL DEFAULT '' CHECK (length(size) <= 30),
  color TEXT NOT NULL DEFAULT '' CHECK (length(color) <= 40),
  barcode TEXT UNIQUE CHECK (barcode IS NULL OR length(barcode) BETWEEN 1 AND 80),
  selling_price NUMERIC(12,2) NOT NULL CHECK (selling_price > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock BETWEEN 0 AND 999999999),
  reorder_level INTEGER NOT NULL DEFAULT 5 CHECK (reorder_level BETWEEN 0 AND 999999999),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  create_request_key UUID NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_products_name_idx ON inventory_products (lower(name));

ALTER TABLE sale_items ADD COLUMN product_id UUID REFERENCES inventory_products(id) ON DELETE RESTRICT;
ALTER TABLE sale_items DROP CONSTRAINT sale_items_item_name_check;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_item_name_check CHECK (length(trim(item_name)) BETWEEN 1 AND 240);
CREATE INDEX sale_items_product_idx ON sale_items (product_id) WHERE product_id IS NOT NULL;

CREATE TABLE inventory_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
  sale_id UUID REFERENCES sales(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('OPENING','RECEIPT','DAMAGE','COUNT','SALE','CORRECTION','VOID')),
  quantity_delta INTEGER NOT NULL,
  stock_before INTEGER NOT NULL CHECK (stock_before BETWEEN 0 AND 999999999),
  stock_after INTEGER NOT NULL CHECK (stock_after BETWEEN 0 AND 999999999),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 300),
  actor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  request_key UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (stock_after = stock_before + quantity_delta),
  CHECK ((kind IN ('SALE','CORRECTION','VOID') AND sale_id IS NOT NULL) OR
         (kind IN ('OPENING','RECEIPT','DAMAGE','COUNT') AND sale_id IS NULL)),
  CHECK ((kind = 'SALE' AND quantity_delta < 0) OR
         (kind IN ('RECEIPT','VOID') AND quantity_delta > 0) OR
         (kind = 'DAMAGE' AND quantity_delta < 0) OR
         (kind = 'OPENING' AND quantity_delta >= 0) OR
         kind IN ('COUNT','CORRECTION'))
);
CREATE INDEX inventory_movements_product_created_idx ON inventory_movements (product_id, id DESC);
CREATE INDEX inventory_movements_sale_idx ON inventory_movements (sale_id) WHERE sale_id IS NOT NULL;

COMMIT;
