CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE RESTRICT,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'sent', 'accepted', 'rejected', 'withdrawn')
    ),
    quote_date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    valid_until TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, version_number),
    CHECK (valid_until IS NULL OR quote_date <= valid_until)
);

CREATE TABLE quote_document_versions (
    quote_id INTEGER NOT NULL
        REFERENCES quotes(id) ON DELETE CASCADE,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (quote_id, document_version_id)
);

CREATE TABLE contracts (
    id INTEGER PRIMARY KEY,
    contract_no TEXT NOT NULL COLLATE NOCASE UNIQUE,
    title TEXT NOT NULL,
    customer_company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'signed', 'completed', 'terminated')
    ),
    signed_on TEXT,
    total_amount_cents INTEGER NOT NULL CHECK (total_amount_cents >= 0),
    final_delivery_on TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        status NOT IN ('signed', 'completed')
        OR (signed_on IS NOT NULL AND final_delivery_on IS NOT NULL)
    )
);

CREATE TABLE contract_project_allocations (
    id INTEGER PRIMARY KEY,
    contract_id INTEGER NOT NULL
        REFERENCES contracts(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    UNIQUE (contract_id, project_id),
    UNIQUE (id, project_id)
);

CREATE TABLE contract_document_versions (
    contract_id INTEGER NOT NULL
        REFERENCES contracts(id) ON DELETE CASCADE,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    PRIMARY KEY (contract_id, document_version_id)
);

CREATE TABLE payment_terms (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE RESTRICT,
    milestone TEXT NOT NULL CHECK (milestone IN ('advance', 'progress', 'final')),
    due_on TEXT,
    planned_amount_cents INTEGER NOT NULL CHECK (planned_amount_cents >= 0),
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, milestone)
);

CREATE TABLE receipts (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE RESTRICT,
    contract_allocation_id INTEGER,
    milestone TEXT NOT NULL CHECK (milestone IN ('advance', 'progress', 'final')),
    received_on TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    payment_method TEXT NOT NULL CHECK (
        payment_method IN ('bank_transfer', 'cash', 'other')
    ),
    reference_no TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
    voided_on TEXT,
    void_reason TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (contract_allocation_id, project_id)
        REFERENCES contract_project_allocations(id, project_id)
        ON DELETE RESTRICT,
    CHECK (
        (status = 'active' AND voided_on IS NULL AND void_reason IS NULL)
        OR (
            status = 'voided'
            AND voided_on IS NOT NULL
            AND void_reason IS NOT NULL
            AND length(trim(void_reason)) > 0
        )
    )
);
