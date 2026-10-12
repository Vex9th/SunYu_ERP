CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (
            name = trim(
                name,
                char(9) || char(10) || char(11) || char(12) || char(13) || ' '
            )
            AND length(name) > 0
        ),
    taxpayer_id TEXT
        CHECK (
            taxpayer_id IS NULL
            OR (
                taxpayer_id = trim(
                    taxpayer_id,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(taxpayer_id) > 0
            )
        ),
    registered_address TEXT
        CHECK (
            registered_address IS NULL
            OR (
                registered_address = trim(
                    registered_address,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(registered_address) > 0
            )
        ),
    registered_phone TEXT
        CHECK (
            registered_phone IS NULL
            OR (
                registered_phone = trim(
                    registered_phone,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(registered_phone) > 0
            )
        ),
    bank_name TEXT
        CHECK (
            bank_name IS NULL
            OR (
                bank_name = trim(
                    bank_name,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(bank_name) > 0
            )
        ),
    bank_account TEXT
        CHECK (
            bank_account IS NULL
            OR (
                bank_account = trim(
                    bank_account,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(bank_account) > 0
            )
        ),
    notes TEXT
        CHECK (
            notes IS NULL
            OR length(
                trim(
                    notes,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
            ) > 0
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL
        CHECK (
            name = trim(
                name,
                char(9) || char(10) || char(11) || char(12) || char(13) || ' '
            )
            AND length(name) > 0
        ),
    phone TEXT
        CHECK (
            phone IS NULL
            OR (
                phone = trim(
                    phone,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(phone) > 0
            )
        ),
    email TEXT
        CHECK (
            email IS NULL
            OR (
                email = trim(
                    email,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(email) > 0
            )
        ),
    position TEXT
        CHECK (
            position IS NULL
            OR (
                position = trim(
                    position,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(position) > 0
            )
        ),
    notes TEXT
        CHECK (
            notes IS NULL
            OR length(
                trim(
                    notes,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
            ) > 0
        ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    project_code TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (
            project_code = trim(
                project_code,
                char(9) || char(10) || char(11) || char(12) || char(13) || ' '
            )
            AND length(project_code) > 0
            AND length(CAST(project_code AS BLOB)) <= 120
            AND project_code NOT IN ('.', '..')
            AND instr(project_code, char(0)) = 0
            AND project_code NOT GLOB (
                '*[' || char(1) || '-' || char(31) || ']*'
            )
            AND project_code NOT GLOB (
                '*[' || char(127) || '-' || char(159) || ']*'
            )
            AND instr(project_code, '<') = 0
            AND instr(project_code, '>') = 0
            AND instr(project_code, ':') = 0
            AND instr(project_code, '"') = 0
            AND instr(project_code, '/') = 0
            AND instr(project_code, char(92)) = 0
            AND instr(project_code, '|') = 0
            AND instr(project_code, '?') = 0
            AND instr(project_code, '*') = 0
            AND rtrim(project_code, '. ') = project_code
            AND upper(
                rtrim(
                    substr(
                        project_code,
                        1,
                        instr(project_code || '.', '.') - 1
                    ),
                    ' '
                )
            ) NOT IN (
                'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
                'COM1', 'COM2', 'COM3', 'COM4', 'COM5',
                'COM6', 'COM7', 'COM8', 'COM9',
                'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5',
                'LPT6', 'LPT7', 'LPT8', 'LPT9',
                'COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³'
            )
        ),
    company_id INTEGER NOT NULL
        REFERENCES companies(id) ON DELETE RESTRICT,
    name TEXT NOT NULL
        CHECK (
            name = trim(
                name,
                char(9) || char(10) || char(11) || char(12) || char(13) || ' '
            )
            AND length(name) > 0
        ),
    description TEXT
        CHECK (
            description IS NULL
            OR length(
                trim(
                    description,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
            ) > 0
        ),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    archive_reason TEXT
        CHECK (
            archive_reason IS NULL
            OR length(
                trim(
                    archive_reason,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
            ) > 0
        ),
    archived_at TEXT
        CHECK (
            archived_at IS NULL
            OR (
                archived_at = trim(
                    archived_at,
                    char(9) || char(10) || char(11) || char(12) || char(13)
                        || ' '
                )
                AND length(archived_at) > 0
            )
        ),
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
