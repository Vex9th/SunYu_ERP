CREATE TABLE workers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
    phone TEXT CHECK (phone IS NULL OR (phone = trim(phone) AND length(phone) > 0)),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
    inactive_on TEXT,
    inactive_reason TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (status = 'active' AND inactive_on IS NULL AND inactive_reason IS NULL)
        OR
        (status = 'inactive' AND inactive_on IS NOT NULL
         AND inactive_reason IS NOT NULL AND length(trim(inactive_reason)) > 0)
    )
);

CREATE TABLE crew_assignments (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role = trim(role) AND length(role) > 0),
    scheduled_start_on TEXT NOT NULL,
    scheduled_end_on TEXT,
    pay_basis TEXT NOT NULL CHECK (pay_basis IN ('daily', 'hourly')),
    rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (scheduled_end_on IS NULL OR scheduled_end_on >= scheduled_start_on)
);

CREATE TABLE labor_entries (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    assignment_id INTEGER NOT NULL
        REFERENCES crew_assignments(id) ON DELETE RESTRICT,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
    work_date TEXT NOT NULL,
    attendance_status TEXT NOT NULL
        CHECK (attendance_status IN ('present', 'absent', 'leave')),
    day_fraction_milli INTEGER,
    work_minutes INTEGER,
    pay_basis TEXT NOT NULL CHECK (pay_basis IN ('daily', 'hourly')),
    rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
    cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
    work_summary TEXT CHECK (
        work_summary IS NULL OR length(trim(work_summary)) > 0
    ),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (assignment_id, work_date),
    UNIQUE (project_id, worker_id, work_date),
    CHECK (
        (
            attendance_status = 'present'
            AND pay_basis = 'daily'
            AND day_fraction_milli BETWEEN 1 AND 1000
            AND work_minutes IS NULL
        )
        OR
        (
            attendance_status = 'present'
            AND pay_basis = 'hourly'
            AND day_fraction_milli IS NULL
            AND work_minutes BETWEEN 1 AND 1440
        )
        OR
        (
            attendance_status IN ('absent', 'leave')
            AND day_fraction_milli IS NULL
            AND work_minutes IS NULL
            AND cost_cents = 0
        )
    ),
    CHECK (
        (status = 'active' AND void_reason IS NULL AND voided_at IS NULL)
        OR
        (status = 'voided' AND void_reason IS NOT NULL AND voided_at IS NOT NULL)
    )
);

CREATE TABLE site_daily_reports (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    work_date TEXT NOT NULL,
    location TEXT,
    weather TEXT,
    work_summary TEXT,
    blockers TEXT,
    next_plan TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'confirmed')),
    confirmed_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, work_date),
    CHECK (
        (status = 'draft' AND confirmed_at IS NULL)
        OR (status = 'confirmed' AND confirmed_at IS NOT NULL)
    )
);

CREATE TABLE material_advances (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
    spent_on TEXT NOT NULL,
    vendor_name TEXT,
    total_amount_cents INTEGER NOT NULL CHECK (total_amount_cents >= 0),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE material_advance_items (
    id INTEGER PRIMARY KEY,
    advance_id INTEGER NOT NULL
        REFERENCES material_advances(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
    specification TEXT,
    brand TEXT,
    quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
    unit TEXT NOT NULL CHECK (unit = trim(unit) AND length(unit) > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    line_amount_cents INTEGER NOT NULL CHECK (line_amount_cents >= 0),
    UNIQUE (advance_id, line_number)
);

CREATE TABLE advance_reimbursements (
    id INTEGER PRIMARY KEY,
    advance_id INTEGER NOT NULL
        REFERENCES material_advances(id) ON DELETE RESTRICT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reimbursed_on TEXT NOT NULL,
    payment_method TEXT NOT NULL
        CHECK (payment_method IN ('bank_transfer', 'cash', 'other')),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'voided')),
    void_reason TEXT,
    voided_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE drawing_signoffs (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    discipline TEXT NOT NULL CHECK (discipline IN ('mechanical', 'electrical')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'not_required')),
    confirmed_on TEXT,
    not_required_reason TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, discipline),
    CHECK (
        (status = 'pending' AND confirmed_on IS NULL AND not_required_reason IS NULL)
        OR (status = 'confirmed' AND confirmed_on IS NOT NULL
            AND not_required_reason IS NULL)
        OR (status = 'not_required' AND confirmed_on IS NULL
            AND not_required_reason IS NOT NULL
            AND length(trim(not_required_reason)) > 0)
    )
);

