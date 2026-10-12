CREATE TABLE supplier_invoices_rebuilt (
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
    reversal_reason TEXT,
    reversed_at TEXT
);

INSERT INTO supplier_invoices_rebuilt
    (id, purchase_order_id, invoice_no, invoiced_on, amount_cents,
     status, revision, idempotency_key, request_hash, created_at, updated_at,
     reversal_reason, reversed_at)
SELECT id, purchase_order_id, invoice_no, invoiced_on, amount_cents,
       status, revision, idempotency_key, request_hash, created_at, updated_at,
       reversal_reason, reversed_at
FROM supplier_invoices;

CREATE TABLE supplier_invoice_allocations_rebuilt (
    supplier_invoice_id INTEGER NOT NULL
        REFERENCES supplier_invoices_rebuilt(id) ON DELETE RESTRICT,
    purchase_order_line_id INTEGER NOT NULL
        REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (supplier_invoice_id, purchase_order_line_id)
);

INSERT INTO supplier_invoice_allocations_rebuilt
    (supplier_invoice_id, purchase_order_line_id, amount_cents)
SELECT supplier_invoice_id, purchase_order_line_id, amount_cents
FROM supplier_invoice_allocations;

CREATE TABLE supplier_invoice_documents_rebuilt (
    supplier_invoice_id INTEGER NOT NULL
        REFERENCES supplier_invoices_rebuilt(id) ON DELETE RESTRICT,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (supplier_invoice_id, document_version_id)
);

INSERT INTO supplier_invoice_documents_rebuilt
    (supplier_invoice_id, document_version_id)
SELECT supplier_invoice_id, document_version_id
FROM supplier_invoice_documents;

DROP TABLE supplier_invoice_allocations;
DROP TABLE supplier_invoice_documents;
DROP TABLE supplier_invoices;

ALTER TABLE supplier_invoices_rebuilt RENAME TO supplier_invoices;
ALTER TABLE supplier_invoice_allocations_rebuilt
    RENAME TO supplier_invoice_allocations;
ALTER TABLE supplier_invoice_documents_rebuilt
    RENAME TO supplier_invoice_documents;

CREATE UNIQUE INDEX idx_supplier_invoices_active_invoice_number
    ON supplier_invoices(purchase_order_id, invoice_no)
    WHERE status = 'active';

CREATE INDEX idx_supplier_invoice_documents_version
    ON supplier_invoice_documents(document_version_id, supplier_invoice_id);
