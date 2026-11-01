from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from hashlib import sha256

from fastapi import HTTPException, Request

from backend.app.core.security import SESSION_COOKIE_NAME, read_account_session_token
from backend.app.features.permission_catalog import PERMISSION_BY_KEY, PERMISSION_KEYS


@dataclass(frozen=True)
class Principal:
    user_id: int
    username: str
    display_name: str
    is_owner: bool
    group_id: int | None
    group_name: str | None
    permissions: frozenset[str]
    project_ids: frozenset[int]
    access_revision: int


def require_principal(
    request: Request, connection: sqlite3.Connection, session_secret: str
) -> Principal:
    identity = read_account_session_token(
        session_secret, request.cookies.get(SESSION_COOKIE_NAME)
    )
    if identity is None:
        raise HTTPException(401, "Authentication required")
    user_id, sid = identity
    row = connection.execute(
        """
        SELECT a.*, g.name AS group_name, g.enabled AS group_enabled,
               g.archived AS group_archived, g.revision AS group_revision
        FROM account_sessions s JOIN accounts a ON a.id = s.account_id
        LEFT JOIN workgroups g ON g.id = a.group_id
        WHERE s.sid_hash = ? AND s.account_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    """,
        (sha256(sid.encode()).hexdigest(), user_id, int(time.time())),
    ).fetchone()
    if row is None or not row["enabled"]:
        raise HTTPException(401, "Authentication required")
    principal = principal_from_account(connection, row)
    request.state.principal = principal
    if hasattr(connection, "principal"):
        connection.principal = principal
    return principal


def principal_from_account(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> Principal:
    group_id = row["group_id"]
    group = (
        connection.execute(
            "SELECT * FROM workgroups WHERE id = ?", (group_id,)
        ).fetchone()
        if group_id is not None
        else None
    )
    permissions: frozenset[str] = frozenset()
    projects: frozenset[int] = frozenset()
    if row["is_owner"]:
        permissions = PERMISSION_KEYS
    elif group is not None and group["enabled"] and not group["archived"]:
        assigned = frozenset(
            item[0]
            for item in connection.execute(
                "SELECT permission_key FROM workgroup_permissions WHERE group_id = ?",
                (group_id,),
            )
        )
        permissions = frozenset(
            key
            for key in assigned & PERMISSION_KEYS
            if set(PERMISSION_BY_KEY[key].dependencies) <= assigned
        )
        projects = frozenset(
            item[0]
            for item in connection.execute(
                "SELECT project_id FROM workgroup_projects WHERE group_id = ?",
                (group_id,),
            )
        )
    version = (
        f"{row['id']}:{row['revision']}:{group_id}:{group['revision'] if group else 0}"
    )
    return Principal(
        row["id"],
        row["username"],
        row["display_name"] or row["username"],
        bool(row["is_owner"]),
        group_id,
        group["name"] if group else None,
        permissions,
        projects,
        int(sha256(version.encode()).hexdigest()[:13], 16),
    )


def require_permission(
    principal: Principal, permission: str, *, project_id: int | None = None
) -> None:
    if permission not in PERMISSION_KEYS:
        raise HTTPException(403, "Unknown or unavailable permission")
    if principal.is_owner:
        return
    if permission not in principal.permissions or (
        project_id is not None and project_id not in principal.project_ids
    ):
        raise HTTPException(403, "Permission denied")


def visible_project_ids(principal: Principal) -> tuple[int, ...] | None:
    return None if principal.is_owner else tuple(sorted(principal.project_ids))


def has_permission(principal: Principal | None, permission: str) -> bool:
    """None is reserved for trusted internal business calculations, never HTTP identity."""
    return (
        principal is None or principal.is_owner or permission in principal.permissions
    )


def project_scope_sql(
    principal: Principal | None, column: str
) -> tuple[str, tuple[int, ...]]:
    """Build a parameterized scope for a server-declared SQL column."""
    if principal is None or principal.is_owner:
        return "1 = 1", ()
    ids = tuple(sorted(principal.project_ids))
    if not ids:
        return "0 = 1", ()
    return f"{column} IN ({','.join('?' for _ in ids)})", ids
