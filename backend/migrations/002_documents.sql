CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    project_code TEXT NOT NULL,
    category TEXT NOT NULL,
    logical_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_code, category, logical_name)
);

CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL
        REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    original_filename TEXT NOT NULL,
    stored_relative_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK (
        length(sha256) = 64
        AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    UNIQUE (document_id, version_number)
);
