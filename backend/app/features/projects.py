from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction, transaction_immediate
from backend.app.core.storage_paths import (
    normalize_project_code,
    project_code_identity,
)
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session
from backend.app.features.dashboards import build_project_operating_snapshot

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
_PROJECT_UPDATE_FIELDS = {"company_id", "name", "description", "expected_revision"}
_PROJECT_CLOSE_FIELDS = {"closure_type", "reason", "expected_revision"}
_PROJECT_RESTORE_FIELDS = {"reason", "expected_revision"}
_CLOSURE_TYPES = frozenset({"cancelled", "completed"})

Clock = Callable[[], datetime]
ProjectPayload = dict[str, str | int | None]
ProjectUpdatePayload = dict[str, str | int | None]
ProjectClosePayload = dict[str, str | int]
ProjectRestorePayload = dict[str, str | int]


def create_projects_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/projects",
        tags=["projects"],
        route_class=ApiErrorRoute,
    )
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    project_payload_dependency = Depends(_read_project_payload)
    project_status_dependency = Depends(_read_project_status)
    structured_project_code_dependency = Depends(_read_structured_path_project_code)
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
                        (project_code, project_code_key, company_id,
                         name, description,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        payload["project_code"],
                        payload["project_code_key"],
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
        project_code: str,
        _: None = authentication_dependency,
    ) -> dict[str, object]:
        del project_code
        raise ApiError(
            status.HTTP_410_GONE,
            "Project archive endpoint is retired; use project close",
            "PROJECT_ARCHIVE_RETIRED",
            headers={"X-Error-Code": "PROJECT_ARCHIVE_RETIRED"},
        )

    @router.get("/{project_code}/dashboard")
    def get_project_dashboard(
        _: None = authentication_dependency,
        project_code: str = structured_project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        try:
            with transaction(connection):
                project_row = _project_detail_row_by_key(connection, project_code)
                if project_row is None:
                    raise _resource_not_found("Project not found")
                project = _row_response(project_row, _PROJECT_DETAIL_FIELDS)
                company = _company_by_id(connection, int(project["company_id"]))
                if company is None:
                    raise sqlite3.DatabaseError("project company is missing")
                contacts = _contacts_for_company(
                    connection,
                    int(project["company_id"]),
                )
                documents = _document_summary(
                    connection,
                    str(project["project_code"]),
                )
                operating = build_project_operating_snapshot(
                    connection,
                    project,
                    today=_business_date(now),
                )
                completion_check = _project_completion_check(
                    connection,
                    project,
                    operating,
                )
        except sqlite3.Error as exc:
            raise _unexpected_structured_database_failure(exc) from None
        return {
            "project": project,
            "company": company,
            "contacts": contacts,
            "documents": documents,
            **operating,
            "completion_check": completion_check,
        }

    @router.get("/{project_code}")
    def get_project_detail(
        _: None = authentication_dependency,
        project_code: str = structured_project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        try:
            response = _project_detail_by_key(connection, project_code)
        except sqlite3.Error as exc:
            raise _unexpected_structured_database_failure(exc) from None
        if response is None:
            raise _resource_not_found("Project not found")
        return response

    @router.put("/{project_code}")
    async def update_project(
        request: Request,
        _: None = authentication_dependency,
        project_code: str = structured_project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _read_project_update_payload(request)
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                current = _project_detail_row_by_key(connection, project_code)
                if current is None:
                    raise _resource_not_found("Project not found")
                if current["status"] != "active":
                    raise _business_conflict("Project is archived", "PROJECT_ARCHIVED")
                _require_revision(current, int(payload["expected_revision"]))
                company = connection.execute(
                    "SELECT 1 FROM companies WHERE id = ?",
                    (payload["company_id"],),
                ).fetchone()
                if company is None:
                    raise _resource_not_found("Company not found")
                connection.execute(
                    """
                    UPDATE projects
                    SET company_id = ?, name = ?, description = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE project_code_key = ? AND revision = ?
                    """,
                    (
                        payload["company_id"],
                        payload["name"],
                        payload["description"],
                        timestamp,
                        project_code,
                        payload["expected_revision"],
                    ),
                )
                response = _project_detail_by_key(connection, project_code)
                if response is None:
                    raise sqlite3.DatabaseError("updated project is missing")
                return response
        except sqlite3.Error as exc:
            raise _unexpected_structured_database_failure(exc) from None

    @router.post("/{project_code}/close")
    async def close_project(
        request: Request,
        _: None = authentication_dependency,
        project_code: str = structured_project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _read_idempotency_key(request)
        payload = await _read_project_close_payload(request)
        request_hash = _request_hash(payload)
        scope = f"POST:/api/projects/{project_code}/close"
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                restored = restore_idempotent_response(
                    connection,
                    scope=scope,
                    key=key,
                    request_hash=request_hash,
                )
                if restored is not None:
                    return restored
                current = _project_detail_row_by_key(connection, project_code)
                if current is None:
                    raise _resource_not_found("Project not found")
                if current["status"] != "active":
                    raise _business_conflict(
                        "Project is already closed",
                        "PROJECT_ALREADY_CLOSED",
                    )
                _require_revision(current, int(payload["expected_revision"]))
                if payload["closure_type"] == "completed":
                    operating = build_project_operating_snapshot(
                        connection,
                        current,
                        today=_business_date(now),
                    )
                    completion_check = _project_completion_check(
                        connection,
                        current,
                        operating,
                    )
                    if completion_check["ready"] is not True:
                        raise _project_completion_blocked(completion_check)
                connection.execute(
                    """
                    UPDATE projects
                    SET status = 'archived', closure_type = ?, archive_reason = ?,
                        archived_at = ?, revision = revision + 1, updated_at = ?
                    WHERE project_code_key = ? AND revision = ?
                    """,
                    (
                        payload["closure_type"],
                        payload["reason"],
                        timestamp,
                        timestamp,
                        project_code,
                        payload["expected_revision"],
                    ),
                )
                response = _project_detail_by_key(connection, project_code)
                if response is None:
                    raise sqlite3.DatabaseError("closed project is missing")
                save_idempotent_response(
                    connection,
                    scope=scope,
                    key=key,
                    request_hash=request_hash,
                    response=response,
                    response_status=status.HTTP_200_OK,
                    resource_type="project",
                    resource_id=int(current["id"]),
                    created_at=timestamp,
                )
                return response
        except sqlite3.Error as exc:
            raise _unexpected_structured_database_failure(exc) from None

    @router.post("/{project_code}/restore")
    async def restore_project(
        request: Request,
        _: None = authentication_dependency,
        project_code: str = structured_project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _read_idempotency_key(request)
        payload = await _read_project_restore_payload(request)
        request_hash = _request_hash(payload)
        scope = f"POST:/api/projects/{project_code}/restore"
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                restored = restore_idempotent_response(
                    connection,
                    scope=scope,
                    key=key,
                    request_hash=request_hash,
                )
                if restored is not None:
                    return restored
                current = _project_detail_row_by_key(connection, project_code)
                if current is None:
                    raise _resource_not_found("Project not found")
                if current["status"] != "archived":
                    raise _business_conflict(
                        "Project is already active",
                        "PROJECT_ALREADY_ACTIVE",
                    )
                expected_revision = int(payload["expected_revision"])
                _require_revision(current, expected_revision)
                resulting_revision = expected_revision + 1
                cursor = connection.execute(
                    """
                    UPDATE projects
                    SET status = 'active', closure_type = NULL,
                        archive_reason = NULL, archived_at = NULL,
                        revision = ?, updated_at = ?
                    WHERE project_code_key = ? AND revision = ?
                    """,
                    (
                        resulting_revision,
                        timestamp,
                        project_code,
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    raise sqlite3.DatabaseError("restored project update was lost")
                connection.execute(
                    """
                    INSERT INTO project_restore_events
                        (project_id, from_closure_type, from_archive_reason,
                         from_archived_at, restore_reason, expected_revision,
                         resulting_revision, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        current["id"],
                        current["closure_type"],
                        current["archive_reason"],
                        current["archived_at"],
                        payload["reason"],
                        expected_revision,
                        resulting_revision,
                        timestamp,
                    ),
                )
                response = _project_detail_by_key(connection, project_code)
                if response is None:
                    raise sqlite3.DatabaseError("restored project is missing")
                save_idempotent_response(
                    connection,
                    scope=scope,
                    key=key,
                    request_hash=request_hash,
                    response=response,
                    response_status=status.HTTP_200_OK,
                    resource_type="project_restore",
                    resource_id=int(current["id"]),
                    created_at=timestamp,
                )
                return response
        except sqlite3.Error as exc:
            raise _unexpected_structured_database_failure(exc) from None

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
        "project_code_key": project_code_identity(project_code),
        "company_id": company_id,
        "name": name,
        "description": description,
    }


async def _read_project_update_payload(request: Request) -> ProjectUpdatePayload:
    payload = await _read_json_object(request, "Invalid project payload")
    if set(payload) != _PROJECT_UPDATE_FIELDS:
        raise _invalid_structured_payload("Invalid project payload")
    company_id = _positive_integer(
        payload["company_id"],
        "Invalid project payload",
    )
    name = _normalize_structured_text(
        payload["name"],
        required=True,
        detail="Invalid project payload",
    )
    raw_description = payload["description"]
    description = (
        None
        if raw_description is None
        else _normalize_structured_text(
            raw_description,
            required=False,
            detail="Invalid project payload",
        )
    )
    return {
        "company_id": company_id,
        "name": name,
        "description": description,
        "expected_revision": _positive_integer(
            payload["expected_revision"],
            "Invalid project payload",
        ),
    }


async def _read_project_close_payload(request: Request) -> ProjectClosePayload:
    payload = await _read_json_object(request, "Invalid project close payload")
    if set(payload) != _PROJECT_CLOSE_FIELDS:
        raise _invalid_structured_payload("Invalid project close payload")
    closure_type = payload["closure_type"]
    if not isinstance(closure_type, str) or closure_type not in _CLOSURE_TYPES:
        raise _invalid_structured_payload("Invalid project close payload")
    reason = _normalize_structured_text(
        payload["reason"],
        required=True,
        detail="Invalid project close payload",
    )
    return {
        "closure_type": closure_type,
        "reason": reason,
        "expected_revision": _positive_integer(
            payload["expected_revision"],
            "Invalid project close payload",
        ),
    }


async def _read_project_restore_payload(request: Request) -> ProjectRestorePayload:
    payload = await _read_json_object(request, "Invalid project restore payload")
    if set(payload) != _PROJECT_RESTORE_FIELDS:
        raise _invalid_structured_payload("Invalid project restore payload")
    return {
        "reason": _normalize_structured_text(
            payload["reason"],
            required=True,
            detail="Invalid project restore payload",
        ),
        "expected_revision": _positive_integer(
            payload["expected_revision"],
            "Invalid project restore payload",
        ),
    }


async def _read_json_object(request: Request, detail: str) -> dict[str, object]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_structured_payload(detail) from None
    if not isinstance(payload, dict):
        raise _invalid_structured_payload(detail)
    return payload


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
    normalized = _normalize_project_code(project_code, detail="Invalid project code")
    return project_code_identity(normalized)


def _read_structured_path_project_code(project_code: str) -> str:
    try:
        return _read_path_project_code(project_code)
    except HTTPException:
        raise _invalid_structured_payload("Invalid project code") from None


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


def _normalize_structured_text(
    value: object,
    *,
    required: bool,
    detail: str,
) -> str | None:
    try:
        normalized = _normalize_text(value, required=required, detail=detail)
    except HTTPException:
        raise _invalid_structured_payload(detail) from None
    return normalized


def _positive_integer(value: object, detail: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= _SQLITE_MAX_INTEGER
    ):
        raise _invalid_structured_payload(detail)
    return value


def _validate_idempotency_key(value: str) -> str:
    try:
        parsed = UUID(value)
    except (AttributeError, ValueError):
        raise _invalid_structured_payload("Invalid Idempotency-Key") from None
    canonical = str(parsed)
    if value.lower() != canonical:
        raise _invalid_structured_payload("Invalid Idempotency-Key")
    return canonical


def _read_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("Idempotency-Key")
    if len(values) != 1:
        raise _invalid_structured_payload("Invalid Idempotency-Key")
    return _validate_idempotency_key(values[0])


def _request_hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _require_revision(row: sqlite3.Row, expected_revision: int) -> None:
    if row["revision"] != expected_revision:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "Resource was modified",
            "REVISION_CONFLICT",
            current_revision=int(row["revision"]),
            headers={
                "X-Error-Code": "REVISION_CONFLICT",
                "X-Current-Revision": str(row["revision"]),
            },
        )


def _project_completion_check(
    connection: sqlite3.Connection,
    project: sqlite3.Row | dict[str, object],
    operating: dict[str, object],
) -> dict[str, object]:
    stages = operating.get("stages")
    receivables = operating.get("receivables")
    if not isinstance(stages, list) or not isinstance(receivables, dict):
        raise sqlite3.DatabaseError("project completion inputs are invalid")
    outstanding_receivable = receivables.get("outstanding_receivable_cents")
    if isinstance(outstanding_receivable, bool) or not isinstance(
        outstanding_receivable,
        int,
    ):
        raise sqlite3.DatabaseError("project receivables are invalid")
    contract_outstanding = _project_contract_outstanding(
        connection,
        int(project["id"]),
    )

    stages_ready = bool(stages) and all(
        isinstance(stage, dict)
        and stage.get("status") in {"completed", "skipped"}
        for stage in stages
    )
    latest_final_acceptance = connection.execute(
        """
        SELECT status FROM acceptances
        WHERE project_id = ?
          AND acceptance_type = 'final'
        ORDER BY COALESCE(performed_on, scheduled_on, '') DESC, id DESC
        LIMIT 1
        """,
        (project["id"],),
    ).fetchone()
    final_acceptance_ready = (
        latest_final_acceptance is not None
        and latest_final_acceptance["status"] in {"passed", "passed_with_punch"}
    )
    receivables_ready = outstanding_receivable == 0 and contract_outstanding == 0
    blockers: list[str] = []
    if not stages_ready:
        blockers.append("PROJECT_STAGES_INCOMPLETE")
    if not final_acceptance_ready:
        blockers.append("FINAL_ACCEPTANCE_NOT_PASSED")
    if not receivables_ready:
        blockers.append("RECEIVABLES_OUTSTANDING")
    return {
        "stages_ready": stages_ready,
        "final_acceptance_ready": final_acceptance_ready,
        "receivables_ready": receivables_ready,
        "ready": not blockers,
        "blockers": blockers,
    }


def _project_contract_outstanding(
    connection: sqlite3.Connection,
    project_id: int,
) -> int:
    row = connection.execute(
        """
        SELECT COALESCE(
            SUM(
                CASE
                    WHEN received_amount >= contract_amount THEN 0
                    ELSE contract_amount - received_amount
                END
            ),
            0
        ) AS outstanding_amount
        FROM (
            SELECT
                allocations.id,
                allocations.amount_cents AS contract_amount,
                COALESCE(SUM(receipts.amount_cents), 0) AS received_amount
            FROM contract_project_allocations AS allocations
            JOIN contracts ON contracts.id = allocations.contract_id
            LEFT JOIN receipts
                ON receipts.contract_allocation_id = allocations.id
               AND receipts.status = 'active'
            WHERE allocations.project_id = ?
              AND contracts.status IN ('signed', 'completed')
            GROUP BY allocations.id, allocations.amount_cents
        ) AS contract_collection
        """,
        (project_id,),
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("project contract collection is missing")
    return int(row["outstanding_amount"])


def _project_completion_blocked(
    completion_check: dict[str, object],
) -> ApiError:
    field_errors: dict[str, object] = {}
    if completion_check["stages_ready"] is not True:
        field_errors["stages"] = "所有项目阶段必须为已完成或已跳过"
    if completion_check["final_acceptance_ready"] is not True:
        field_errors["final_acceptance"] = (
            "必须存在结果为通过或带整改通过的最终验收"
        )
    if completion_check["receivables_ready"] is not True:
        field_errors["receivables"] = "项目未收款必须为 0"
    return ApiError(
        status.HTTP_409_CONFLICT,
        "Project completion requirements are not met",
        "PROJECT_COMPLETION_BLOCKED",
        field_errors=field_errors,
        headers={"X-Error-Code": "PROJECT_COMPLETION_BLOCKED"},
    )


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


_PROJECT_DETAIL_FIELDS = (
    "id",
    "project_code",
    "company_id",
    "company_name",
    "name",
    "description",
    "status",
    "closure_type",
    "archive_reason",
    "archived_at",
    "revision",
    "created_at",
    "updated_at",
)


def _project_detail_row_by_key(
    connection: sqlite3.Connection,
    project_code_key: str,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            projects.id,
            projects.project_code,
            projects.company_id,
            companies.name AS company_name,
            projects.name,
            projects.description,
            projects.status,
            projects.closure_type,
            projects.archive_reason,
            projects.archived_at,
            projects.revision,
            projects.created_at,
            projects.updated_at
        FROM projects
        JOIN companies ON companies.id = projects.company_id
        WHERE projects.project_code_key = ?
        """,
        (project_code_key,),
    ).fetchone()


def _project_detail_by_key(
    connection: sqlite3.Connection,
    project_code_key: str,
) -> dict[str, object] | None:
    row = _project_detail_row_by_key(connection, project_code_key)
    if row is None:
        return None
    return _row_response(row, _PROJECT_DETAIL_FIELDS)


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


def _business_date(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()


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


def _invalid_payload(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=detail,
    )


def _invalid_structured_payload(detail: str) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail,
        "VALIDATION_ERROR",
    )


def _resource_not_found(detail: str) -> ApiError:
    return ApiError(
        status.HTTP_404_NOT_FOUND,
        detail,
        "RESOURCE_NOT_FOUND",
    )


def _business_conflict(detail: str, error_code: str) -> ApiError:
    return ApiError(
        status.HTTP_409_CONFLICT,
        detail,
        error_code,
        headers={"X-Error-Code": error_code},
    )


def _company_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Company not found",
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
    _log_database_failure(failure)
    return _operation_failed()


def _unexpected_structured_database_failure(failure: sqlite3.Error) -> ApiError:
    _log_database_failure(failure)
    return ApiError(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "Project operation failed",
        "PROJECT_OPERATION_FAILED",
    )


def _log_database_failure(failure: sqlite3.Error) -> None:
    logger.exception(
        "Project database operation failed (sqlite_errorcode=%s, sqlite_errorname=%s)",
        getattr(failure, "sqlite_errorcode", None),
        getattr(failure, "sqlite_errorname", None),
    )
