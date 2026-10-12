ALTER TABLE purchase_orders
ADD COLUMN tax_rate_bps INTEGER
    CHECK (tax_rate_bps IS NULL OR (
        typeof(tax_rate_bps) = 'integer' AND tax_rate_bps BETWEEN 0 AND 10000
    ));

ALTER TABLE purchase_order_lines
ADD COLUMN tax_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(tax_amount_cents) = 'integer' AND tax_amount_cents >= 0);
