CREATE TABLE workgroups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (archived = 0 OR enabled = 0)
);

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
    group_id INTEGER REFERENCES workgroups(id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (is_owner = 0 OR (enabled = 1 AND group_id IS NULL))
);
CREATE UNIQUE INDEX accounts_single_owner ON accounts(is_owner) WHERE is_owner = 1;
CREATE INDEX accounts_group_id ON accounts(group_id);

CREATE TRIGGER accounts_preserve_owner BEFORE DELETE ON accounts
WHEN OLD.is_owner = 1 BEGIN
    SELECT RAISE(ABORT, 'Cannot delete the owner account');
END;
CREATE TRIGGER accounts_preserve_owner_role BEFORE UPDATE OF is_owner ON accounts
WHEN OLD.is_owner = 1 AND NEW.is_owner <> 1 BEGIN
    SELECT RAISE(ABORT, 'Cannot remove the owner role');
END;

CREATE TABLE account_sessions (
    sid_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at TEXT
);
CREATE INDEX account_sessions_account_id ON account_sessions(account_id);

CREATE TABLE workgroup_permissions (
    group_id INTEGER NOT NULL REFERENCES workgroups(id),
    permission_key TEXT NOT NULL,
    PRIMARY KEY (group_id, permission_key)
);
CREATE TABLE workgroup_projects (
    group_id INTEGER NOT NULL REFERENCES workgroups(id),
    project_id INTEGER NOT NULL REFERENCES projects(id),
    PRIMARY KEY (group_id, project_id)
);
CREATE INDEX workgroup_projects_project_id ON workgroup_projects(project_id);
