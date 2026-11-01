ALTER TABLE procurement_lines ADD COLUMN confirmation_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (confirmation_status IN ('draft', 'confirmed'));
ALTER TABLE procurement_lines ADD COLUMN confirmed_at TEXT;

UPDATE procurement_lines
SET confirmation_status = 'confirmed',
    confirmed_at = (SELECT confirmed_at FROM procurement_lists WHERE id = procurement_list_id)
WHERE procurement_list_id IN (SELECT id FROM procurement_lists WHERE status IN ('confirmed', 'superseded'));

CREATE INDEX idx_procurement_lines_confirmation
    ON procurement_lines(procurement_list_id, confirmation_status);

ALTER TABLE quote_exports ADD COLUMN customer_company_name_snapshot TEXT;
UPDATE quote_exports SET customer_company_name_snapshot = (
    SELECT name FROM companies WHERE id = customer_company_id
);

CREATE TABLE quote_export_lines (
    id INTEGER PRIMARY KEY,
    quote_export_id INTEGER NOT NULL REFERENCES quote_exports(id) ON DELETE RESTRICT,
    procurement_line_id INTEGER NOT NULL,
    sequence_no INTEGER NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    specification TEXT,
    brand TEXT,
    model TEXT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    unit TEXT NOT NULL,
    quoted_unit_price_cents INTEGER NOT NULL CHECK (quoted_unit_price_cents >= 0),
    UNIQUE (quote_export_id, procurement_line_id)
);

INSERT INTO quote_export_lines
    (quote_export_id, procurement_line_id, sequence_no, category, name,
     specification, brand, model, quantity_milli, unit, quoted_unit_price_cents)
SELECT exports.id, lines.id, lines.sequence_no, lines.category, lines.name,
       lines.specification, lines.brand, lines.model, lines.quantity_milli,
       lines.unit, lines.quoted_unit_price_cents
FROM quote_exports AS exports
JOIN procurement_lines AS lines ON lines.procurement_list_id = exports.procurement_list_id;

CREATE TRIGGER quote_export_lines_no_update BEFORE UPDATE ON quote_export_lines
BEGIN
    SELECT RAISE(ABORT, 'quote export snapshots are immutable');
END;
CREATE TRIGGER quote_export_lines_no_delete BEFORE DELETE ON quote_export_lines
BEGIN
    SELECT RAISE(ABORT, 'quote export snapshots are immutable');
END;

-- 草稿单可替换明细，历史引用仍保留，避免移除草稿行后解锁原物料。
CREATE TABLE procurement_line_order_references (
    procurement_line_id INTEGER NOT NULL REFERENCES procurement_lines(id) ON DELETE RESTRICT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    PRIMARY KEY (procurement_line_id, purchase_order_id)
);
INSERT INTO procurement_line_order_references (procurement_line_id, purchase_order_id)
SELECT DISTINCT procurement_line_id, purchase_order_id FROM purchase_order_lines;

CREATE TRIGGER purchase_order_lines_record_procurement_reference
AFTER INSERT ON purchase_order_lines
BEGIN
    INSERT OR IGNORE INTO procurement_line_order_references (procurement_line_id, purchase_order_id)
    VALUES (NEW.procurement_line_id, NEW.purchase_order_id);
END;
CREATE TRIGGER procurement_line_order_references_no_update BEFORE UPDATE ON procurement_line_order_references
BEGIN
    SELECT RAISE(ABORT, 'procurement references are immutable');
END;
CREATE TRIGGER procurement_line_order_references_no_delete BEFORE DELETE ON procurement_line_order_references
BEGIN
    SELECT RAISE(ABORT, 'procurement references are immutable');
END;
