from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.storage_paths import (
    normalize_project_code,
    project_code_identity,
)
from backend.app.features.api_common import ApiError, ApiErrorRoute
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

_SQLITE_MAX_INTEGER = 2**63 - 1
_WORKER_FIELDS = ("name", "phone", "notes")
_ASSIGNMENT_FIELDS = (
    "worker_id",
    "role",
    "scheduled_start_on",
    "scheduled_end_on",
    "pay_basis",
    "rate_cents",
    "notes",
)
_LABOR_ENTRY_FIELDS = (
    "assignment_id",
    "attendance_status",
    "day_fraction",
    "work_minutes",
    "work_summary",
    "notes",
    "expected_revision",
)
_WORKER_STATUSES = frozenset({"active", "inactive", "all"})
_ASSIGNMENT_STATUSES = frozenset({"planned", "active", "completed", "cancelled", "all"})
_ATTENDANCE_STATUSES = frozenset({"present", "absent", "leave"})
_PAY_BASES = frozenset({"daily", "hourly"})

Clock = Callable[[], datetime]


class WorkforceApiError(ApiError):
    pass


class WorkforceRoute(ApiErrorRoute):
    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Any:
            try:
                return await original(request)
            except sqlite3.Error:
                logger.exception("Workforce database operation failed")
                return JSONResponse(
                    {
                        "detail": "Workforce operation failed",
                        "error_code": "WORKFORCE_OPERATION_FAILED",
                        "field_errors": {},
                    },
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        return handler


def create_workforce_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=WorkforceRoute, tags=["workforce"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/workers")
    def list_workers(
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        page, page_size = _read_pagination(request)
        selected_status = _read_enum_query(
            request,
            "status",
            allowed=_WORKER_STATUSES,
            default="active",
            error_code="INVALID_WORKER_FILTER",
        )
        query = _read_optional_query(request, "query")
        return _list_workers(connection, page, page_size, selected_status, query)

    @router.post("/api/workers", status_code=status.HTTP_201_CREATED)
    async def create_worker(
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _normalize_worker_payload(
            await _read_json_object(request, _WORKER_FIELDS, "INVALID_WORKER_PAYLOAD")
        )
        key = _read_idempotency_key(request)
        timestamp = _timestamp(now)

        def operation() -> dict[str, object]:
            cursor = connection.execute(
                """
                INSERT INTO workers
                    (name, phone, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    payload["name"],
                    payload["phone"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            return _require_worker(connection, _last_insert_id(cursor))

        return _idempotent_operation(
            connection, request, key, payload, 201, operation, timestamp
        )

    @router.get("/api/workers/{worker_id}")
    def get_worker(
        worker_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        return _require_worker(connection, _parse_identifier(worker_id))

    @router.put("/api/workers/{worker_id}")
    async def update_worker(
        request: Request,
        worker_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(worker_id)
        fields = (*_WORKER_FIELDS, "expected_revision")
        raw = await _read_json_object(request, fields, "INVALID_WORKER_PAYLOAD")
        payload = _normalize_worker_payload(raw)
        expected_revision = _positive_integer(
            raw["expected_revision"], "expected_revision", "INVALID_WORKER_PAYLOAD"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            current = _require_worker(connection, identifier)
            _require_revision(current, expected_revision)
            connection.execute(
                """
                UPDATE workers
                SET name = ?, phone = ?, notes = ?, revision = revision + 1,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    payload["name"],
                    payload["phone"],
                    payload["notes"],
                    timestamp,
                    identifier,
                ),
            )
            return _require_worker(connection, identifier)

    @router.post("/api/workers/{worker_id}/deactivate")
    async def deactivate_worker(
        request: Request,
        worker_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(worker_id)
        fields = ("effective_on", "reason", "expected_revision")
        raw = await _read_json_object(request, fields, "INVALID_DEACTIVATION_PAYLOAD")
        payload = {
            "effective_on": _business_date(
                raw["effective_on"], "effective_on", "INVALID_DEACTIVATION_PAYLOAD"
            ),
            "reason": _required_text(
                raw["reason"], "reason", "INVALID_DEACTIVATION_PAYLOAD"
            ),
            "expected_revision": _positive_integer(
                raw["expected_revision"],
                "expected_revision",
                "INVALID_DEACTIVATION_PAYLOAD",
            ),
        }
        key = _read_idempotency_key(request)
        timestamp = _timestamp(now)

        def operation() -> dict[str, object]:
            current = _require_worker(connection, identifier)
            if current["status"] == "inactive":
                return current
            _require_revision(current, int(payload["expected_revision"]))
            connection.execute(
                """
                UPDATE workers
                SET status = 'inactive', inactive_on = ?, inactive_reason = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ?
                """,
                (payload["effective_on"], payload["reason"], timestamp, identifier),
            )
            return _require_worker(connection, identifier)

        return _idempotent_operation(
            connection, request, key, payload, 200, operation, timestamp
        )

    @router.get("/api/projects/{project_code}/crew-assignments")
    def list_assignments(
        request: Request,
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _require_project(connection, project_code)
        page, page_size = _read_pagination(request)
        selected_status = _read_enum_query(
            request,
            "status",
            allowed=_ASSIGNMENT_STATUSES,
            default="all",
            error_code="INVALID_ASSIGNMENT_FILTER",
        )
        return _list_assignments(
            connection, int(project["id"]), page, page_size, selected_status
        )

    @router.post(
        "/api/projects/{project_code}/crew-assignments",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_assignment(
        request: Request,
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _read_json_object(
            request, _ASSIGNMENT_FIELDS, "INVALID_ASSIGNMENT_PAYLOAD"
        )
        payload = _normalize_assignment_payload(raw)
        key = _read_idempotency_key(request)
        timestamp = _timestamp(now)

        def operation() -> dict[str, object]:
            project = _require_project(connection, project_code)
            _require_open_project(project)
            worker = _require_worker(connection, int(payload["worker_id"]))
            _require_active_worker(worker)
            cursor = connection.execute(
                """
                INSERT INTO crew_assignments
                    (project_id, worker_id, role, scheduled_start_on,
                     scheduled_end_on, pay_basis, rate_cents, notes,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    payload["worker_id"],
                    payload["role"],
                    payload["scheduled_start_on"],
                    payload["scheduled_end_on"],
                    payload["pay_basis"],
                    payload["rate_cents"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            return _require_assignment(
                connection, int(project["id"]), _last_insert_id(cursor)
            )

        return _idempotent_operation(
            connection, request, key, payload, 201, operation, timestamp
        )

    @router.put("/api/projects/{project_code}/crew-assignments/{assignment_id}")
    async def update_assignment(
        request: Request,
        project_code: str,
        assignment_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(assignment_id)
        fields = (*_ASSIGNMENT_FIELDS, "expected_revision")
        raw = await _read_json_object(request, fields, "INVALID_ASSIGNMENT_PAYLOAD")
        payload = _normalize_assignment_payload(raw)
        expected_revision = _positive_integer(
            raw["expected_revision"], "expected_revision", "INVALID_ASSIGNMENT_PAYLOAD"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _require_project(connection, project_code)
            _require_open_project(project)
            current = _require_assignment(connection, int(project["id"]), identifier)
            _require_revision(current, expected_revision)
            worker = _require_worker(connection, int(payload["worker_id"]))
            if int(current["worker_id"]) != int(worker["id"]):
                _require_active_worker(worker)
            connection.execute(
                """
                UPDATE crew_assignments
                SET worker_id = ?, role = ?, scheduled_start_on = ?,
                    scheduled_end_on = ?, pay_basis = ?, rate_cents = ?, notes = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND project_id = ?
                """,
                (
                    payload["worker_id"],
                    payload["role"],
                    payload["scheduled_start_on"],
                    payload["scheduled_end_on"],
                    payload["pay_basis"],
                    payload["rate_cents"],
                    payload["notes"],
                    timestamp,
                    identifier,
                    project["id"],
                ),
            )
            return _require_assignment(connection, int(project["id"]), identifier)

    @router.get("/api/projects/{project_code}/labor-entries")
    def list_labor_entries(
        request: Request,
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _require_project(connection, project_code)
        page, page_size = _read_pagination(request)
        date_from = _read_optional_date_query(request, "from")
        date_to = _read_optional_date_query(request, "to")
        if date_from is not None and date_to is not None and date_from > date_to:
            raise _validation_error(
                "INVALID_LABOR_FILTER", "from", "must not be after to"
            )
        worker_id = _read_optional_identifier_query(request, "worker_id")
        return _list_labor_entries(
            connection,
            int(project["id"]),
            page,
            page_size,
            date_from,
            date_to,
            worker_id,
        )

    @router.post("/api/projects/{project_code}/labor-entries/batch")
    async def save_labor_batch(
        request: Request,
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _read_json_object(
            request, ("work_date", "entries"), "INVALID_LABOR_BATCH_PAYLOAD"
        )
        payload = _normalize_labor_batch(raw)
        key = _read_idempotency_key(request)
        timestamp = _timestamp(now)

        def operation() -> dict[str, object]:
            project = _require_project(connection, project_code)
            items = _save_labor_entries(connection, project, payload, timestamp)
            return {"work_date": payload["work_date"], "items": items}

        return _idempotent_operation(
            connection, request, key, payload, 200, operation, timestamp
        )

    return router


def _list_workers(
    connection: sqlite3.Connection,
    page: int,
    page_size: int,
    selected_status: str,
    query: str | None,
) -> dict[str, object]:
    where: list[str] = []
    parameters: list[object] = []
    if selected_status != "all":
        where.append("status = ?")
        parameters.append(selected_status)
    if query is not None:
        where.append("(instr(name, ?) > 0 OR instr(coalesce(phone, ''), ?) > 0)")
        parameters.extend((query, query))
    clause = " WHERE " + " AND ".join(where) if where else ""
    total = connection.execute(
        f"SELECT COUNT(*) FROM workers{clause}",
        parameters,
    ).fetchone()[0]
    rows = connection.execute(
        f"""
        SELECT id, name, phone, notes, status, inactive_on, inactive_reason,
               revision, created_at, updated_at
        FROM workers{clause}
        ORDER BY name COLLATE NOCASE, id
        LIMIT ? OFFSET ?
        """,
        (*parameters, page_size, (page - 1) * page_size),
    ).fetchall()
    return _paged([_worker_response(row) for row in rows], total, page, page_size)


def _list_assignments(
    connection: sqlite3.Connection,
    project_id: int,
    page: int,
    page_size: int,
    selected_status: str,
) -> dict[str, object]:
    status_clause = "" if selected_status == "all" else " AND a.status = ?"
    parameters: tuple[object, ...] = (
        (project_id,) if selected_status == "all" else (project_id, selected_status)
    )
    total = connection.execute(
        f"SELECT COUNT(*) FROM crew_assignments a WHERE a.project_id = ?{status_clause}",
        parameters,
    ).fetchone()[0]
    rows = connection.execute(
        f"""
        SELECT a.id, p.project_code, a.worker_id, w.name AS worker_name,
               w.phone AS worker_phone, a.role, a.scheduled_start_on,
               a.scheduled_end_on, a.pay_basis, a.rate_cents, a.notes,
               a.status, a.revision, a.created_at, a.updated_at
        FROM crew_assignments a
        JOIN projects p ON p.id = a.project_id
        JOIN workers w ON w.id = a.worker_id
        WHERE a.project_id = ?{status_clause}
        ORDER BY a.scheduled_start_on, a.id
        LIMIT ? OFFSET ?
        """,
        (*parameters, page_size, (page - 1) * page_size),
    ).fetchall()
    return _paged([_assignment_response(row) for row in rows], total, page, page_size)


def _list_labor_entries(
    connection: sqlite3.Connection,
    project_id: int,
    page: int,
    page_size: int,
    date_from: str | None,
    date_to: str | None,
    worker_id: int | None,
) -> dict[str, object]:
    where = ["e.project_id = ?"]
    parameters: list[object] = [project_id]
    for field, operator, value in (
        ("e.work_date", ">=", date_from),
        ("e.work_date", "<=", date_to),
        ("e.worker_id", "=", worker_id),
    ):
        if value is not None:
            where.append(f"{field} {operator} ?")
            parameters.append(value)
    clause = " AND ".join(where)
    total = connection.execute(
        f"SELECT COUNT(*) FROM labor_entries e WHERE {clause}",
        parameters,
    ).fetchone()[0]
    rows = connection.execute(
        f"""
        {_LABOR_SELECT}
        WHERE {clause}
        ORDER BY e.work_date DESC, e.id DESC
        LIMIT ? OFFSET ?
        """,
        (*parameters, page_size, (page - 1) * page_size),
    ).fetchall()
    return _paged([_labor_response(row) for row in rows], total, page, page_size)


def _save_labor_entries(
    connection: sqlite3.Connection,
    project: dict[str, object],
    payload: dict[str, object],
    timestamp: str,
) -> list[dict[str, object]]:
    project_id = int(project["id"])
    work_date = str(payload["work_date"])
    normalized_entries = payload["entries"]
    if not isinstance(normalized_entries, list):
        raise TypeError("normalized entries must be a list")
    prepared_entries: list[
        tuple[dict[str, object], dict[str, object], dict[str, object] | None]
    ] = []
    seen_workers: set[int] = set()
    for index, entry in enumerate(normalized_entries):
        if not isinstance(entry, dict):
            raise TypeError("normalized entry must be an object")
        assignment = _require_assignment_for_labor(
            connection, project_id, int(entry["assignment_id"])
        )
        existing = _labor_by_assignment_date(
            connection, int(assignment["id"]), work_date
        )
        worker_id = int(
            existing["worker_id"] if existing is not None else assignment["worker_id"]
        )
        if worker_id in seen_workers:
            raise _validation_error(
                "DUPLICATE_WORKER_IN_LABOR_BATCH",
                f"entries.{index}.assignment_id",
                "worker already occurs in this batch",
            )
        seen_workers.add(worker_id)
        worker_entry = _labor_by_worker_date(
            connection, project_id, worker_id, work_date
        )
        if worker_entry is not None and (
            existing is None or int(worker_entry["id"]) != int(existing["id"])
        ):
            raise WorkforceApiError(
                status.HTTP_409_CONFLICT,
                "Worker already has a labor entry for this project and date",
                "WORKER_LABOR_ENTRY_EXISTS",
            )
        prepared_entries.append((entry, assignment, existing))

    saved_ids: list[int] = []
    for entry, assignment, existing in prepared_entries:
        if existing is None and project["status"] == "archived":
            raise WorkforceApiError(
                status.HTTP_409_CONFLICT,
                "Archived project cannot accept new labor entries",
                "PROJECT_ARCHIVED",
            )
        if existing is None:
            _require_worker_available_for_date(assignment, work_date)
        values = _labor_values(entry, assignment, existing)
        if existing is None:
            saved_ids.append(
                _insert_labor_entry(
                    connection, project_id, work_date, values, timestamp
                )
            )
        else:
            _require_labor_revision(existing, entry)
            _update_labor_entry(connection, int(existing["id"]), values, timestamp)
            saved_ids.append(int(existing["id"]))
    return [
        _require_labor_entry(connection, project_id, entry_id) for entry_id in saved_ids
    ]


def _labor_values(
    entry: dict[str, object],
    assignment: dict[str, object],
    existing: dict[str, object] | None,
) -> dict[str, object]:
    pay_basis = str(
        existing["pay_basis"] if existing is not None else assignment["pay_basis"]
    )
    rate_cents = int(
        existing["rate_cents"] if existing is not None else assignment["rate_cents"]
    )
    attendance = str(entry["attendance_status"])
    day_fraction_milli = entry["day_fraction_milli"]
    work_minutes = entry["work_minutes"]
    if attendance == "present" and pay_basis == "daily":
        if day_fraction_milli is None or work_minutes is not None:
            raise _validation_error(
                "INVALID_LABOR_BATCH_PAYLOAD",
                "entries",
                "daily work requires day_fraction only",
            )
        cost_cents = (rate_cents * int(day_fraction_milli) + 500) // 1000
    elif attendance == "present" and pay_basis == "hourly":
        if work_minutes is None or day_fraction_milli is not None:
            raise _validation_error(
                "INVALID_LABOR_BATCH_PAYLOAD",
                "entries",
                "hourly work requires work_minutes only",
            )
        cost_cents = (rate_cents * int(work_minutes) + 30) // 60
    elif attendance in {"absent", "leave"}:
        if day_fraction_milli is not None or work_minutes is not None:
            raise _validation_error(
                "INVALID_LABOR_BATCH_PAYLOAD",
                "entries",
                "absence or leave cannot contain paid quantity",
            )
        cost_cents = 0
    else:
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD",
            "attendance_status",
            "is incompatible with assignment pay basis",
        )
    if cost_cents > _SQLITE_MAX_INTEGER:
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD",
            "entries",
            "calculated cost is outside the supported range",
        )
    return {
        "assignment_id": assignment["id"],
        "worker_id": assignment["worker_id"],
        "attendance_status": attendance,
        "day_fraction_milli": day_fraction_milli,
        "work_minutes": work_minutes,
        "pay_basis": pay_basis,
        "rate_cents": rate_cents,
        "cost_cents": cost_cents,
        "work_summary": entry["work_summary"],
        "notes": entry["notes"],
    }


def _insert_labor_entry(
    connection: sqlite3.Connection,
    project_id: int,
    work_date: str,
    values: dict[str, object],
    timestamp: str,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO labor_entries
            (project_id, assignment_id, worker_id, work_date, attendance_status,
             day_fraction_milli, work_minutes, pay_basis, rate_cents, cost_cents,
             work_summary, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            values["assignment_id"],
            values["worker_id"],
            work_date,
            values["attendance_status"],
            values["day_fraction_milli"],
            values["work_minutes"],
            values["pay_basis"],
            values["rate_cents"],
            values["cost_cents"],
            values["work_summary"],
            values["notes"],
            timestamp,
            timestamp,
        ),
    )
    return _last_insert_id(cursor)


def _update_labor_entry(
    connection: sqlite3.Connection,
    entry_id: int,
    values: dict[str, object],
    timestamp: str,
) -> None:
    connection.execute(
        """
        UPDATE labor_entries
        SET attendance_status = ?, day_fraction_milli = ?, work_minutes = ?,
            cost_cents = ?, work_summary = ?, notes = ?, revision = revision + 1,
            updated_at = ?
        WHERE id = ?
        """,
        (
            values["attendance_status"],
            values["day_fraction_milli"],
            values["work_minutes"],
            values["cost_cents"],
            values["work_summary"],
            values["notes"],
            timestamp,
            entry_id,
        ),
    )


def _require_labor_revision(
    existing: dict[str, object],
    entry: dict[str, object],
) -> None:
    expected = entry["expected_revision"]
    if expected is None:
        if _labor_entry_matches(existing, entry):
            return
        raise _revision_conflict(int(existing["revision"]))
    if int(expected) != int(existing["revision"]):
        raise _revision_conflict(int(existing["revision"]))


def _labor_entry_matches(
    existing: dict[str, object],
    entry: dict[str, object],
) -> bool:
    return all(
        existing[field] == entry[field]
        for field in (
            "attendance_status",
            "day_fraction_milli",
            "work_minutes",
            "work_summary",
            "notes",
        )
    )


def _normalize_worker_payload(payload: dict[str, object]) -> dict[str, object]:
    return {
        "name": _required_text(payload["name"], "name", "INVALID_WORKER_PAYLOAD"),
        "phone": _optional_text(payload["phone"], "phone", "INVALID_WORKER_PAYLOAD"),
        "notes": _optional_text(payload["notes"], "notes", "INVALID_WORKER_PAYLOAD"),
    }


def _normalize_assignment_payload(payload: dict[str, object]) -> dict[str, object]:
    normalized: dict[str, object] = {
        "worker_id": _positive_integer(
            payload["worker_id"], "worker_id", "INVALID_ASSIGNMENT_PAYLOAD"
        ),
        "role": _required_text(payload["role"], "role", "INVALID_ASSIGNMENT_PAYLOAD"),
        "scheduled_start_on": _business_date(
            payload["scheduled_start_on"],
            "scheduled_start_on",
            "INVALID_ASSIGNMENT_PAYLOAD",
        ),
        "scheduled_end_on": _optional_business_date(
            payload["scheduled_end_on"],
            "scheduled_end_on",
            "INVALID_ASSIGNMENT_PAYLOAD",
        ),
        "pay_basis": _enum_value(
            payload["pay_basis"], "pay_basis", _PAY_BASES, "INVALID_ASSIGNMENT_PAYLOAD"
        ),
        "rate_cents": _nonnegative_integer(
            payload["rate_cents"], "rate_cents", "INVALID_ASSIGNMENT_PAYLOAD"
        ),
        "notes": _optional_text(
            payload["notes"], "notes", "INVALID_ASSIGNMENT_PAYLOAD"
        ),
    }
    end = normalized["scheduled_end_on"]
    if end is not None and str(end) < str(normalized["scheduled_start_on"]):
        raise _validation_error(
            "INVALID_ASSIGNMENT_PAYLOAD",
            "scheduled_end_on",
            "must not be before scheduled_start_on",
        )
    return normalized


def _normalize_labor_batch(payload: dict[str, object]) -> dict[str, object]:
    work_date = _business_date(
        payload["work_date"], "work_date", "INVALID_LABOR_BATCH_PAYLOAD"
    )
    entries = payload["entries"]
    if not isinstance(entries, list) or not entries:
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD", "entries", "must be a non-empty array"
        )
    normalized: list[dict[str, object]] = []
    seen_assignments: set[int] = set()
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict) or set(raw) != set(_LABOR_ENTRY_FIELDS):
            raise _validation_error(
                "INVALID_LABOR_BATCH_PAYLOAD", f"entries.{index}", "has invalid fields"
            )
        item = _normalize_labor_entry(raw, index)
        assignment_id = int(item["assignment_id"])
        if assignment_id in seen_assignments:
            raise _validation_error(
                "INVALID_LABOR_BATCH_PAYLOAD",
                f"entries.{index}.assignment_id",
                "is duplicated in this batch",
            )
        seen_assignments.add(assignment_id)
        normalized.append(item)
    return {"work_date": work_date, "entries": normalized}


def _normalize_labor_entry(
    payload: dict[str, object],
    index: int,
) -> dict[str, object]:
    prefix = f"entries.{index}"
    expected = payload["expected_revision"]
    if expected is not None:
        expected = _positive_integer(
            expected, f"{prefix}.expected_revision", "INVALID_LABOR_BATCH_PAYLOAD"
        )
    day_fraction, day_fraction_milli = _optional_day_fraction(
        payload["day_fraction"], f"{prefix}.day_fraction"
    )
    work_minutes = payload["work_minutes"]
    if work_minutes is not None:
        work_minutes = _bounded_integer(
            work_minutes,
            f"{prefix}.work_minutes",
            1,
            1440,
            "INVALID_LABOR_BATCH_PAYLOAD",
        )
    return {
        "assignment_id": _positive_integer(
            payload["assignment_id"],
            f"{prefix}.assignment_id",
            "INVALID_LABOR_BATCH_PAYLOAD",
        ),
        "attendance_status": _enum_value(
            payload["attendance_status"],
            f"{prefix}.attendance_status",
            _ATTENDANCE_STATUSES,
            "INVALID_LABOR_BATCH_PAYLOAD",
        ),
        "day_fraction": day_fraction,
        "day_fraction_milli": day_fraction_milli,
        "work_minutes": work_minutes,
        "work_summary": _optional_text(
            payload["work_summary"],
            f"{prefix}.work_summary",
            "INVALID_LABOR_BATCH_PAYLOAD",
        ),
        "notes": _optional_text(
            payload["notes"], f"{prefix}.notes", "INVALID_LABOR_BATCH_PAYLOAD"
        ),
        "expected_revision": expected,
    }


async def _read_json_object(
    request: Request,
    fields: tuple[str, ...],
    error_code: str,
) -> dict[str, object]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _validation_error(error_code, "body", "must be valid JSON") from None
    if not isinstance(payload, dict) or set(payload) != set(fields):
        raise _validation_error(error_code, "body", "has invalid fields")
    return payload


def _read_pagination(request: Request) -> tuple[int, int]:
    page = _read_positive_query_integer(request, "page", default=1, maximum=None)
    page_size = _read_positive_query_integer(
        request, "page_size", default=50, maximum=200
    )
    return page, page_size


def _read_positive_query_integer(
    request: Request,
    name: str,
    *,
    default: int,
    maximum: int | None,
) -> int:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1:
        raise _validation_error("INVALID_PAGINATION", name, "must occur once")
    value = _parse_ascii_integer(values[0], name, "INVALID_PAGINATION")
    if value < 1 or (maximum is not None and value > maximum):
        raise _validation_error("INVALID_PAGINATION", name, "is out of range")
    return value


def _read_enum_query(
    request: Request,
    name: str,
    *,
    allowed: frozenset[str],
    default: str,
    error_code: str,
) -> str:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or values[0] not in allowed:
        raise _validation_error(error_code, name, "has an invalid value")
    return values[0]


def _read_optional_query(request: Request, name: str) -> str | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _validation_error("INVALID_QUERY", name, "must occur once")
    return _optional_text(values[0], name, "INVALID_QUERY")


def _read_optional_date_query(request: Request, name: str) -> str | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _validation_error("INVALID_LABOR_FILTER", name, "must occur once")
    return _business_date(values[0], name, "INVALID_LABOR_FILTER")


def _read_optional_identifier_query(request: Request, name: str) -> int | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _validation_error("INVALID_LABOR_FILTER", name, "must occur once")
    return _parse_ascii_integer(values[0], name, "INVALID_LABOR_FILTER")


def _read_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("idempotency-key")
    if len(values) != 1:
        raise _validation_error(
            "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must occur once"
        )
    try:
        parsed = UUID(values[0])
    except (AttributeError, ValueError):
        raise _validation_error(
            "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must be a UUID"
        ) from None
    return str(parsed)


def _idempotent_operation(
    connection: sqlite3.Connection,
    request: Request,
    key: str,
    payload: dict[str, object],
    response_status: int,
    operation: Callable[[], dict[str, object]],
    timestamp: str,
) -> dict[str, object]:
    request_body = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    request_hash = hashlib.sha256(request_body.encode("utf-8")).hexdigest()
    path = request.url.path
    with transaction_immediate(connection):
        scope = f"POST:{path}"
        previous = connection.execute(
            """
            SELECT request_sha256, response_json
            FROM idempotency_requests
            WHERE scope = ? AND idempotency_key = ?
            """,
            (scope, key),
        ).fetchone()
        if previous is not None:
            if previous["request_sha256"] != request_hash:
                raise WorkforceApiError(
                    status.HTTP_409_CONFLICT,
                    "Idempotency key was already used with different content",
                    "IDEMPOTENCY_CONFLICT",
                )
            restored = json.loads(previous["response_json"])
            if not isinstance(restored, dict):
                raise sqlite3.DatabaseError("idempotency response is not an object")
            return restored
        response = operation()
        connection.execute(
            """
            INSERT INTO idempotency_requests
                (scope, idempotency_key, request_sha256, response_status,
                 response_json, resource_type, resource_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                scope,
                key,
                request_hash,
                response_status,
                json.dumps(response, ensure_ascii=False, sort_keys=True),
                "workforce",
                response.get("id"),
                timestamp,
            ),
        )
        return response


def _require_project(
    connection: sqlite3.Connection,
    project_code: str,
) -> dict[str, object]:
    try:
        normalized = normalize_project_code(project_code)
        key = project_code_identity(normalized)
    except (TypeError, UnicodeError, ValueError):
        raise _validation_error(
            "INVALID_PROJECT_CODE", "project_code", "is invalid"
        ) from None
    row = connection.execute(
        "SELECT id, project_code, status FROM projects WHERE project_code_key = ?",
        (key,),
    ).fetchone()
    if row is None:
        raise WorkforceApiError(
            status.HTTP_404_NOT_FOUND, "Project not found", "PROJECT_NOT_FOUND"
        )
    return {field: row[field] for field in ("id", "project_code", "status")}


def _require_open_project(project: dict[str, object]) -> None:
    if project["status"] == "archived":
        raise WorkforceApiError(
            status.HTTP_409_CONFLICT,
            "Archived project cannot accept new workforce records",
            "PROJECT_ARCHIVED",
        )


def _require_worker(
    connection: sqlite3.Connection,
    worker_id: int,
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT id, name, phone, notes, status, inactive_on, inactive_reason,
               revision, created_at, updated_at
        FROM workers WHERE id = ?
        """,
        (worker_id,),
    ).fetchone()
    if row is None:
        raise WorkforceApiError(
            status.HTTP_404_NOT_FOUND, "Worker not found", "WORKER_NOT_FOUND"
        )
    return _worker_response(row)


def _require_active_worker(worker: dict[str, object]) -> None:
    if worker["status"] != "active":
        raise WorkforceApiError(
            status.HTTP_409_CONFLICT,
            "Inactive worker cannot receive a new assignment",
            "WORKER_INACTIVE",
        )


def _require_assignment(
    connection: sqlite3.Connection,
    project_id: int,
    assignment_id: int,
) -> dict[str, object]:
    row = connection.execute(
        f"""
        {_ASSIGNMENT_SELECT}
        WHERE a.id = ? AND a.project_id = ?
        """,
        (assignment_id, project_id),
    ).fetchone()
    if row is None:
        raise WorkforceApiError(
            status.HTTP_404_NOT_FOUND,
            "Crew assignment not found",
            "ASSIGNMENT_NOT_FOUND",
        )
    return _assignment_response(row)


def _require_assignment_for_labor(
    connection: sqlite3.Connection,
    project_id: int,
    assignment_id: int,
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT a.id, a.project_id, a.worker_id, a.pay_basis, a.rate_cents,
               a.status, w.status AS worker_status, w.inactive_on
        FROM crew_assignments a
        JOIN workers w ON w.id = a.worker_id
        WHERE a.id = ? AND a.project_id = ?
        """,
        (assignment_id, project_id),
    ).fetchone()
    if row is None:
        raise WorkforceApiError(
            status.HTTP_404_NOT_FOUND,
            "Crew assignment not found",
            "ASSIGNMENT_NOT_FOUND",
        )
    fields = (
        "id",
        "project_id",
        "worker_id",
        "pay_basis",
        "rate_cents",
        "status",
        "worker_status",
        "inactive_on",
    )
    response = {field: row[field] for field in fields}
    if response["status"] == "cancelled":
        raise WorkforceApiError(
            status.HTTP_409_CONFLICT,
            "Cancelled assignment cannot receive labor entries",
            "ASSIGNMENT_CANCELLED",
        )
    return response


def _require_worker_available_for_date(
    assignment: dict[str, object],
    work_date: str,
) -> None:
    inactive_on = assignment["inactive_on"]
    if (
        assignment["worker_status"] == "inactive"
        and inactive_on is not None
        and str(inactive_on) <= work_date
    ):
        raise WorkforceApiError(
            status.HTTP_409_CONFLICT,
            "Inactive worker cannot receive a new labor entry",
            "WORKER_INACTIVE",
        )


def _labor_by_assignment_date(
    connection: sqlite3.Connection,
    assignment_id: int,
    work_date: str,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT id, worker_id, attendance_status, day_fraction_milli, work_minutes,
               pay_basis, rate_cents, work_summary, notes, status, revision
        FROM labor_entries
        WHERE assignment_id = ? AND work_date = ?
        """,
        (assignment_id, work_date),
    ).fetchone()
    if row is None:
        return None
    fields = (
        "id",
        "worker_id",
        "attendance_status",
        "day_fraction_milli",
        "work_minutes",
        "pay_basis",
        "rate_cents",
        "work_summary",
        "notes",
        "status",
        "revision",
    )
    return {field: row[field] for field in fields}


def _labor_by_worker_date(
    connection: sqlite3.Connection,
    project_id: int,
    worker_id: int,
    work_date: str,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT id, assignment_id
        FROM labor_entries
        WHERE project_id = ? AND worker_id = ? AND work_date = ?
        """,
        (project_id, worker_id, work_date),
    ).fetchone()
    if row is None:
        return None
    return {field: row[field] for field in ("id", "assignment_id")}


def _require_labor_entry(
    connection: sqlite3.Connection,
    project_id: int,
    entry_id: int,
) -> dict[str, object]:
    row = connection.execute(
        f"""
        {_LABOR_SELECT}
        WHERE e.id = ? AND e.project_id = ?
        """,
        (entry_id, project_id),
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("saved labor entry is missing")
    return _labor_response(row)


def _worker_response(row: sqlite3.Row) -> dict[str, object]:
    fields = (
        "id",
        "name",
        "phone",
        "notes",
        "status",
        "inactive_on",
        "inactive_reason",
        "revision",
        "created_at",
        "updated_at",
    )
    return {field: row[field] for field in fields}


def _assignment_response(row: sqlite3.Row) -> dict[str, object]:
    fields = (
        "id",
        "project_code",
        "worker_id",
        "worker_name",
        "worker_phone",
        "role",
        "scheduled_start_on",
        "scheduled_end_on",
        "pay_basis",
        "rate_cents",
        "notes",
        "status",
        "revision",
        "created_at",
        "updated_at",
    )
    return {field: row[field] for field in fields}


def _labor_response(row: sqlite3.Row) -> dict[str, object]:
    fields = (
        "id",
        "project_code",
        "assignment_id",
        "worker_id",
        "worker_name",
        "work_date",
        "attendance_status",
        "work_minutes",
        "pay_basis",
        "rate_cents",
        "cost_cents",
        "work_summary",
        "notes",
        "status",
        "revision",
        "created_at",
        "updated_at",
    )
    response = {field: row[field] for field in fields}
    milli = row["day_fraction_milli"]
    response["day_fraction"] = None if milli is None else f"{int(milli) / 1000:.3f}"
    return response


def _paged(
    items: list[dict[str, object]],
    total: int,
    page: int,
    page_size: int,
) -> dict[str, object]:
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def _require_revision(resource: dict[str, object], expected_revision: int) -> None:
    current = int(resource["revision"])
    if current != expected_revision:
        raise _revision_conflict(current)


def _revision_conflict(current_revision: int) -> WorkforceApiError:
    return WorkforceApiError(
        status.HTTP_409_CONFLICT,
        "Resource was modified",
        "REVISION_CONFLICT",
        current_revision=current_revision,
    )


def _validation_error(
    error_code: str,
    field: str,
    message: str,
) -> WorkforceApiError:
    return WorkforceApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "Invalid workforce payload",
        error_code,
        field_errors={field: message},
    )


def _required_text(value: object, field: str, error_code: str) -> str:
    normalized = _text(value, field, error_code)
    if not normalized:
        raise _validation_error(error_code, field, "must not be empty")
    return normalized


def _optional_text(value: object, field: str, error_code: str) -> str | None:
    if value is None:
        return None
    normalized = _text(value, field, error_code)
    return normalized or None


def _text(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _validation_error(error_code, field, "must be a string")
    normalized = value.strip()
    if "\x00" in normalized:
        raise _validation_error(error_code, field, "contains an invalid character")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _validation_error(error_code, field, "must be valid UTF-8") from None
    return normalized


def _business_date(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _validation_error(error_code, field, "must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise _validation_error(error_code, field, "must be YYYY-MM-DD") from None
    if parsed.isoformat() != value:
        raise _validation_error(error_code, field, "must be YYYY-MM-DD")
    return value


def _optional_business_date(
    value: object,
    field: str,
    error_code: str,
) -> str | None:
    if value is None:
        return None
    return _business_date(value, field, error_code)


def _enum_value(
    value: object,
    field: str,
    allowed: frozenset[str],
    error_code: str,
) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _validation_error(error_code, field, "has an invalid value")
    return value


def _positive_integer(value: object, field: str, error_code: str) -> int:
    return _bounded_integer(value, field, 1, _SQLITE_MAX_INTEGER, error_code)


def _nonnegative_integer(value: object, field: str, error_code: str) -> int:
    return _bounded_integer(value, field, 0, _SQLITE_MAX_INTEGER, error_code)


def _bounded_integer(
    value: object,
    field: str,
    minimum: int,
    maximum: int,
    error_code: str,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not minimum <= value <= maximum
    ):
        raise _validation_error(error_code, field, "is out of range")
    return value


def _parse_identifier(value: str) -> int:
    return _parse_ascii_integer(value, "identifier", "INVALID_IDENTIFIER")


def _parse_ascii_integer(value: str, field: str, error_code: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _validation_error(error_code, field, "must be a positive integer")
    identifier = int(value)
    if not 1 <= identifier <= _SQLITE_MAX_INTEGER:
        raise _validation_error(error_code, field, "must be a positive integer")
    return identifier


def _optional_day_fraction(
    value: object,
    field: str,
) -> tuple[str | None, int | None]:
    if value is None:
        return None, None
    if not isinstance(value, str):
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD", field, "must be a decimal string"
        )
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD", field, "must be a decimal string"
        ) from None
    if not parsed.is_finite() or parsed <= 0 or parsed > 1:
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD", field, "must be greater than 0 and at most 1"
        )
    milli = parsed * 1000
    if milli != milli.to_integral_value():
        raise _validation_error(
            "INVALID_LABOR_BATCH_PAYLOAD", field, "supports at most 3 decimal places"
        )
    return f"{parsed:.3f}", int(milli)


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


_ASSIGNMENT_SELECT = """
SELECT a.id, p.project_code, a.worker_id, w.name AS worker_name,
       w.phone AS worker_phone, a.role, a.scheduled_start_on,
       a.scheduled_end_on, a.pay_basis, a.rate_cents, a.notes,
       a.status, a.revision, a.created_at, a.updated_at
FROM crew_assignments a
JOIN projects p ON p.id = a.project_id
JOIN workers w ON w.id = a.worker_id
"""

_LABOR_SELECT = """
SELECT e.id, p.project_code, e.assignment_id, e.worker_id,
       w.name AS worker_name, e.work_date, e.attendance_status,
       e.day_fraction_milli, e.work_minutes, e.pay_basis, e.rate_cents,
       e.cost_cents, e.work_summary, e.notes, e.status, e.revision,
       e.created_at, e.updated_at
FROM labor_entries e
JOIN projects p ON p.id = e.project_id
JOIN workers w ON w.id = e.worker_id
"""
