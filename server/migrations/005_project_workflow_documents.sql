ALTER TABLE projects ADD COLUMN closure_type TEXT
    CHECK (closure_type IS NULL OR closure_type IN ('cancelled', 'completed'));

ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
    CHECK (revision > 0);

CREATE TABLE documents_enhanced (
    id INTEGER PRIMARY KEY,
    project_code TEXT NOT NULL,
    category TEXT NOT NULL,
    logical_name TEXT NOT NULL,
    notes TEXT,
    archive_reason TEXT,
    archived_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),
    UNIQUE (project_code, category, logical_name),
    CHECK (
        (archived_at IS NULL AND archive_reason IS NULL)
        OR (
            archived_at IS NOT NULL
            AND archive_reason IS NOT NULL
            AND length(trim(archive_reason)) > 0
        )
    )
);

INSERT INTO documents_enhanced
    (id, project_code, category, logical_name, notes, archive_reason,
     archived_at, revision, created_at, updated_at)
SELECT
    id, project_code, category, logical_name, NULL, NULL,
    NULL, 1, created_at, created_at
FROM documents;

CREATE TABLE document_versions_enhanced (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL
        REFERENCES documents_enhanced(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    original_filename TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    stored_relative_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (document_id, version_number)
);

INSERT INTO document_versions_enhanced
    (id, document_id, version_number, original_filename, content_type,
     stored_relative_path, size_bytes, sha256, notes, created_at)
SELECT
    id, document_id, version_number, original_filename,
    'application/octet-stream', stored_relative_path, size_bytes, sha256,
    NULL, created_at
FROM document_versions;

DROP TABLE document_versions;

DROP TABLE documents;

ALTER TABLE documents_enhanced RENAME TO documents;

ALTER TABLE document_versions_enhanced RENAME TO document_versions;

CREATE TABLE project_stages (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
    stage_code TEXT NOT NULL CHECK (
        stage_code IN (
            'planning', 'site_survey', 'quotation', 'technical_agreement',
            'contract', 'advance_payment', 'mechanical_design',
            'electrical_design', 'procurement', 'staffing',
            'mechanical_signoff', 'electrical_signoff', 'construction',
            'progress_payment', 'commissioning', 'acceptance',
            'final_payment', 'closeout'
        )
    ),
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 18),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'in_progress', 'blocked', 'completed', 'skipped')
    ),
    status_reason TEXT,
    planned_start_on TEXT,
    planned_end_on TEXT,
    started_at TEXT,
    blocked_at TEXT,
    completed_at TEXT,
    notes TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, stage_code),
    UNIQUE (project_id, sequence),
    CHECK (
        planned_start_on IS NULL
        OR planned_end_on IS NULL
        OR planned_start_on <= planned_end_on
    ),
    CHECK (
        (status = 'pending'
            AND started_at IS NULL
            AND blocked_at IS NULL
            AND completed_at IS NULL)
        OR (status = 'in_progress'
            AND started_at IS NOT NULL
            AND blocked_at IS NULL
            AND completed_at IS NULL)
        OR (status = 'blocked'
            AND started_at IS NOT NULL
            AND blocked_at IS NOT NULL
            AND completed_at IS NULL
            AND status_reason IS NOT NULL
            AND length(trim(status_reason)) > 0)
        OR (status = 'completed'
            AND started_at IS NOT NULL
            AND blocked_at IS NULL
            AND completed_at IS NOT NULL)
        OR (status = 'skipped'
            AND blocked_at IS NULL
            AND completed_at IS NOT NULL
            AND status_reason IS NOT NULL
            AND length(trim(status_reason)) > 0)
    )
);

CREATE TABLE project_stage_events (
    id INTEGER PRIMARY KEY,
    project_stage_id INTEGER NOT NULL
        REFERENCES project_stages(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL CHECK (
        from_status IN ('pending', 'in_progress', 'blocked', 'completed', 'skipped')
    ),
    to_status TEXT NOT NULL CHECK (
        to_status IN ('pending', 'in_progress', 'blocked', 'completed', 'skipped')
    ),
    reason TEXT,
    occurred_at TEXT NOT NULL,
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 1),
    created_at TEXT NOT NULL,
    UNIQUE (project_stage_id, resulting_revision),
    CHECK (from_status <> to_status),
    CHECK (
        (
            to_status NOT IN ('blocked', 'skipped')
            AND NOT (
                from_status IN ('completed', 'skipped')
                AND to_status = 'in_progress'
            )
        )
        OR (
            reason IS NOT NULL
            AND length(trim(reason)) > 0
        )
    )
);

CREATE TABLE idempotency_requests (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64
        AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    response_status INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 599),
    response_json TEXT NOT NULL,
    resource_type TEXT,
    resource_id INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (scope, idempotency_key)
);

WITH stage_catalog(stage_code, sequence) AS (
    SELECT 'planning', 1
    UNION ALL SELECT 'site_survey', 2
    UNION ALL SELECT 'quotation', 3
    UNION ALL SELECT 'technical_agreement', 4
    UNION ALL SELECT 'contract', 5
    UNION ALL SELECT 'advance_payment', 6
    UNION ALL SELECT 'mechanical_design', 7
    UNION ALL SELECT 'electrical_design', 8
    UNION ALL SELECT 'procurement', 9
    UNION ALL SELECT 'staffing', 10
    UNION ALL SELECT 'mechanical_signoff', 11
    UNION ALL SELECT 'electrical_signoff', 12
    UNION ALL SELECT 'construction', 13
    UNION ALL SELECT 'progress_payment', 14
    UNION ALL SELECT 'commissioning', 15
    UNION ALL SELECT 'acceptance', 16
    UNION ALL SELECT 'final_payment', 17
    UNION ALL SELECT 'closeout', 18
)
INSERT INTO project_stages
    (project_id, stage_code, sequence, status, revision, created_at, updated_at)
SELECT
    projects.id, stage_catalog.stage_code, stage_catalog.sequence,
    'pending', 1, projects.created_at, projects.updated_at
FROM projects
CROSS JOIN stage_catalog;

CREATE TRIGGER initialize_project_stages_after_insert
AFTER INSERT ON projects
BEGIN
    INSERT INTO project_stages
        (project_id, stage_code, sequence, status, revision,
         created_at, updated_at)
    VALUES
        (NEW.id, 'planning', 1, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'site_survey', 2, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'quotation', 3, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'technical_agreement', 4, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'contract', 5, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'advance_payment', 6, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'mechanical_design', 7, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'electrical_design', 8, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'procurement', 9, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'staffing', 10, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'mechanical_signoff', 11, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'electrical_signoff', 12, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'construction', 13, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'progress_payment', 14, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'commissioning', 15, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'acceptance', 16, 'pending', 1, NEW.created_at, NEW.updated_at),
        (NEW.id, 'final_payment', 17, 'pending', 1,
            NEW.created_at, NEW.updated_at),
        (NEW.id, 'closeout', 18, 'pending', 1, NEW.created_at, NEW.updated_at);
END;
