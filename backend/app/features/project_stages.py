from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.api_common import ApiError, ApiErrorRoute
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

_STAGE_CATALOG = (
    ("planning", 1),
    ("site_survey", 2),
    ("quotation", 3),
    ("technical_agreement", 4),
    ("contract", 5),
    ("advance_payment", 6),
    ("mechanical_design", 7),
    ("electrical_design", 8),
    ("procurement", 9),
    ("staffing", 10),
    ("mechanical_signoff", 11),
    ("electrical_signoff", 12),
    ("construction", 13),
    ("progress_payment", 14),
    ("commissioning", 15),
    ("acceptance", 16),
    ("final_payment", 17),
    ("closeout", 18),
)
_STAGE_CODES = frozenset(code for code, _ in _STAGE_CATALOG)
_STAGE_STATUSES = frozenset(
    {"pending", "in_progress", "blocked", "completed", "skipped"}
)
_ALLOWED_TRANSITIONS = {
    "pending": frozenset({"in_progress", "skipped"}),
    "in_progress": frozenset({"blocked", "completed", "skipped"}),
    "blocked": frozenset({"in_progress", "skipped"}),
    "completed": frozenset({"in_progress"}),
    "skipped": frozenset({"in_progress"}),
}
_STAGE_RESPONSE_FIELDS = (
    "stage_code",
    "status",
    "status_reason",
    "planned_start_on",
    "planned_end_on",
    "started_at",
    "blocked_at",
    "completed_at",
    "notes",
    "revision",
)
_SCHEDULE_FIELDS = {
    "planned_start_on",
    "planned_end_on",
    "notes",
    "expected_revision",
}
_TRANSITION_FIELDS = {"to_status", "occurred_at", "reason", "expected_revision"}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

Clock = Callable[[], datetime]
SchedulePayload = dict[str, str | int | None]
TransitionPayload = dict[str, str | int | None]


