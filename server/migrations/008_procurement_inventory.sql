CREATE TABLE inventory_items (
    id INTEGER PRIMARY KEY,
    brand TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    model TEXT,
    specification TEXT,
    unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
    notes TEXT,
    quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK (quantity_milli >= 0),
    inventory_value_cents INTEGER NOT NULL DEFAULT 0
        CHECK (inventory_value_cents >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    create_idempotency_key TEXT NOT NULL UNIQUE,
    create_request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (quantity_milli > 0 OR inventory_value_cents = 0)
);

CREATE TABLE procurement_lists (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'confirmed', 'superseded')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    create_idempotency_key TEXT NOT NULL UNIQUE,
    create_request_hash TEXT NOT NULL,
    confirm_idempotency_key TEXT UNIQUE,
    confirm_request_hash TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (status = 'draft' AND confirmed_at IS NULL)
        OR (status IN ('confirmed', 'superseded') AND confirmed_at IS NOT NULL)
    )
);

CREATE TABLE procurement_lines (
    id INTEGER PRIMARY KEY,
    procurement_list_id INTEGER NOT NULL
        REFERENCES procurement_lists(id) ON DELETE CASCADE,
    inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE RESTRICT,
    sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
    category TEXT NOT NULL CHECK (length(trim(category)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    specification TEXT,
    brand TEXT,
    model TEXT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
    unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    quoted_unit_price_cents INTEGER NOT NULL
        CHECK (quoted_unit_price_cents >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    create_idempotency_key TEXT NOT NULL UNIQUE,
    create_request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (procurement_list_id, sequence_no)
);

CREATE TABLE procurement_imports (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'confirmed', 'expired')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    expires_at TEXT NOT NULL,
    confirmed_list_id INTEGER REFERENCES procurement_lists(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, sha256, status)
);

CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    order_no TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(order_no)) > 0),
    supplier_company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE RESTRICT,
    ordered_on TEXT NOT NULL,
    expected_delivery_on TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            status IN (
                'draft', 'confirmed', 'partially_received',
                'received', 'cancelled'
            )
        ),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    create_idempotency_key TEXT NOT NULL UNIQUE,
    create_request_hash TEXT NOT NULL,
    confirm_idempotency_key TEXT UNIQUE,
    confirm_request_hash TEXT,
    confirmed_at TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, order_no)
);

CREATE TABLE purchase_order_documents (
    purchase_order_id INTEGER NOT NULL
        REFERENCES purchase_orders(id) ON DELETE CASCADE,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (purchase_order_id, document_version_id)
);

CREATE TABLE purchase_order_lines (
    id INTEGER PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL
        REFERENCES purchase_orders(id) ON DELETE CASCADE,
    procurement_line_id INTEGER NOT NULL
        REFERENCES procurement_lines(id) ON DELETE RESTRICT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    received_quantity_milli INTEGER NOT NULL DEFAULT 0
        CHECK (
            received_quantity_milli >= 0
            AND received_quantity_milli <= quantity_milli
        ),
    unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
    overage_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (purchase_order_id, procurement_line_id)
);