CREATE TABLE commissioning_sessions (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('planned', 'in_progress', 'blocked', 'completed', 'cancelled')),
    summary TEXT,
    issues TEXT,
    next_action TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE engineering_changes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    change_number INTEGER NOT NULL CHECK (change_number > 0),
    source TEXT NOT NULL CHECK (
        source IN ('commissioning', 'customer_request', 'site_condition',
                   'technical_agreement', 'other')
    ),
    title TEXT NOT NULL CHECK (title = trim(title) AND length(title) > 0),
    description TEXT NOT NULL CHECK (length(trim(description)) > 0),
    reason TEXT,
    contract_delta_cents INTEGER NOT NULL DEFAULT 0,
    estimated_cost_delta_cents INTEGER NOT NULL DEFAULT 0,
    schedule_delta_days INTEGER NOT NULL DEFAULT 0,
    proposed_on TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'approved', 'rejected', 'implemented', 'cancelled')),
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, change_number)
);

CREATE TABLE acceptances (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    acceptance_type TEXT NOT NULL
        CHECK (acceptance_type IN ('pre_acceptance', 'final', 'reinspection')),
    scheduled_on TEXT NOT NULL,
    performed_on TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'passed', 'passed_with_punch', 'failed', 'cancelled')),
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (status = 'scheduled' AND performed_on IS NULL)
        OR (status <> 'scheduled' AND performed_on IS NOT NULL)
    )
);

CREATE TABLE warranties (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    acceptance_id INTEGER NOT NULL UNIQUE
        REFERENCES acceptances(id) ON DELETE RESTRICT,
    starts_on TEXT NOT NULL,
    duration_months INTEGER NOT NULL CHECK (duration_months BETWEEN 1 AND 240),
    ends_on TEXT NOT NULL CHECK (ends_on >= starts_on),
    renewal_price_cents INTEGER CHECK (renewal_price_cents IS NULL OR renewal_price_cents >= 0),
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id)
);

CREATE TABLE project_invoices (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    invoice_type TEXT NOT NULL CHECK (
        invoice_type IN ('contract_payment', 'additional_work',
                         'warranty_service', 'other')
    ),
    status TEXT NOT NULL
        CHECK (status IN ('planned', 'requested', 'recorded', 'void')),
    requested_on TEXT,
    recorded_on TEXT,
    invoice_number TEXT,
    amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
    counterparty_name TEXT,
    notes TEXT,
    void_reason TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE after_sales_cases (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    reported_on TEXT NOT NULL,
    service_on TEXT,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    contact_name TEXT,
    contact_phone TEXT,
    coverage_type TEXT NOT NULL CHECK (coverage_type IN ('warranty', 'paid', 'goodwill')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
    resolution TEXT,
    completed_at TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (status = 'completed' AND completed_at IS NOT NULL
         AND resolution IS NOT NULL AND length(trim(resolution)) > 0)
        OR status <> 'completed'
    )
);

CREATE TABLE workforce_document_links (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    resource_type TEXT NOT NULL CHECK (
        resource_type IN ('material_advance', 'drawing_signoff',
                          'commissioning_session', 'engineering_change',
                          'acceptance', 'invoice', 'after_sales')
    ),
    resource_id INTEGER NOT NULL,
    document_version_id INTEGER NOT NULL
        REFERENCES document_versions(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    UNIQUE (resource_type, resource_id, document_version_id)
);

CREATE INDEX idx_workers_status_name ON workers(status, name COLLATE NOCASE, id);
CREATE INDEX idx_assignments_project_status
    ON crew_assignments(project_id, status, scheduled_start_on, id);
CREATE INDEX idx_assignments_worker ON crew_assignments(worker_id, project_id, id);
CREATE INDEX idx_labor_project_date
    ON labor_entries(project_id, work_date DESC, id DESC);
CREATE INDEX idx_labor_worker_date
    ON labor_entries(worker_id, work_date DESC, id DESC);
CREATE INDEX idx_daily_reports_project_date
    ON site_daily_reports(project_id, work_date DESC, id DESC);
CREATE INDEX idx_advances_project_date
    ON material_advances(project_id, spent_on DESC, id DESC);
CREATE INDEX idx_commissioning_project_status
    ON commissioning_sessions(project_id, status, started_at DESC, id DESC);
CREATE INDEX idx_changes_project_status
    ON engineering_changes(project_id, status, proposed_on DESC, id DESC);
CREATE INDEX idx_acceptances_project_date
    ON acceptances(project_id, scheduled_on DESC, id DESC);
CREATE INDEX idx_invoices_project_status
    ON project_invoices(project_id, status, id DESC);
CREATE INDEX idx_after_sales_project_status
    ON after_sales_cases(project_id, status, reported_on DESC, id DESC);