def create_project_stages_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/projects",
        route_class=ApiErrorRoute,
        tags=["project-stages"],
    )
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    schedule_dependency = Depends(_read_schedule_payload)
    transition_dependency = Depends(_read_transition_payload)
    idempotency_dependency = Depends(_read_idempotency_key)
    project_code_dependency = Depends(_read_project_code)
    stage_code_dependency = Depends(_read_stage_code)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/{project_code}/stages", response_model=None)
    def list_project_stages(
        _: None = authentication_dependency,
        project_code: str = project_code_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> list[dict[str, object]] | JSONResponse:
        try:
            project = _project_by_key(connection, project_code)
            if project is None:
                return _error_response(
                    status.HTTP_404_NOT_FOUND,
                    detail="Project not found",
                    error_code="PROJECT_NOT_FOUND",
                )
            return _stage_list(connection, int(project["id"]))
        except sqlite3.Error as failure:
            return _database_error(failure)

    @router.put("/{project_code}/stages/{stage_code}", response_model=None)
    def update_project_stage(
        _: None = authentication_dependency,
        project_code: str = project_code_dependency,
        stage_code: str = stage_code_dependency,
        payload: SchedulePayload = schedule_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object] | JSONResponse:
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                project = _project_by_key(connection, project_code)
                if project is None:
                    return _error_response(
                        status.HTTP_404_NOT_FOUND,
                        detail="Project not found",
                        error_code="PROJECT_NOT_FOUND",
                    )
                if project["status"] == "archived":
                    return _error_response(
                        status.HTTP_409_CONFLICT,
                        detail="Project is archived",
                        error_code="PROJECT_ARCHIVED",
                    )
                project_id = int(project["id"])
                cursor = connection.execute(
                    """
                    UPDATE project_stages
                    SET planned_start_on = ?, planned_end_on = ?, notes = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE project_id = ? AND stage_code = ? AND revision = ?
                    """,
                    (
                        payload["planned_start_on"],
                        payload["planned_end_on"],
                        payload["notes"],
                        timestamp,
                        project_id,
                        stage_code,
                        payload["expected_revision"],
                    ),
                )
                if cursor.rowcount != 1:
                    return _revision_conflict(connection, project_id, stage_code)
                stage = _stage_by_code(connection, project_id, stage_code)
                if stage is None:
                    raise sqlite3.DatabaseError("updated project stage is missing")
                return stage
        except sqlite3.Error as failure:
            return _database_error(failure)

    @router.post(
        "/{project_code}/stages/{stage_code}/transition",
        response_model=None,
    )
    def transition_project_stage(
        request: Request,
        _: None = authentication_dependency,
        project_code: str = project_code_dependency,
        stage_code: str = stage_code_dependency,
        idempotency_key: str = idempotency_dependency,
        payload: TransitionPayload = transition_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object] | JSONResponse:
        timestamp = _timestamp(now)
        request_hash = _payload_hash(payload)
        idempotency_scope = f"POST:{request.url.path}"
        try:
            with transaction_immediate(connection):
                replay = _idempotency_replay(
                    connection,
                    idempotency_scope,
                    idempotency_key,
                    request_hash,
                )
                if replay is not None:
                    return replay
                project = _project_by_key(connection, project_code)
                if project is None:
                    return _error_response(
                        status.HTTP_404_NOT_FOUND,
                        detail="Project not found",
                        error_code="PROJECT_NOT_FOUND",
                    )
                if project["status"] == "archived":
                    return _error_response(
                        status.HTTP_409_CONFLICT,
                        detail="Project is archived",
                        error_code="PROJECT_ARCHIVED",
                    )
                project_id = int(project["id"])
                current = _stage_record(connection, project_id, stage_code)
                if current is None:
                    raise sqlite3.DatabaseError("project stage is missing")

                expected_revision = int(payload["expected_revision"])
                if int(current["revision"]) != expected_revision:
                    return _revision_conflict(connection, project_id, stage_code)

                from_status = str(current["status"])
                to_status = str(payload["to_status"])
                reason = payload["reason"]
                if to_status not in _ALLOWED_TRANSITIONS[from_status]:
                    return _error_response(
                        status.HTTP_409_CONFLICT,
                        detail="Invalid stage transition",
                        error_code="INVALID_STAGE_TRANSITION",
                    )
                if (
                    _transition_requires_reason(from_status, to_status)
                    and reason is None
                ):
                    return _error_response(
                        status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail="Invalid stage transition",
                        error_code="INVALID_STAGE_TRANSITION",
                        field_errors={"reason": ["Reason is required"]},
                    )

                occurred_at = str(payload["occurred_at"])
                started_at, blocked_at, completed_at = _transition_timestamps(
                    current,
                    to_status,
                    occurred_at,
                )
                resulting_revision = expected_revision + 1
                cursor = connection.execute(
                    """
                    UPDATE project_stages
                    SET status = ?, status_reason = ?, started_at = ?,
                        blocked_at = ?, completed_at = ?, revision = ?,
                        updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (
                        to_status,
                        reason,
                        started_at,
                        blocked_at,
                        completed_at,
                        resulting_revision,
                        timestamp,
                        current["id"],
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    return _revision_conflict(connection, project_id, stage_code)
                connection.execute(
                    """
                    INSERT INTO project_stage_events
                        (project_stage_id, from_status, to_status, reason,
                         occurred_at, resulting_revision, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        current["id"],
                        from_status,
                        to_status,
                        reason,
                        occurred_at,
                        resulting_revision,
                        timestamp,
                    ),
                )
                stage = _stage_by_code(connection, project_id, stage_code)
                if stage is None:
                    raise sqlite3.DatabaseError("transitioned project stage is missing")
                _store_idempotency_result(
                    connection,
                    scope=idempotency_scope,
                    key=idempotency_key,
                    request_hash=request_hash,
                    response=stage,
                    resource_id=int(current["id"]),
                    timestamp=timestamp,
                )
                return stage
        except sqlite3.Error as failure:
            return _database_error(failure)

    return router


async def _read_schedule_payload(request: Request) -> SchedulePayload:
    payload = await _read_json_object(
        request, _SCHEDULE_FIELDS, "Invalid stage payload"
    )
    planned_start_on = _normalize_date(payload["planned_start_on"])
    planned_end_on = _normalize_date(payload["planned_end_on"])
    if (
        planned_start_on is not None
        and planned_end_on is not None
        and planned_start_on > planned_end_on
    ):
        raise _invalid_stage_payload()
    return {
        "planned_start_on": planned_start_on,
        "planned_end_on": planned_end_on,
        "notes": _normalize_optional_text(payload["notes"], "Invalid stage payload"),
        "expected_revision": _normalize_revision(
            payload["expected_revision"],
            "Invalid stage payload",
        ),
    }


async def _read_transition_payload(request: Request) -> TransitionPayload:
    payload = await _read_json_object(
        request,
        _TRANSITION_FIELDS,
        "Invalid stage transition",
    )
    to_status = payload["to_status"]
    if not isinstance(to_status, str) or to_status not in _STAGE_STATUSES:
        raise _invalid_stage_transition()
    return {
        "to_status": to_status,
        "occurred_at": _normalize_timestamp(payload["occurred_at"]),
        "reason": _normalize_optional_text(
            payload["reason"],
            "Invalid stage transition",
        ),
        "expected_revision": _normalize_revision(
            payload["expected_revision"],
            "Invalid stage transition",
        ),
    }


def _read_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("idempotency-key")
    if len(values) != 1:
        raise _validation_error(
            detail="Invalid Idempotency-Key",
            error_code="INVALID_IDEMPOTENCY_KEY",
            field_errors={"Idempotency-Key": ["must occur once"]},
        )
    try:
        parsed = UUID(values[0])
    except (AttributeError, ValueError):
        raise _validation_error(
            detail="Invalid Idempotency-Key",
            error_code="INVALID_IDEMPOTENCY_KEY",
            field_errors={"Idempotency-Key": ["must be a UUID"]},
        ) from None
    return str(parsed)


async def _read_json_object(
    request: Request,
    fields: set[str],
    detail: str,
) -> dict[str, Any]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None
    if not isinstance(payload, dict) or set(payload) != fields:
        raise _invalid_payload(detail)
    return payload


def _read_project_code(project_code: str) -> str:
    try:
        return project_code_identity(normalize_project_code(project_code))
    except (TypeError, UnicodeError, ValueError):
        raise _validation_error(
            detail="Invalid project code",
            error_code="INVALID_PROJECT_CODE",
            field_errors={"project_code": ["is invalid"]},
        ) from None


def _read_stage_code(stage_code: str) -> str:
    if stage_code not in _STAGE_CODES:
        raise _validation_error(
            detail="Invalid stage code",
            error_code="INVALID_STAGE_CODE",
            field_errors={"stage_code": ["is invalid"]},
        )
    return stage_code


def _normalize_date(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or _ISO_DATE.fullmatch(value) is None:
        raise _invalid_stage_payload()
    try:
        date.fromisoformat(value)
    except ValueError:
        raise _invalid_stage_payload() from None
    return value


def _normalize_timestamp(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid_stage_transition()
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _invalid_stage_transition() from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _invalid_stage_transition()
    return parsed.astimezone(timezone.utc).isoformat()


def _normalize_optional_text(value: object, detail: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    normalized = value.strip()
    if not normalized:
        return None
    if "\x00" in normalized:
        raise _invalid_payload(detail)
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid_payload(detail) from None
    return normalized


def _normalize_revision(value: object, detail: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _invalid_payload(detail)
    return value


def _payload_hash(payload: TransitionPayload) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _idempotency_replay(
    connection: sqlite3.Connection,
    scope: str,
    key: str,
    request_hash: str,
) -> JSONResponse | None:
    previous = connection.execute(
        """
        SELECT request_sha256, response_status, response_json
        FROM idempotency_requests
        WHERE scope = ? AND idempotency_key = ?
        """,
        (scope, key),
    ).fetchone()
    if previous is None:
        return None
    if previous["request_sha256"] != request_hash:
        return _error_response(
            status.HTTP_409_CONFLICT,
            detail="Idempotency key was already used with different content",
            error_code="IDEMPOTENCY_CONFLICT",
        )
    try:
        restored = json.loads(previous["response_json"])
    except (TypeError, ValueError):
        raise sqlite3.DatabaseError("idempotency response is invalid JSON") from None
    if not isinstance(restored, dict):
        raise sqlite3.DatabaseError("idempotency response is not an object")
    return JSONResponse(
        status_code=int(previous["response_status"]),
        content=restored,
    )


def _store_idempotency_result(
    connection: sqlite3.Connection,
    *,
    scope: str,
    key: str,
    request_hash: str,
    response: dict[str, object],
    resource_id: int,
    timestamp: str,
) -> None:
    connection.execute(
        """
        INSERT INTO idempotency_requests
            (scope, idempotency_key, request_sha256, response_status,
             response_json, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, 200, ?, 'project_stage_transition', ?, ?)
        """,
        (
            scope,
            key,
            request_hash,
            json.dumps(response, ensure_ascii=False, sort_keys=True),
            resource_id,
            timestamp,
        ),
    )


def _project_by_key(
    connection: sqlite3.Connection,
    project_code_key: str,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT id, status FROM projects WHERE project_code_key = ?",
        (project_code_key,),
    ).fetchone()


def _stage_list(
    connection: sqlite3.Connection,
    project_id: int,
) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT
            stage_code, sequence, status, status_reason, planned_start_on,
            planned_end_on, started_at, blocked_at, completed_at, notes,
            revision
        FROM project_stages
        WHERE project_id = ?
        ORDER BY sequence
        """,
        (project_id,),
    ).fetchall()
    actual_catalog = tuple((row["stage_code"], row["sequence"]) for row in rows)
    if actual_catalog != _STAGE_CATALOG:
        raise sqlite3.DatabaseError("project stage catalog is incomplete")
    return [_stage_response(row) for row in rows]


def _stage_record(
    connection: sqlite3.Connection,
    project_id: int,
    stage_code: str,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            id, stage_code, status, status_reason, planned_start_on,
            planned_end_on, started_at, blocked_at, completed_at, notes,
            revision
        FROM project_stages
        WHERE project_id = ? AND stage_code = ?
        """,
        (project_id, stage_code),
    ).fetchone()


def _stage_by_code(
    connection: sqlite3.Connection,
    project_id: int,
    stage_code: str,
) -> dict[str, object] | None:
    row = _stage_record(connection, project_id, stage_code)
    return None if row is None else _stage_response(row)


def _stage_response(row: sqlite3.Row) -> dict[str, object]:
    return {field: row[field] for field in _STAGE_RESPONSE_FIELDS}


def _transition_requires_reason(from_status: str, to_status: str) -> bool:
    return to_status in {"blocked", "skipped"} or (
        from_status in {"blocked", "completed", "skipped"}
        and to_status == "in_progress"
    )


def _transition_timestamps(
    current: sqlite3.Row,
    to_status: str,
    occurred_at: str,
) -> tuple[str | None, str | None, str | None]:
    started_at = current["started_at"]
    if to_status == "in_progress":
        return started_at or occurred_at, None, None
    if to_status == "blocked":
        return started_at, occurred_at, None
    if to_status in {"completed", "skipped"}:
        return started_at, None, occurred_at
    raise ValueError(f"unsupported target status: {to_status}")


def _revision_conflict(
    connection: sqlite3.Connection,
    project_id: int,
    stage_code: str,
) -> JSONResponse:
    row = connection.execute(
        "SELECT revision FROM project_stages WHERE project_id = ? AND stage_code = ?",
        (project_id, stage_code),
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("project stage disappeared during update")
    return _error_response(
        status.HTTP_409_CONFLICT,
        detail="Resource was modified",
        error_code="REVISION_CONFLICT",
        current_revision=int(row["revision"]),
    )


def _error_response(
    status_code: int,
    *,
    detail: str,
    error_code: str,
    field_errors: dict[str, list[str]] | None = None,
    current_revision: int | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "detail": detail,
            "error_code": error_code,
            "field_errors": field_errors or {},
            "current_revision": current_revision,
        },
    )


def _database_error(failure: sqlite3.Error) -> JSONResponse:
    logger.exception(
        "Project stage database operation failed "
        "(sqlite_errorcode=%s, sqlite_errorname=%s)",
        getattr(failure, "sqlite_errorcode", None),
        getattr(failure, "sqlite_errorname", None),
    )
    return _error_response(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Project stage operation failed",
        error_code="PROJECT_STAGE_OPERATION_FAILED",
    )


def _invalid_stage_payload() -> ApiError:
    return _invalid_payload("Invalid stage payload")


def _invalid_stage_transition() -> ApiError:
    return _invalid_payload("Invalid stage transition")


def _invalid_payload(detail: str) -> ApiError:
    error_code = {
        "Invalid stage payload": "INVALID_STAGE_PAYLOAD",
        "Invalid stage transition": "INVALID_STAGE_TRANSITION",
    }[detail]
    return _validation_error(
        detail=detail,
        error_code=error_code,
    )


def _validation_error(
    *,
    detail: str,
    error_code: str,
    field_errors: dict[str, list[str]] | None = None,
) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail,
        error_code,
        field_errors=field_errors,
    )


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)