CREATE TABLE goods_receipts (
    id INTEGER PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL
        REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    received_on TEXT NOT NULL,
    warehouse_name TEXT NOT NULL CHECK (length(trim(warehouse_name)) > 0),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reversed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE inventory_issues (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    issued_on TEXT NOT NULL,
    worker_id INTEGER,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reversed')),
    total_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_cents >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE inventory_adjustments (
    id INTEGER PRIMARY KEY,
    inventory_item_id INTEGER NOT NULL
        REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity_delta_milli INTEGER NOT NULL CHECK (quantity_delta_milli != 0),
    unit_cost_cents INTEGER CHECK (unit_cost_cents >= 0),
    value_delta_cents INTEGER NOT NULL,
    occurred_on TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    movement_id INTEGER UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE inventory_movements (
    id INTEGER PRIMARY KEY,
    inventory_item_id INTEGER NOT NULL
        REFERENCES inventory_items(id) ON DELETE RESTRICT,
    project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
    procurement_line_id INTEGER
        REFERENCES procurement_lines(id) ON DELETE RESTRICT,
    movement_type TEXT NOT NULL
        CHECK (
            movement_type IN (
                'opening', 'adjustment', 'goods_receipt',
                'project_issue', 'reversal'
            )
        ),
    quantity_delta_milli INTEGER NOT NULL CHECK (quantity_delta_milli != 0),
    value_delta_cents INTEGER NOT NULL,
    quantity_after_milli INTEGER NOT NULL CHECK (quantity_after_milli >= 0),
    value_after_cents INTEGER NOT NULL CHECK (value_after_cents >= 0),
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL CHECK (source_id > 0),
    occurred_on TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    CHECK (quantity_after_milli > 0 OR value_after_cents = 0)
);

CREATE TABLE goods_receipt_lines (
    id INTEGER PRIMARY KEY,
    goods_receipt_id INTEGER NOT NULL
        REFERENCES goods_receipts(id) ON DELETE RESTRICT,
    purchase_order_line_id INTEGER NOT NULL
        REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    inventory_item_id INTEGER NOT NULL
        REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
    movement_id INTEGER NOT NULL UNIQUE
        REFERENCES inventory_movements(id) ON DELETE RESTRICT,
    UNIQUE (goods_receipt_id, purchase_order_line_id)
);

CREATE TABLE inventory_issue_lines (
    id INTEGER PRIMARY KEY,
    inventory_issue_id INTEGER NOT NULL
        REFERENCES inventory_issues(id) ON DELETE RESTRICT,
    inventory_item_id INTEGER NOT NULL
        REFERENCES inventory_items(id) ON DELETE RESTRICT,
    procurement_line_id INTEGER
        REFERENCES procurement_lines(id) ON DELETE RESTRICT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
    movement_id INTEGER NOT NULL UNIQUE
        REFERENCES inventory_movements(id) ON DELETE RESTRICT
);

CREATE TABLE supplier_payments (
    id INTEGER PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL
        REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    paid_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    payment_method TEXT NOT NULL,
    reference_no TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reversed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE supplier_payment_allocations (
    supplier_payment_id INTEGER NOT NULL
        REFERENCES supplier_payments(id) ON DELETE RESTRICT,
    purchase_order_line_id INTEGER NOT NULL
        REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (supplier_payment_id, purchase_order_line_id)
);

CREATE TABLE supplier_invoices (
    id INTEGER PRIMARY KEY,
    purchase_order_id INTEGER NOT NULL
        REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    invoice_no TEXT NOT NULL,
    invoiced_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'reversed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (purchase_order_id, invoice_no)
);

CREATE TABLE supplier_invoice_allocations (
    supplier_invoice_id INTEGER NOT NULL
        REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
    purchase_order_line_id INTEGER NOT NULL
        REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (supplier_invoice_id, purchase_order_line_id)
);

CREATE TABLE quote_exports (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    procurement_list_id INTEGER NOT NULL
        REFERENCES procurement_lists(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    customer_company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE RESTRICT,
    notes TEXT,
    document_version_id INTEGER
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TRIGGER inventory_movements_no_update
BEFORE UPDATE ON inventory_movements
BEGIN
    SELECT RAISE(ABORT, 'inventory movements are immutable');
END;

CREATE TRIGGER inventory_movements_no_delete
BEFORE DELETE ON inventory_movements
BEGIN
    SELECT RAISE(ABORT, 'inventory movements are immutable');
END;

CREATE INDEX idx_procurement_lists_project_status
    ON procurement_lists(project_id, status, created_at DESC, id DESC);

CREATE INDEX idx_procurement_lines_list_sequence
    ON procurement_lines(procurement_list_id, sequence_no, id);

CREATE INDEX idx_purchase_orders_project_status
    ON purchase_orders(project_id, status, ordered_on DESC, id DESC);

CREATE INDEX idx_purchase_order_lines_procurement
    ON purchase_order_lines(procurement_line_id, purchase_order_id);

CREATE INDEX idx_inventory_items_search
    ON inventory_items(name COLLATE NOCASE, brand COLLATE NOCASE, model COLLATE NOCASE);

CREATE INDEX idx_inventory_movements_item_created
    ON inventory_movements(inventory_item_id, created_at DESC, id DESC);

CREATE INDEX idx_inventory_movements_project
    ON inventory_movements(project_id, movement_type, created_at DESC, id DESC);

CREATE INDEX idx_inventory_issue_lines_procurement
    ON inventory_issue_lines(procurement_line_id, inventory_issue_id);
