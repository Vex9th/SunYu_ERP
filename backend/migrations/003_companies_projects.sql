CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (name = trim(name) AND length(name) > 0),
    taxpayer_id TEXT
        CHECK (
            taxpayer_id IS NULL
            OR (taxpayer_id = trim(taxpayer_id) AND length(taxpayer_id) > 0)
        ),
    registered_address TEXT
        CHECK (
            registered_address IS NULL
            OR (
                registered_address = trim(registered_address)
                AND length(registered_address) > 0
            )
        ),
    registered_phone TEXT
        CHECK (
            registered_phone IS NULL
            OR (
                registered_phone = trim(registered_phone)
                AND length(registered_phone) > 0
            )
        ),
    bank_name TEXT
        CHECK (
            bank_name IS NULL
            OR (bank_name = trim(bank_name) AND length(bank_name) > 0)
        ),
    bank_account TEXT
        CHECK (
            bank_account IS NULL
            OR (bank_account = trim(bank_account) AND length(bank_account) > 0)
        ),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
    phone TEXT
        CHECK (
            phone IS NULL
            OR (phone = trim(phone) AND length(phone) > 0)
        ),
    email TEXT
        CHECK (
            email IS NULL
            OR (email = trim(email) AND length(email) > 0)
        ),
    position TEXT
        CHECK (
            position IS NULL
            OR (position = trim(position) AND length(position) > 0)
        ),
    notes TEXT CHECK (notes IS NULL OR length(trim(notes)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    project_code TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (
            project_code = trim(project_code)
            AND length(project_code) > 0
            AND length(CAST(project_code AS BLOB)) <= 120
            AND project_code NOT IN ('.', '..')
            AND instr(project_code, '/') = 0
            AND instr(project_code, char(92)) = 0
        ),
    company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
    description TEXT
        CHECK (description IS NULL OR length(trim(description)) > 0),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    archive_reason TEXT
        CHECK (archive_reason IS NULL OR length(trim(archive_reason)) > 0),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (
            status = 'active'
            AND archived_at IS NULL
            AND archive_reason IS NULL
        )
        OR (status = 'archived' AND archived_at IS NOT NULL)
    )
);

CREATE INDEX idx_contacts_company ON contacts(company_id, id);

CREATE INDEX idx_projects_company ON projects(company_id, id);

CREATE INDEX idx_projects_status_created
    ON projects(status, created_at DESC, id DESC);
