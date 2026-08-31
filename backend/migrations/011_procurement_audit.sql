CREATE TABLE supplier_invoice_documents (
    supplier_invoice_id INTEGER NOT NULL
        REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (supplier_invoice_id, document_version_id)
);

ALTER TABLE supplier_payments ADD COLUMN reversal_reason TEXT;
ALTER TABLE supplier_payments ADD COLUMN reversed_at TEXT;

ALTER TABLE supplier_invoices ADD COLUMN reversal_reason TEXT;
ALTER TABLE supplier_invoices ADD COLUMN reversed_at TEXT;

ALTER TABLE goods_receipts ADD COLUMN reversal_reason TEXT;
ALTER TABLE goods_receipts ADD COLUMN reversed_at TEXT;

CREATE INDEX idx_supplier_invoice_documents_version
    ON supplier_invoice_documents(document_version_id, supplier_invoice_id);
