from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction
from backend.app.core.storage_paths import normalize_project_code
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

_PROJECT_PAYLOAD_FIELDS = ("project_code", "company_id", "name", "description")
_PROJECT_RESPONSE_FIELDS = (
    "id",
    "project_code",
    "company_id",
    "name",
    "description",
    "status",
    "archive_reason",
    "archived_at",
    "created_at",
    "updated_at",
)
_COMPANY_RESPONSE_FIELDS = (
    "id",
    "name",
    "taxpayer_id",
    "registered_address",
    "registered_phone",
    "bank_name",
    "bank_account",
    "notes",
    "created_at",
    "updated_at",
)
_CONTACT_RESPONSE_FIELDS = (
    "id",
    "company_id",
    "name",
    "phone",
    "email",
    "position",
    "notes",
    "created_at",
    "updated_at",
)
_SQLITE_MAX_INTEGER = 2**63 - 1
_PROJECT_STATUSES = frozenset({"active", "archived", "all"})

Clock = Callable[[], datetime]
ProjectPayload = dict[str, str | int | None]
ArchivePayload = dict[str, str | None]


def create_projects_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/projects", tags=["projects"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    project_payload_dependency = Depends(_read_project_payload)
    archive_payload_dependency = Depends(_read_archive_payload)
    project_status_dependency = Depends(_read_project_status)
    project_code_dependency = Depends(_read_path_project_code)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("")
    def list_projects(
        _: None = authentication_dependency,
        selected_status: str = project_status_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> list[dict[str, object]]:
        try:
            if selected_status == "all":
                rows = connection.execute(
                    """
                    SELECT
                        projects.id,
                        projects.project_code,
                        projects.company_id,
                        projects.name,
                        projects.description,
                        projects.status,
                        projects.archive_reason,
                        projects.archived_at,
                        projects.created_at,
                        projects.updated_at,
                        companies.name AS company_name
                    FROM projects
                    JOIN companies ON companies.id = projects.company_id
                    ORDER BY projects.created_at DESC, projects.id DESC
                    """
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT
                        projects.id,
                        projects.project_code,
                        projects.company_id,
                        projects.name,
                        projects.description,
                        projects.status,
                        projects.archive_reason,
                        projects.archived_at,
                        projects.created_at,
                        projects.updated_at,
                        companies.name AS company_name
                    FROM projects
                    JOIN companies ON companies.id = projects.company_id
                    WHERE projects.status = ?
                    ORDER BY projects.created_at DESC, projects.id DESC
                    """,
                    (selected_status,),
                ).fetchall()
        except sqlite3.Error as exc:
            raise _unexpected_database_failure(exc) from None
        return [
            _row_response(row, (*_PROJECT_RESPONSE_FIELDS, "company_name"))
            for row in rows
        ]

    @router.post("", status_code=status.HTTP_201_CREATED)
    def create_project(
        _: None = authentication_dependency,
        payload: ProjectPayload = project_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
                cursor = connection.execute(
                    """
                    INSERT INTO projects
                        (project_code, company_id, name, description,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["project_code"],
                        payload["company_id"],
                        payload["name"],
                        payload["description"],
                        timestamp,
                        timestamp,
                    ),
                )
                project_id = _last_insert_id(cursor)
                response = _project_by_id(connection, project_id)
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise _project_code_exists() from None
            if _is_foreign_key_constraint(exc):
                raise _company_not_found() from None
            raise _unexpected_database_failure(exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure(exc) from None
        if response is None:
            raise _operation_failed()
        return response

    @router.post("/{project_code}/archive")
    def archive_project(
        _: None = authentication_dependency,
        project_code: str = project_code_dependency,
        payload: ArchivePayload = archive_payload_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        timestamp = _timestamp(now)
        try:
            with transaction(connection):
                connection.execute(
                    """
                    UPDATE projects
                    SET status = 'archived', archive_reason = ?,
                        archived_at = ?, updated_at = ?
                    WHERE project_code = ? COLLATE NOCASE
                      AND status = 'active'
                    """,
                    (payload["reason"], timestamp, timestamp, project_code),
                )
                response = _project_by_code(connection, project_code)
                if response is None:
                    raise _project_not_found()
        except sqlite3.IntegrityError as exc:
            raise _unexpected_database_failure(exc) from None
        except sqlite3.Error as exc:
            raise _unexpected_database_failure(exc) from None
        return response

    @router.get("/{project_code}/dashboard")
    def get_project_dashboard(
        _: None = authentication_dependency,
        project_code: str = project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        try:
            with transaction(connection):
                project = _project_by_code(connection, project_code)
                if project is None:
                    raise _project_not_found()
                company = _company_by_id(connection, int(project["company_id"]))
                if company is None:
                    raise sqlite3.DatabaseError("project company is missing")
                contacts = _contacts_for_company(
                    connection,
                    int(project["company_id"]),
                )
                documents = _document_summary(connection, project_code)
        except sqlite3.Error as exc:
            raise _unexpected_database_failure(exc) from None
        return {
            "project": project,
            "company": company,
            "contacts": contacts,
            "documents": documents,
        }

    return router


async def _read_project_payload(request: Request) -> ProjectPayload:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_project_payload() from None
    if not isinstance(payload, dict) or set(payload) != set(_PROJECT_PAYLOAD_FIELDS):
        raise _invalid_project_payload()

    project_code = _normalize_project_code(
        payload["project_code"],
        detail="Invalid project payload",
    )
    company_id = payload["company_id"]
    if (
        not isinstance(company_id, int)
        or isinstance(company_id, bool)
        or not 1 <= company_id <= _SQLITE_MAX_INTEGER
    ):
        raise _invalid_project_payload()
    name = _normalize_text(
        payload["name"],
        required=True,
        detail="Invalid project payload",
    )
    raw_description = payload["description"]
    description = (
        None
        if raw_description is None
        else _normalize_text(
            raw_description,
            required=False,
            detail="Invalid project payload",
        )
    )
    return {
        "project_code": project_code,
        "company_id": company_id,
        "name": name,
        "description": description,
    }


async def _read_archive_payload(request: Request) -> ArchivePayload:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_archive_payload() from None
    if not isinstance(payload, dict) or set(payload) != {"reason"}:
        raise _invalid_archive_payload()
    reason = payload["reason"]
    if reason is None:
        return {"reason": None}
    return {
        "reason": _normalize_text(
            reason,
            required=False,
            detail="Invalid archive payload",
        )
    }


def _read_project_status(request: Request) -> str:
    values = request.query_params.getlist("status")
    if not values:
        return "active"
    if len(values) != 1 or values[0] not in _PROJECT_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid project status",
        )
    return values[0]


def _read_path_project_code(project_code: str) -> str:
    return _normalize_project_code(project_code, detail="Invalid project code")


def _normalize_project_code(value: object, *, detail: str) -> str:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    try:
        return normalize_project_code(value)
    except (TypeError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None


def _normalize_text(
    value: object,
    *,
    required: bool,
    detail: str,
) -> str | None:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    normalized = value.strip()
    if not normalized:
        if required:
            raise _invalid_payload(detail)
        return None
    if "\x00" in normalized:
        raise _invalid_payload(detail)
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid_payload(detail) from None
    return normalized


def _project_by_id(
    connection: sqlite3.Connection,
    project_id: int,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, project_code, company_id, name, description, status,
            archive_reason, archived_at, created_at, updated_at
        FROM projects
        WHERE id = ?
        """,
        (project_id,),
    ).fetchone()
    if row is None:
        return None
    return _row_response(row, _PROJECT_RESPONSE_FIELDS)


def _project_by_code(
    connection: sqlite3.Connection,
    project_code: str,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, project_code, company_id, name, description, status,
            archive_reason, archived_at, created_at, updated_at
        FROM projects
        WHERE project_code = ? COLLATE NOCASE
        """,
        (project_code,),
    ).fetchone()
    if row is None:
        return None
    return _row_response(row, _PROJECT_RESPONSE_FIELDS)


def _company_by_id(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT
            id, name, taxpayer_id, registered_address, registered_phone,
            bank_name, bank_account, notes, created_at, updated_at
        FROM companies
        WHERE id = ?
        """,
        (company_id,),
    ).fetchone()
    if row is None:
        return None
    return _row_response(row, _COMPANY_RESPONSE_FIELDS)


def _contacts_for_company(
    connection: sqlite3.Connection,
    company_id: int,
) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT
            id, company_id, name, phone, email, position, notes,
            created_at, updated_at
        FROM contacts
        WHERE company_id = ?
        ORDER BY id
        """,
        (company_id,),
    ).fetchall()
    return [_row_response(row, _CONTACT_RESPONSE_FIELDS) for row in rows]


def _document_summary(
    connection: sqlite3.Connection,
    project_code: str,
) -> dict[str, object]:
    totals = connection.execute(
        """
        SELECT
            COUNT(DISTINCT documents.id) AS document_count,
            COUNT(document_versions.id) AS version_count
        FROM documents
        LEFT JOIN document_versions
            ON document_versions.document_id = documents.id
        WHERE documents.project_code = ? COLLATE NOCASE
        """,
        (project_code,),
    ).fetchone()
    categories = connection.execute(
        """
        SELECT
            documents.category AS category,
            COUNT(DISTINCT documents.id) AS document_count,
            COUNT(document_versions.id) AS version_count
        FROM documents
        LEFT JOIN document_versions
            ON document_versions.document_id = documents.id
        WHERE documents.project_code = ? COLLATE NOCASE
        GROUP BY documents.category
        ORDER BY documents.category COLLATE NOCASE, documents.category
        """,
        (project_code,),
    ).fetchall()
    if totals is None:
        raise sqlite3.DatabaseError("document totals query returned no row")
    return {
        "document_count": totals["document_count"],
        "version_count": totals["version_count"],
        "categories": [
            _row_response(
                row,
                ("category", "document_count", "version_count"),
            )
            for row in categories
        ],
    }


def _row_response(
    row: sqlite3.Row,
    fields: tuple[str, ...],
) -> dict[str, object]:
    return {field: row[field] for field in fields}


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    identifier = cursor.lastrowid
    if identifier is None:
        raise sqlite3.DatabaseError("insert did not produce an identifier")
    return identifier


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_unique_constraint(failure: sqlite3.IntegrityError) -> bool:
    return (
        getattr(failure, "sqlite_errorcode", None) == sqlite3.SQLITE_CONSTRAINT_UNIQUE
    )


def _is_foreign_key_constraint(failure: sqlite3.IntegrityError) -> bool:
    return (
        getattr(failure, "sqlite_errorcode", None)
        == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
    )


def _invalid_project_payload() -> HTTPException:
    return _invalid_payload("Invalid project payload")


def _invalid_archive_payload() -> HTTPException:
    return _invalid_payload("Invalid archive payload")


def _invalid_payload(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=detail,
    )


def _company_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Company not found",
    )


def _project_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Project not found",
    )


def _project_code_exists() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="Project code already exists",
    )


def _operation_failed() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Project operation failed",
    )


def _unexpected_database_failure(failure: sqlite3.Error) -> HTTPException:
    logger.exception(
        "Project database operation failed (sqlite_errorcode=%s, sqlite_errorname=%s)",
        getattr(failure, "sqlite_errorcode", None),
        getattr(failure, "sqlite_errorname", None),
    )
    return _operation_failed()
