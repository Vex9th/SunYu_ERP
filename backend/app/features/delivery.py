from __future__ import annotations

import calendar
import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from functools import wraps
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from backend.app.core.config import Settings
from backend.app.core.database import transaction, transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)
Clock = Callable[[], datetime]
_MAX_INT = 2**63 - 1
_BUSINESS_TIMEZONE = ZoneInfo("Asia/Shanghai")
_DISCIPLINES = ("mechanical", "electrical")
_SIGNOFF_STATUSES = frozenset({"pending", "confirmed", "not_required"})
_COMMISSIONING_STATUSES = frozenset(
    {"planned", "in_progress", "blocked", "completed", "cancelled"}
)
_CHANGE_STATUSES = frozenset(
    {"proposed", "approved", "rejected", "implemented", "cancelled"}
)
_CHANGE_SOURCES = frozenset(
    {
        "commissioning",
        "customer_request",
        "site_condition",
        "technical_agreement",
        "other",
    }
)
_CHANGE_TRANSITIONS = {
    "proposed": frozenset({"approved", "rejected", "cancelled"}),
    "approved": frozenset({"implemented", "cancelled"}),
    "rejected": frozenset(),
    "implemented": frozenset(),
    "cancelled": frozenset(),
}
_ACCEPTANCE_TYPES = frozenset({"pre_acceptance", "final", "reinspection"})
_ACCEPTANCE_RESULTS = frozenset({"passed", "passed_with_punch", "failed", "cancelled"})
_INVOICE_TYPES = frozenset(
    {"contract_payment", "additional_work", "warranty_service", "other"}
)
_INVOICE_STATUSES = frozenset({"planned", "requested", "recorded", "void"})
_COVERAGE_TYPES = frozenset({"warranty", "paid", "goodwill"})
_AFTER_SALES_STATUSES = frozenset({"open", "in_progress", "completed", "cancelled"})
_AFTER_SALES_TRANSITIONS = {
    "open": frozenset({"in_progress", "completed", "cancelled"}),
    "in_progress": frozenset({"completed", "cancelled"}),
    "completed": frozenset(),
    "cancelled": frozenset(),
}


class DeliveryError(ApiError):
    pass


class DeliveryRoute(ApiErrorRoute):
    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Any:
            try:
                return await original(request)
            except sqlite3.Error:
                logger.exception("Delivery database operation failed")
                return JSONResponse(
                    {
                        "detail": "Delivery operation failed",
                        "error_code": "DELIVERY_OPERATION_FAILED",
                        "field_errors": {},
                        "current_revision": None,
                    },
                    status_code=500,
                )

        return handler


def _deferred_snapshot(handler: Callable[..., Any]) -> Callable[..., Any]:
    @wraps(handler)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        connection = kwargs.get("connection")
        if not isinstance(connection, sqlite3.Connection):
            raise TypeError("snapshot endpoint requires a SQLite connection")
        with transaction(connection):
            return handler(*args, **kwargs)

    return wrapped


def create_delivery_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=DeliveryRoute, tags=["delivery"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request, settings: Settings = settings_dependency
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/projects/{project_code}/drawing-signoffs")
    @_deferred_snapshot
    def list_signoffs(
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> list[dict[str, object]]:
        project = _project(connection, project_code)
        rows = {
            row["discipline"]: row
            for row in connection.execute(
                "SELECT * FROM drawing_signoffs WHERE project_id = ?", (project["id"],)
            ).fetchall()
        }
        return [
            _signoff_response(connection, rows.get(discipline), project, discipline)
            for discipline in _DISCIPLINES
        ]

    @router.put("/api/projects/{project_code}/drawing-signoffs/{discipline}")
    async def put_signoff(
        project_code: str,
        discipline: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        if discipline not in _DISCIPLINES:
            raise _invalid(
                "INVALID_SIGNOFF_PAYLOAD", "discipline", "has an invalid value"
            )
        raw = await _json(
            request,
            (
                "status",
                "confirmed_on",
                "not_required_reason",
                "notes",
                "document_version_ids",
                "expected_revision",
            ),
            "INVALID_SIGNOFF_PAYLOAD",
        )
        payload = _signoff_payload(raw)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            _validate_documents(connection, project, payload["document_version_ids"])
            row = connection.execute(
                "SELECT * FROM drawing_signoffs WHERE project_id = ? AND discipline = ?",
                (project["id"], discipline),
            ).fetchone()
            if row is None:
                if payload["expected_revision"] is not None:
                    raise _revision(None)
                cursor = connection.execute(
                    """
                    INSERT INTO drawing_signoffs
                        (project_id, discipline, status, confirmed_on,
                         not_required_reason, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        discipline,
                        payload["status"],
                        payload["confirmed_on"],
                        payload["not_required_reason"],
                        payload["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                resource_id = _last_id(cursor)
            else:
                _require_revision(row, payload["expected_revision"])
                resource_id = int(row["id"])
                connection.execute(
                    """
                    UPDATE drawing_signoffs
                    SET status = ?, confirmed_on = ?, not_required_reason = ?, notes = ?,
                        revision = revision + 1, updated_at = ? WHERE id = ?
                    """,
                    (
                        payload["status"],
                        payload["confirmed_on"],
                        payload["not_required_reason"],
                        payload["notes"],
                        timestamp,
                        resource_id,
                    ),
                )
            _replace_links(
                connection,
                project,
                "drawing_signoff",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = connection.execute(
                "SELECT * FROM drawing_signoffs WHERE id = ?", (resource_id,)
            ).fetchone()
            response = _signoff_response(connection, row, project, discipline)
        return response

    @router.get("/api/projects/{project_code}/commissioning-sessions")
    @_deferred_snapshot
    def list_commissioning(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        page, size = _pagination(request)
        selected = _enum_query(
            request,
            "status",
            _COMMISSIONING_STATUSES | {"all"},
            "all",
            "INVALID_COMMISSIONING_FILTER",
        )
        return _list_resource(
            connection,
            "commissioning_sessions",
            project,
            page,
            size,
            selected,
            "status",
            _commissioning_response,
            "started_at DESC, id DESC",
        )

    @router.post("/api/projects/{project_code}/commissioning-sessions", status_code=201)
    async def create_commissioning(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _commissioning_payload(
            await _json(
                request, _COMMISSIONING_FIELDS, "INVALID_COMMISSIONING_PAYLOAD"
            ),
            updating=False,
        )
        key = _idempotency_key(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, "commissioning-sessions", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            _validate_documents(connection, project, payload["document_version_ids"])
            cursor = connection.execute(
                """
                INSERT INTO commissioning_sessions
                    (project_id, started_at, ended_at, status, summary, issues,
                     next_action, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    payload["started_at"],
                    payload["ended_at"],
                    payload["status"],
                    payload["summary"],
                    payload["issues"],
                    payload["next_action"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            resource_id = _last_id(cursor)
            _replace_links(
                connection,
                project,
                "commissioning_session",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "commissioning_sessions", project, resource_id)
            response = _commissioning_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=201,
                resource_type="commissioning_session",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.put("/api/projects/{project_code}/commissioning-sessions/{session_id}")
    async def update_commissioning(
        project_code: str,
        session_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _commissioning_payload(
            await _json(
                request,
                (*_COMMISSIONING_FIELDS, "expected_revision"),
                "INVALID_COMMISSIONING_PAYLOAD",
            ),
            updating=True,
        )
        resource_id = _identifier(session_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = _owned_row(connection, "commissioning_sessions", project, resource_id)
            _require_revision(row, payload["expected_revision"])
            _validate_documents(connection, project, payload["document_version_ids"])
            connection.execute(
                """
                UPDATE commissioning_sessions
                SET started_at = ?, ended_at = ?, status = ?, summary = ?, issues = ?,
                    next_action = ?, notes = ?, revision = revision + 1, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload["started_at"],
                    payload["ended_at"],
                    payload["status"],
                    payload["summary"],
                    payload["issues"],
                    payload["next_action"],
                    payload["notes"],
                    timestamp,
                    resource_id,
                ),
            )
            _replace_links(
                connection,
                project,
                "commissioning_session",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "commissioning_sessions", project, resource_id)
            response = _commissioning_response(connection, row, project)
        return response

    @router.get("/api/projects/{project_code}/engineering-changes")
    @_deferred_snapshot
    def list_changes(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        page, size = _pagination(request)
        selected = _enum_query(
            request,
            "status",
            _CHANGE_STATUSES | {"all"},
            "all",
            "INVALID_CHANGE_FILTER",
        )
        return _list_resource(
            connection,
            "engineering_changes",
            project,
            page,
            size,
            selected,
            "status",
            _change_response,
            "proposed_on DESC, id DESC",
        )

    @router.post("/api/projects/{project_code}/engineering-changes", status_code=201)
    async def create_change(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _change_payload(
            await _json(request, _CHANGE_FIELDS, "INVALID_CHANGE_PAYLOAD"),
            updating=False,
        )
        key = _idempotency_key(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, "engineering-changes", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            _validate_documents(connection, project, payload["document_version_ids"])
            number = int(
                connection.execute(
                    "SELECT COALESCE(MAX(change_number), 0) + 1 FROM engineering_changes WHERE project_id = ?",
                    (project["id"],),
                ).fetchone()[0]
            )
            cursor = connection.execute(
                """
                INSERT INTO engineering_changes
                    (project_id, change_number, source, title, description, reason,
                     contract_delta_cents, estimated_cost_delta_cents,
                     schedule_delta_days, proposed_on, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    number,
                    payload["source"],
                    payload["title"],
                    payload["description"],
                    payload["reason"],
                    payload["contract_delta_cents"],
                    payload["estimated_cost_delta_cents"],
                    payload["schedule_delta_days"],
                    payload["proposed_on"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            resource_id = _last_id(cursor)
            _replace_links(
                connection,
                project,
                "engineering_change",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "engineering_changes", project, resource_id)
            response = _change_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=201,
                resource_type="engineering_change",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.put("/api/projects/{project_code}/engineering-changes/{change_id}")
    async def update_change(
        project_code: str,
        change_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _change_payload(
            await _json(
                request,
                (*_CHANGE_FIELDS, "expected_revision"),
                "INVALID_CHANGE_PAYLOAD",
            ),
            updating=True,
        )
        resource_id = _identifier(change_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = _owned_row(connection, "engineering_changes", project, resource_id)
            _require_revision(row, payload["expected_revision"])
            if row["status"] != "proposed":
                raise _conflict("Only proposed changes can be edited", "CHANGE_LOCKED")
            _validate_documents(connection, project, payload["document_version_ids"])
            connection.execute(
                """
                UPDATE engineering_changes
                SET source = ?, title = ?, description = ?, reason = ?,
                    contract_delta_cents = ?, estimated_cost_delta_cents = ?,
                    schedule_delta_days = ?, proposed_on = ?, notes = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?
                """,
                (
                    payload["source"],
                    payload["title"],
                    payload["description"],
                    payload["reason"],
                    payload["contract_delta_cents"],
                    payload["estimated_cost_delta_cents"],
                    payload["schedule_delta_days"],
                    payload["proposed_on"],
                    payload["notes"],
                    timestamp,
                    resource_id,
                ),
            )
            _replace_links(
                connection,
                project,
                "engineering_change",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "engineering_changes", project, resource_id)
            response = _change_response(connection, row, project)
        return response

    @router.post(
        "/api/projects/{project_code}/engineering-changes/{change_id}/transition"
    )
    async def transition_change(
        project_code: str,
        change_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _json(
            request,
            ("to_status", "effective_on", "reason", "expected_revision"),
            "INVALID_CHANGE_TRANSITION",
        )
        to_status = _enum(
            payload["to_status"],
            "to_status",
            _CHANGE_STATUSES,
            "INVALID_CHANGE_TRANSITION",
        )
        effective_on = _business_date(
            payload["effective_on"], "effective_on", "INVALID_CHANGE_TRANSITION"
        )
        reason = _required_text(
            payload["reason"], "reason", "INVALID_CHANGE_TRANSITION"
        )
        expected = _positive(
            payload["expected_revision"],
            "expected_revision",
            "INVALID_CHANGE_TRANSITION",
        )
        normalized = {
            "to_status": to_status,
            "effective_on": effective_on,
            "reason": reason,
            "expected_revision": expected,
        }
        key = _idempotency_key(request)
        resource_id = _identifier(change_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection,
                project_code,
                f"engineering-changes/{resource_id}/transition",
                key,
                normalized,
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            row = _owned_row(connection, "engineering_changes", project, resource_id)
            _require_revision(row, expected)
            if to_status not in _CHANGE_TRANSITIONS[row["status"]]:
                raise _conflict(
                    "Invalid engineering change transition", "INVALID_CHANGE_TRANSITION"
                )
            from_status = str(row["status"])
            connection.execute(
                "UPDATE engineering_changes SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
                (to_status, timestamp, resource_id),
            )
            connection.execute(
                """
                INSERT INTO delivery_transition_events
                    (project_id, resource_type, resource_id, from_status, to_status,
                     effective_at, reason, resolution, created_at)
                VALUES (?, 'engineering_change', ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    project["id"],
                    resource_id,
                    from_status,
                    to_status,
                    effective_on,
                    reason,
                    timestamp,
                ),
            )
            row = _owned_row(connection, "engineering_changes", project, resource_id)
            response = _change_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=200,
                resource_type="engineering_change",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.get("/api/projects/{project_code}/acceptances")
    @_deferred_snapshot
    def list_acceptances(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        page, size = _pagination(request)
        return _list_resource(
            connection,
            "acceptances",
            project,
            page,
            size,
            "all",
            "status",
            _acceptance_response,
            "scheduled_on DESC, id DESC",
        )

    @router.post("/api/projects/{project_code}/acceptances", status_code=201)
    async def create_acceptance(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _json(
            request,
            ("acceptance_type", "scheduled_on", "notes"),
            "INVALID_ACCEPTANCE_PAYLOAD",
        )
        acceptance_type = _enum(
            raw["acceptance_type"],
            "acceptance_type",
            _ACCEPTANCE_TYPES,
            "INVALID_ACCEPTANCE_PAYLOAD",
        )
        scheduled_on = _business_date(
            raw["scheduled_on"], "scheduled_on", "INVALID_ACCEPTANCE_PAYLOAD"
        )
        notes = _optional_text(raw["notes"], "notes", "INVALID_ACCEPTANCE_PAYLOAD")
        payload = {
            "acceptance_type": acceptance_type,
            "scheduled_on": scheduled_on,
            "notes": notes,
        }
        key = _idempotency_key(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, "acceptances", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            cursor = connection.execute(
                """
                INSERT INTO acceptances
                    (project_id, acceptance_type, scheduled_on, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    acceptance_type,
                    scheduled_on,
                    notes,
                    timestamp,
                    timestamp,
                ),
            )
            resource_id = _last_id(cursor)
            row = _owned_row(connection, "acceptances", project, resource_id)
            response = _acceptance_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=201,
                resource_type="acceptance",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.post("/api/projects/{project_code}/acceptances/{acceptance_id}/complete")
    async def complete_acceptance(
        project_code: str,
        acceptance_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _json(
            request,
            (
                "performed_on",
                "result",
                "notes",
                "document_version_ids",
                "warranty",
                "expected_revision",
            ),
            "INVALID_ACCEPTANCE_COMPLETION",
        )
        performed_on = _business_date(
            raw["performed_on"], "performed_on", "INVALID_ACCEPTANCE_COMPLETION"
        )
        result = _enum(
            raw["result"],
            "result",
            _ACCEPTANCE_RESULTS,
            "INVALID_ACCEPTANCE_COMPLETION",
        )
        notes = _optional_text(raw["notes"], "notes", "INVALID_ACCEPTANCE_COMPLETION")
        documents = _document_ids(
            raw["document_version_ids"], "INVALID_ACCEPTANCE_COMPLETION"
        )
        expected = _positive(
            raw["expected_revision"],
            "expected_revision",
            "INVALID_ACCEPTANCE_COMPLETION",
        )
        warranty_payload = (
            _warranty_payload(
                raw["warranty"], "INVALID_ACCEPTANCE_COMPLETION", include_revision=False
            )
            if raw["warranty"] is not None
            else None
        )
        payload = {
            "performed_on": performed_on,
            "result": result,
            "notes": notes,
            "document_version_ids": documents,
            "warranty": warranty_payload,
            "expected_revision": expected,
        }
        key = _idempotency_key(request)
        resource_id = _identifier(acceptance_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection,
                project_code,
                f"acceptances/{resource_id}/complete",
                key,
                payload,
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            row = _owned_row(connection, "acceptances", project, resource_id)
            _require_revision(row, expected)
            if row["status"] != "scheduled":
                raise _conflict(
                    "Acceptance is already completed", "ACCEPTANCE_COMPLETED"
                )
            passed_final = row["acceptance_type"] == "final" and result in {
                "passed",
                "passed_with_punch",
            }
            if passed_final != (warranty_payload is not None):
                raise _invalid(
                    "INVALID_ACCEPTANCE_COMPLETION",
                    "warranty",
                    "is required exactly when final acceptance passes",
                )
            _validate_documents(connection, project, documents)
            connection.execute(
                """
                UPDATE acceptances
                SET performed_on = ?, status = ?, notes = ?, revision = revision + 1,
                    updated_at = ? WHERE id = ?
                """,
                (performed_on, result, notes, timestamp, resource_id),
            )
            _replace_links(
                connection, project, "acceptance", resource_id, documents, timestamp
            )
            warranty_row = None
            if warranty_payload is not None:
                if (
                    connection.execute(
                        "SELECT 1 FROM warranties WHERE project_id = ?",
                        (project["id"],),
                    ).fetchone()
                    is not None
                ):
                    raise _conflict("Project already has a warranty", "WARRANTY_EXISTS")
                ends_on = _add_months(
                    warranty_payload["starts_on"],
                    int(warranty_payload["duration_months"]),
                )
                cursor = connection.execute(
                    """
                    INSERT INTO warranties
                        (project_id, acceptance_id, starts_on, duration_months, ends_on,
                         renewal_price_cents, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        resource_id,
                        warranty_payload["starts_on"],
                        warranty_payload["duration_months"],
                        ends_on,
                        warranty_payload["renewal_price_cents"],
                        warranty_payload["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                warranty_row = connection.execute(
                    "SELECT * FROM warranties WHERE id = ?", (_last_id(cursor),)
                ).fetchone()
            row = _owned_row(connection, "acceptances", project, resource_id)
            response = {
                "acceptance": _acceptance_response(connection, row, project),
                "warranty": None
                if warranty_row is None
                else _warranty_response(warranty_row, now()),
            }
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=200,
                resource_type="acceptance",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.get("/api/projects/{project_code}/warranty")
    def get_warranty(
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object] | None:
        project = _project(connection, project_code)
        row = connection.execute(
            "SELECT * FROM warranties WHERE project_id = ?", (project["id"],)
        ).fetchone()
        return None if row is None else _warranty_response(row, now())

    @router.put("/api/projects/{project_code}/warranty")
    async def put_warranty(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _json(
            request,
            (
                "starts_on",
                "duration_months",
                "renewal_price_cents",
                "notes",
                "expected_revision",
            ),
            "INVALID_WARRANTY_PAYLOAD",
        )
        payload = _warranty_payload(
            raw, "INVALID_WARRANTY_PAYLOAD", include_revision=True
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = connection.execute(
                "SELECT * FROM warranties WHERE project_id = ?", (project["id"],)
            ).fetchone()
            if row is None:
                if payload["expected_revision"] is not None:
                    raise _revision(None)
                acceptance = connection.execute(
                    """
                    SELECT * FROM acceptances
                    WHERE project_id = ? AND acceptance_type = 'final'
                      AND status IN ('passed', 'passed_with_punch')
                    ORDER BY performed_on DESC, id DESC LIMIT 1
                    """,
                    (project["id"],),
                ).fetchone()
                if acceptance is None:
                    raise _conflict(
                        "Passed final acceptance is required", "ACCEPTANCE_REQUIRED"
                    )
                cursor = connection.execute(
                    """
                    INSERT INTO warranties
                        (project_id, acceptance_id, starts_on, duration_months, ends_on,
                         renewal_price_cents, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        acceptance["id"],
                        payload["starts_on"],
                        payload["duration_months"],
                        _add_months(
                            payload["starts_on"], int(payload["duration_months"])
                        ),
                        payload["renewal_price_cents"],
                        payload["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                warranty_id = _last_id(cursor)
            else:
                _require_revision(row, payload["expected_revision"])
                warranty_id = int(row["id"])
                connection.execute(
                    """
                    UPDATE warranties
                    SET starts_on = ?, duration_months = ?, ends_on = ?,
                        renewal_price_cents = ?, notes = ?, revision = revision + 1,
                        updated_at = ? WHERE id = ?
                    """,
                    (
                        payload["starts_on"],
                        payload["duration_months"],
                        _add_months(
                            payload["starts_on"], int(payload["duration_months"])
                        ),
                        payload["renewal_price_cents"],
                        payload["notes"],
                        timestamp,
                        warranty_id,
                    ),
                )
            row = connection.execute(
                "SELECT * FROM warranties WHERE id = ?", (warranty_id,)
            ).fetchone()
            response = _warranty_response(row, now())
        return response

    @router.get("/api/projects/{project_code}/invoices")
    @_deferred_snapshot
    def list_invoices(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        page, size = _pagination(request)
        invoice_type = _enum_query(
            request,
            "invoice_type",
            _INVOICE_TYPES | {"all"},
            "all",
            "INVALID_INVOICE_FILTER",
        )
        invoice_status = _enum_query(
            request,
            "status",
            _INVOICE_STATUSES | {"all"},
            "all",
            "INVALID_INVOICE_FILTER",
        )
        clauses = ["project_id = ?"]
        parameters: list[object] = [project["id"]]
        if invoice_type != "all":
            clauses.append("invoice_type = ?")
            parameters.append(invoice_type)
        if invoice_status != "all":
            clauses.append("status = ?")
            parameters.append(invoice_status)
        return _paged_query(
            connection,
            "project_invoices",
            project,
            page,
            size,
            clauses,
            parameters,
            _invoice_response,
            "id DESC",
        )

    @router.post("/api/projects/{project_code}/invoices", status_code=201)
    async def create_invoice(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _invoice_payload(
            await _json(request, _INVOICE_FIELDS, "INVALID_INVOICE_PAYLOAD"),
            updating=False,
        )
        key = _idempotency_key(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, "invoices", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            _validate_documents(connection, project, payload["document_version_ids"])
            cursor = connection.execute(
                """
                INSERT INTO project_invoices
                    (project_id, invoice_type, status, requested_on, recorded_on,
                     invoice_number, amount_cents, counterparty_name, notes,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    payload["invoice_type"],
                    payload["status"],
                    payload["requested_on"],
                    payload["recorded_on"],
                    payload["invoice_number"],
                    payload["amount_cents"],
                    payload["counterparty_name"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            resource_id = _last_id(cursor)
            _replace_links(
                connection,
                project,
                "invoice",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "project_invoices", project, resource_id)
            response = _invoice_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=201,
                resource_type="invoice",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.put("/api/projects/{project_code}/invoices/{invoice_id}")
    async def update_invoice(
        project_code: str,
        invoice_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _invoice_payload(
            await _json(
                request,
                (*_INVOICE_FIELDS, "expected_revision"),
                "INVALID_INVOICE_PAYLOAD",
            ),
            updating=True,
        )
        resource_id = _identifier(invoice_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = _owned_row(connection, "project_invoices", project, resource_id)
            _require_revision(row, payload["expected_revision"])
            if row["status"] == "void":
                raise _conflict("Voided invoice cannot be edited", "INVOICE_VOID")
            _validate_documents(connection, project, payload["document_version_ids"])
            connection.execute(
                """
                UPDATE project_invoices
                SET invoice_type = ?, status = ?, requested_on = ?, recorded_on = ?,
                    invoice_number = ?, amount_cents = ?, counterparty_name = ?, notes = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?
                """,
                (
                    payload["invoice_type"],
                    payload["status"],
                    payload["requested_on"],
                    payload["recorded_on"],
                    payload["invoice_number"],
                    payload["amount_cents"],
                    payload["counterparty_name"],
                    payload["notes"],
                    timestamp,
                    resource_id,
                ),
            )
            _replace_links(
                connection,
                project,
                "invoice",
                resource_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _owned_row(connection, "project_invoices", project, resource_id)
            response = _invoice_response(connection, row, project)
        return response

    @router.post("/api/projects/{project_code}/invoices/{invoice_id}/void")
    async def void_invoice(
        project_code: str,
        invoice_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _json(
            request, ("reason", "expected_revision"), "INVALID_INVOICE_VOID"
        )
        reason = _required_text(raw["reason"], "reason", "INVALID_INVOICE_VOID")
        expected = _positive(
            raw["expected_revision"], "expected_revision", "INVALID_INVOICE_VOID"
        )
        payload = {"reason": reason, "expected_revision": expected}
        key = _idempotency_key(request)
        resource_id = _identifier(invoice_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, f"invoices/{resource_id}/void", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            row = _owned_row(connection, "project_invoices", project, resource_id)
            _require_revision(row, expected)
            if row["status"] == "void":
                raise _conflict("Invoice is already void", "INVOICE_VOID")
            connection.execute(
                """
                UPDATE project_invoices
                SET status = 'void', void_reason = ?, revision = revision + 1,
                    updated_at = ? WHERE id = ?
                """,
                (reason, timestamp, resource_id),
            )
            row = _owned_row(connection, "project_invoices", project, resource_id)
            response = _invoice_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=200,
                resource_type="invoice",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.get("/api/projects/{project_code}/after-sales")
    @_deferred_snapshot
    def list_after_sales(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        page, size = _pagination(request)
        selected = _enum_query(
            request,
            "status",
            _AFTER_SALES_STATUSES | {"all"},
            "all",
            "INVALID_AFTER_SALES_FILTER",
        )
        return _list_resource(
            connection,
            "after_sales_cases",
            project,
            page,
            size,
            selected,
            "status",
            _after_sales_response,
            "reported_on DESC, id DESC",
        )

    @router.post("/api/projects/{project_code}/after-sales", status_code=201)
    async def create_after_sales(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _after_sales_payload(
            await _json(request, _AFTER_SALES_FIELDS, "INVALID_AFTER_SALES_PAYLOAD"),
            updating=False,
        )
        key = _idempotency_key(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection, project_code, "after-sales", key, payload
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            is_under_warranty = _is_under_warranty(
                connection, int(project["id"]), str(payload["reported_on"])
            )
            cursor = connection.execute(
                """
                INSERT INTO after_sales_cases
                    (project_id, reported_on, service_on, reason, contact_name,
                     contact_phone, coverage_type, notes, is_under_warranty,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    payload["reported_on"],
                    payload["service_on"],
                    payload["reason"],
                    payload["contact_name"],
                    payload["contact_phone"],
                    payload["coverage_type"],
                    payload["notes"],
                    int(is_under_warranty),
                    timestamp,
                    timestamp,
                ),
            )
            resource_id = _last_id(cursor)
            row = _owned_row(connection, "after_sales_cases", project, resource_id)
            response = _after_sales_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=201,
                resource_type="after_sales",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.put("/api/projects/{project_code}/after-sales/{case_id}")
    async def update_after_sales(
        project_code: str,
        case_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _after_sales_payload(
            await _json(
                request,
                (*_AFTER_SALES_FIELDS, "expected_revision"),
                "INVALID_AFTER_SALES_PAYLOAD",
            ),
            updating=True,
        )
        resource_id = _identifier(case_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = _owned_row(connection, "after_sales_cases", project, resource_id)
            _require_revision(row, payload["expected_revision"])
            if row["status"] in {"completed", "cancelled"}:
                raise _conflict(
                    "Closed after-sales case cannot be edited", "AFTER_SALES_CLOSED"
                )
            is_under_warranty = _is_under_warranty(
                connection, int(project["id"]), str(payload["reported_on"])
            )
            connection.execute(
                """
                UPDATE after_sales_cases
                SET reported_on = ?, service_on = ?, reason = ?, contact_name = ?,
                    contact_phone = ?, coverage_type = ?, notes = ?, is_under_warranty = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?
                """,
                (
                    payload["reported_on"],
                    payload["service_on"],
                    payload["reason"],
                    payload["contact_name"],
                    payload["contact_phone"],
                    payload["coverage_type"],
                    payload["notes"],
                    int(is_under_warranty),
                    timestamp,
                    resource_id,
                ),
            )
            row = _owned_row(connection, "after_sales_cases", project, resource_id)
            response = _after_sales_response(connection, row, project)
        return response

    @router.post("/api/projects/{project_code}/after-sales/{case_id}/transition")
    async def transition_after_sales(
        project_code: str,
        case_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        raw = await _json(
            request,
            ("to_status", "effective_at", "resolution", "reason", "expected_revision"),
            "INVALID_AFTER_SALES_TRANSITION",
        )
        to_status = _enum(
            raw["to_status"],
            "to_status",
            _AFTER_SALES_STATUSES,
            "INVALID_AFTER_SALES_TRANSITION",
        )
        effective_at = _aware_datetime(
            raw["effective_at"], "effective_at", "INVALID_AFTER_SALES_TRANSITION"
        )
        resolution = _optional_text(
            raw["resolution"], "resolution", "INVALID_AFTER_SALES_TRANSITION"
        )
        reason = _optional_text(
            raw["reason"], "reason", "INVALID_AFTER_SALES_TRANSITION"
        )
        if to_status == "completed" and resolution is None:
            raise _invalid(
                "INVALID_AFTER_SALES_TRANSITION",
                "resolution",
                "is required when completing a case",
            )
        if to_status == "cancelled" and reason is None:
            raise _invalid(
                "INVALID_AFTER_SALES_TRANSITION",
                "reason",
                "is required when cancelling a case",
            )
        expected = _positive(
            raw["expected_revision"],
            "expected_revision",
            "INVALID_AFTER_SALES_TRANSITION",
        )
        payload = {
            "to_status": to_status,
            "effective_at": effective_at,
            "resolution": resolution,
            "reason": reason,
            "expected_revision": expected,
        }
        key = _idempotency_key(request)
        resource_id = _identifier(case_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project, scope, request_hash, restored = _start_idempotent(
                connection,
                project_code,
                f"after-sales/{resource_id}/transition",
                key,
                payload,
            )
            if restored is not None:
                return restored
            _require_active_project_row(project)
            row = _owned_row(connection, "after_sales_cases", project, resource_id)
            _require_revision(row, expected)
            if to_status not in _AFTER_SALES_TRANSITIONS[row["status"]]:
                raise _conflict(
                    "Invalid after-sales transition", "INVALID_AFTER_SALES_TRANSITION"
                )
            from_status = str(row["status"])
            connection.execute(
                """
                UPDATE after_sales_cases
                SET status = ?, resolution = ?, completed_at = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?
                """,
                (
                    to_status,
                    resolution,
                    effective_at if to_status == "completed" else None,
                    timestamp,
                    resource_id,
                ),
            )
            connection.execute(
                """
                INSERT INTO delivery_transition_events
                    (project_id, resource_type, resource_id, from_status, to_status,
                     effective_at, reason, resolution, created_at)
                VALUES (?, 'after_sales', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    resource_id,
                    from_status,
                    to_status,
                    effective_at,
                    reason,
                    resolution,
                    timestamp,
                ),
            )
            row = _owned_row(connection, "after_sales_cases", project, resource_id)
            response = _after_sales_response(connection, row, project)
            _save_idempotent(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=200,
                resource_type="after_sales",
                resource_id=resource_id,
                timestamp=timestamp,
            )
        return response

    @router.get("/api/projects/{project_code}/delivery-summary")
    @_deferred_snapshot
    def delivery_summary(
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, project_code)
        project_id = int(project["id"])
        final_term = connection.execute(
            "SELECT due_on, planned_amount_cents FROM payment_terms WHERE project_id = ? AND milestone = 'final'",
            (project_id,),
        ).fetchone()
        received = int(
            connection.execute(
                """
            SELECT COALESCE(SUM(amount_cents), 0) FROM receipts
            WHERE project_id = ? AND milestone = 'final' AND status = 'active'
            """,
                (project_id,),
            ).fetchone()[0]
        )
        planned = 0 if final_term is None else int(final_term["planned_amount_cents"])
        invoice = connection.execute(
            """
            SELECT COUNT(*) AS count,
                   COALESCE(SUM(CASE WHEN status = 'recorded' THEN amount_cents ELSE 0 END), 0)
                       AS recorded
            FROM project_invoices WHERE project_id = ? AND status <> 'void'
            """,
            (project_id,),
        ).fetchone()
        after_sales = connection.execute(
            """
            SELECT COUNT(*) AS count,
                   SUM(CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END) AS open_count
            FROM after_sales_cases WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        labor = connection.execute(
            """
            SELECT COUNT(*) AS count, COALESCE(SUM(cost_cents), 0) AS cost
            FROM labor_entries WHERE project_id = ? AND status = 'active'
            """,
            (project_id,),
        ).fetchone()
        reports = connection.execute(
            """
            SELECT COUNT(*) AS count,
                   SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                   MAX(work_date) AS latest_work_date
            FROM site_daily_reports WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        material_cost = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(total_amount_cents), 0)
                FROM material_advances WHERE project_id = ? AND status = 'active'
                """,
                (project_id,),
            ).fetchone()[0]
        )
        commissioning = connection.execute(
            "SELECT status, COUNT(*) AS count FROM commissioning_sessions WHERE project_id = ? GROUP BY status",
            (project_id,),
        ).fetchall()
        acceptance = connection.execute(
            "SELECT * FROM acceptances WHERE project_id = ? ORDER BY scheduled_on DESC, id DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        warranty = connection.execute(
            "SELECT * FROM warranties WHERE project_id = ?", (project_id,)
        ).fetchone()
        todos: list[str] = []
        if planned > received:
            todos.append("final_payment_outstanding")
        if (
            warranty is not None
            and _warranty_response(warranty, now())["status"] == "expiring"
        ):
            todos.append("warranty_expiring")
        if int(after_sales["open_count"] or 0) > 0:
            todos.append("after_sales_open")
        return {
            "project_code": project["project_code"],
            "construction": {
                "labor_entry_count": labor["count"],
                "labor_cost_cents": labor["cost"],
                "daily_report_count": reports["count"],
                "confirmed_daily_report_count": int(reports["confirmed"] or 0),
                "latest_work_date": reports["latest_work_date"],
                "material_cost_cents": material_cost,
            },
            "commissioning": {row["status"]: row["count"] for row in commissioning},
            "latest_acceptance": (
                None
                if acceptance is None
                else _acceptance_response(connection, acceptance, project)
            ),
            "warranty": None
            if warranty is None
            else _warranty_response(warranty, now()),
            "final_payment": {
                "due_on": None if final_term is None else final_term["due_on"],
                "planned_amount_cents": planned,
                "received_amount_cents": received,
                "outstanding_amount_cents": max(planned - received, 0),
            },
            "invoices": {
                "count": invoice["count"],
                "recorded_amount_cents": invoice["recorded"],
            },
            "after_sales": {
                "count": after_sales["count"],
                "open_count": int(after_sales["open_count"] or 0),
            },
            "todos": todos,
        }

    return router


_COMMISSIONING_FIELDS = (
    "started_at",
    "ended_at",
    "status",
    "summary",
    "issues",
    "next_action",
    "notes",
    "document_version_ids",
)
_CHANGE_FIELDS = (
    "source",
    "title",
    "description",
    "reason",
    "contract_delta_cents",
    "estimated_cost_delta_cents",
    "schedule_delta_days",
    "proposed_on",
    "notes",
    "document_version_ids",
)
_INVOICE_FIELDS = (
    "invoice_type",
    "status",
    "requested_on",
    "recorded_on",
    "invoice_number",
    "amount_cents",
    "counterparty_name",
    "notes",
    "document_version_ids",
)
_AFTER_SALES_FIELDS = (
    "reported_on",
    "service_on",
    "reason",
    "contact_name",
    "contact_phone",
    "coverage_type",
    "notes",
)


def _signoff_payload(raw: dict[str, object]) -> dict[str, object]:
    selected = _enum(
        raw["status"], "status", _SIGNOFF_STATUSES, "INVALID_SIGNOFF_PAYLOAD"
    )
    confirmed = _optional_date(
        raw["confirmed_on"], "confirmed_on", "INVALID_SIGNOFF_PAYLOAD"
    )
    reason = _optional_text(
        raw["not_required_reason"], "not_required_reason", "INVALID_SIGNOFF_PAYLOAD"
    )
    if selected == "pending" and (confirmed is not None or reason is not None):
        raise _invalid("INVALID_SIGNOFF_PAYLOAD", "status", "does not match fields")
    if selected == "confirmed" and (confirmed is None or reason is not None):
        raise _invalid("INVALID_SIGNOFF_PAYLOAD", "status", "does not match fields")
    if selected == "not_required" and (confirmed is not None or reason is None):
        raise _invalid("INVALID_SIGNOFF_PAYLOAD", "status", "does not match fields")
    expected = raw["expected_revision"]
    if expected is not None:
        expected = _positive(expected, "expected_revision", "INVALID_SIGNOFF_PAYLOAD")
    return {
        "status": selected,
        "confirmed_on": confirmed,
        "not_required_reason": reason,
        "notes": _optional_text(raw["notes"], "notes", "INVALID_SIGNOFF_PAYLOAD"),
        "document_version_ids": _document_ids(
            raw["document_version_ids"], "INVALID_SIGNOFF_PAYLOAD"
        ),
        "expected_revision": expected,
    }


def _commissioning_payload(
    raw: dict[str, object], *, updating: bool
) -> dict[str, object]:
    started = _aware_datetime(
        raw["started_at"], "started_at", "INVALID_COMMISSIONING_PAYLOAD"
    )
    ended = _optional_datetime(
        raw["ended_at"], "ended_at", "INVALID_COMMISSIONING_PAYLOAD"
    )
    if ended is not None and ended < started:
        raise _invalid(
            "INVALID_COMMISSIONING_PAYLOAD", "ended_at", "must not be before started_at"
        )
    selected = _enum(
        raw["status"],
        "status",
        _COMMISSIONING_STATUSES,
        "INVALID_COMMISSIONING_PAYLOAD",
    )
    if selected in {"completed", "cancelled"} and ended is None:
        raise _invalid(
            "INVALID_COMMISSIONING_PAYLOAD",
            "ended_at",
            "is required for a closed session",
        )
    result: dict[str, object] = {
        "started_at": started,
        "ended_at": ended,
        "status": selected,
        "summary": _optional_text(
            raw["summary"], "summary", "INVALID_COMMISSIONING_PAYLOAD"
        ),
        "issues": _optional_text(
            raw["issues"], "issues", "INVALID_COMMISSIONING_PAYLOAD"
        ),
        "next_action": _optional_text(
            raw["next_action"], "next_action", "INVALID_COMMISSIONING_PAYLOAD"
        ),
        "notes": _optional_text(raw["notes"], "notes", "INVALID_COMMISSIONING_PAYLOAD"),
        "document_version_ids": _document_ids(
            raw["document_version_ids"], "INVALID_COMMISSIONING_PAYLOAD"
        ),
    }
    if updating:
        result["expected_revision"] = _positive(
            raw["expected_revision"],
            "expected_revision",
            "INVALID_COMMISSIONING_PAYLOAD",
        )
    return result


def _change_payload(raw: dict[str, object], *, updating: bool) -> dict[str, object]:
    result: dict[str, object] = {
        "source": _enum(
            raw["source"], "source", _CHANGE_SOURCES, "INVALID_CHANGE_PAYLOAD"
        ),
        "title": _required_text(raw["title"], "title", "INVALID_CHANGE_PAYLOAD"),
        "description": _required_text(
            raw["description"], "description", "INVALID_CHANGE_PAYLOAD"
        ),
        "reason": _optional_text(raw["reason"], "reason", "INVALID_CHANGE_PAYLOAD"),
        "contract_delta_cents": _signed(
            raw["contract_delta_cents"],
            "contract_delta_cents",
            "INVALID_CHANGE_PAYLOAD",
        ),
        "estimated_cost_delta_cents": _signed(
            raw["estimated_cost_delta_cents"],
            "estimated_cost_delta_cents",
            "INVALID_CHANGE_PAYLOAD",
        ),
        "schedule_delta_days": _signed(
            raw["schedule_delta_days"], "schedule_delta_days", "INVALID_CHANGE_PAYLOAD"
        ),
        "proposed_on": _business_date(
            raw["proposed_on"], "proposed_on", "INVALID_CHANGE_PAYLOAD"
        ),
        "notes": _optional_text(raw["notes"], "notes", "INVALID_CHANGE_PAYLOAD"),
        "document_version_ids": _document_ids(
            raw["document_version_ids"], "INVALID_CHANGE_PAYLOAD"
        ),
    }
    if updating:
        result["expected_revision"] = _positive(
            raw["expected_revision"], "expected_revision", "INVALID_CHANGE_PAYLOAD"
        )
    return result


def _warranty_payload(
    raw: object, error_code: str, *, include_revision: bool
) -> dict[str, object]:
    fields = {"starts_on", "duration_months", "renewal_price_cents", "notes"}
    if include_revision:
        fields.add("expected_revision")
    if not isinstance(raw, dict) or set(raw) != fields:
        raise _invalid(error_code, "warranty", "has invalid fields")
    duration = _positive(raw["duration_months"], "duration_months", error_code)
    if duration > 240:
        raise _invalid(error_code, "duration_months", "must not exceed 240")
    renewal = raw["renewal_price_cents"]
    if renewal is not None:
        renewal = _nonnegative(renewal, "renewal_price_cents", error_code)
    result: dict[str, object] = {
        "starts_on": _business_date(raw["starts_on"], "starts_on", error_code),
        "duration_months": duration,
        "renewal_price_cents": renewal,
        "notes": _optional_text(raw["notes"], "notes", error_code),
    }
    if include_revision:
        expected = raw["expected_revision"]
        result["expected_revision"] = (
            None
            if expected is None
            else _positive(expected, "expected_revision", error_code)
        )
    return result


def _invoice_payload(raw: dict[str, object], *, updating: bool) -> dict[str, object]:
    selected = _enum(
        raw["status"], "status", _INVOICE_STATUSES - {"void"}, "INVALID_INVOICE_PAYLOAD"
    )
    requested = _optional_date(
        raw["requested_on"], "requested_on", "INVALID_INVOICE_PAYLOAD"
    )
    recorded = _optional_date(
        raw["recorded_on"], "recorded_on", "INVALID_INVOICE_PAYLOAD"
    )
    invoice_number = _optional_text(
        raw["invoice_number"], "invoice_number", "INVALID_INVOICE_PAYLOAD"
    )
    amount = raw["amount_cents"]
    if amount is not None:
        amount = _nonnegative(amount, "amount_cents", "INVALID_INVOICE_PAYLOAD")
    if selected in {"requested", "recorded"} and requested is None:
        raise _invalid("INVALID_INVOICE_PAYLOAD", "requested_on", "is required")
    if selected == "recorded" and (
        recorded is None or invoice_number is None or amount is None
    ):
        raise _invalid(
            "INVALID_INVOICE_PAYLOAD",
            "status",
            "recorded invoice requires date, number and amount",
        )
    if requested is not None and recorded is not None and recorded < requested:
        raise _invalid(
            "INVALID_INVOICE_PAYLOAD",
            "recorded_on",
            "must not be before requested_on",
        )
    result: dict[str, object] = {
        "invoice_type": _enum(
            raw["invoice_type"],
            "invoice_type",
            _INVOICE_TYPES,
            "INVALID_INVOICE_PAYLOAD",
        ),
        "status": selected,
        "requested_on": requested,
        "recorded_on": recorded,
        "invoice_number": invoice_number,
        "amount_cents": amount,
        "counterparty_name": _optional_text(
            raw["counterparty_name"], "counterparty_name", "INVALID_INVOICE_PAYLOAD"
        ),
        "notes": _optional_text(raw["notes"], "notes", "INVALID_INVOICE_PAYLOAD"),
        "document_version_ids": _document_ids(
            raw["document_version_ids"], "INVALID_INVOICE_PAYLOAD"
        ),
    }
    if updating:
        result["expected_revision"] = _positive(
            raw["expected_revision"], "expected_revision", "INVALID_INVOICE_PAYLOAD"
        )
    return result


def _after_sales_payload(
    raw: dict[str, object], *, updating: bool
) -> dict[str, object]:
    reported_on = _business_date(
        raw["reported_on"], "reported_on", "INVALID_AFTER_SALES_PAYLOAD"
    )
    service_on = _optional_date(
        raw["service_on"], "service_on", "INVALID_AFTER_SALES_PAYLOAD"
    )
    if service_on is not None and service_on < reported_on:
        raise _invalid(
            "INVALID_AFTER_SALES_PAYLOAD",
            "service_on",
            "must not be before reported_on",
        )
    result: dict[str, object] = {
        "reported_on": reported_on,
        "service_on": service_on,
        "reason": _required_text(
            raw["reason"], "reason", "INVALID_AFTER_SALES_PAYLOAD"
        ),
        "contact_name": _optional_text(
            raw["contact_name"], "contact_name", "INVALID_AFTER_SALES_PAYLOAD"
        ),
        "contact_phone": _optional_text(
            raw["contact_phone"], "contact_phone", "INVALID_AFTER_SALES_PAYLOAD"
        ),
        "coverage_type": _enum(
            raw["coverage_type"],
            "coverage_type",
            _COVERAGE_TYPES,
            "INVALID_AFTER_SALES_PAYLOAD",
        ),
        "notes": _optional_text(raw["notes"], "notes", "INVALID_AFTER_SALES_PAYLOAD"),
    }
    if updating:
        result["expected_revision"] = _positive(
            raw["expected_revision"], "expected_revision", "INVALID_AFTER_SALES_PAYLOAD"
        )
    return result


def _signoff_response(
    connection: sqlite3.Connection,
    row: sqlite3.Row | None,
    project: sqlite3.Row,
    discipline: str,
) -> dict[str, object]:
    if row is None:
        return {
            "id": None,
            "project_code": project["project_code"],
            "discipline": discipline,
            "status": "pending",
            "confirmed_on": None,
            "not_required_reason": None,
            "notes": None,
            "document_version_ids": [],
            "revision": None,
            "created_at": None,
            "updated_at": None,
        }
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "discipline": row["discipline"],
        "status": row["status"],
        "confirmed_on": row["confirmed_on"],
        "not_required_reason": row["not_required_reason"],
        "notes": row["notes"],
        "document_version_ids": _links(connection, "drawing_signoff", int(row["id"])),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _commissioning_response(
    connection: sqlite3.Connection, row: sqlite3.Row, project: sqlite3.Row
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "status": row["status"],
        "summary": row["summary"],
        "issues": row["issues"],
        "next_action": row["next_action"],
        "notes": row["notes"],
        "document_version_ids": _links(
            connection, "commissioning_session", int(row["id"])
        ),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _change_response(
    connection: sqlite3.Connection, row: sqlite3.Row, project: sqlite3.Row
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "change_number": row["change_number"],
        "source": row["source"],
        "title": row["title"],
        "description": row["description"],
        "reason": row["reason"],
        "contract_delta_cents": row["contract_delta_cents"],
        "estimated_cost_delta_cents": row["estimated_cost_delta_cents"],
        "schedule_delta_days": row["schedule_delta_days"],
        "proposed_on": row["proposed_on"],
        "status": row["status"],
        "notes": row["notes"],
        "document_version_ids": _links(
            connection, "engineering_change", int(row["id"])
        ),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _acceptance_response(
    connection: sqlite3.Connection, row: sqlite3.Row, project: sqlite3.Row
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "acceptance_type": row["acceptance_type"],
        "scheduled_on": row["scheduled_on"],
        "performed_on": row["performed_on"],
        "status": row["status"],
        "notes": row["notes"],
        "document_version_ids": _links(connection, "acceptance", int(row["id"])),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _warranty_response(row: sqlite3.Row, current: datetime) -> dict[str, object]:
    today = _normalize_clock(current).astimezone(_BUSINESS_TIMEZONE).date()
    starts = date.fromisoformat(row["starts_on"])
    ends = date.fromisoformat(row["ends_on"])
    remaining = (ends - today).days
    if today < starts:
        selected = "not_started"
    elif remaining < 0:
        selected = "expired"
    elif remaining <= 30:
        selected = "expiring"
    else:
        selected = "active"
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "acceptance_id": row["acceptance_id"],
        "starts_on": row["starts_on"],
        "duration_months": row["duration_months"],
        "ends_on": row["ends_on"],
        "renewal_price_cents": row["renewal_price_cents"],
        "notes": row["notes"],
        "status": selected,
        "days_remaining": remaining,
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _invoice_response(
    connection: sqlite3.Connection, row: sqlite3.Row, project: sqlite3.Row
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "invoice_type": row["invoice_type"],
        "status": row["status"],
        "requested_on": row["requested_on"],
        "recorded_on": row["recorded_on"],
        "invoice_number": row["invoice_number"],
        "amount_cents": row["amount_cents"],
        "counterparty_name": row["counterparty_name"],
        "notes": row["notes"],
        "void_reason": row["void_reason"],
        "document_version_ids": _links(connection, "invoice", int(row["id"])),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _after_sales_response(
    connection: sqlite3.Connection, row: sqlite3.Row, project: sqlite3.Row
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project["project_code"],
        "reported_on": row["reported_on"],
        "service_on": row["service_on"],
        "reason": row["reason"],
        "contact_name": row["contact_name"],
        "contact_phone": row["contact_phone"],
        "coverage_type": row["coverage_type"],
        "is_under_warranty": bool(row["is_under_warranty"]),
        "status": row["status"],
        "resolution": row["resolution"],
        "completed_at": row["completed_at"],
        "notes": row["notes"],
        "document_version_ids": _links(connection, "after_sales", int(row["id"])),
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _list_resource(
    connection: sqlite3.Connection,
    table: str,
    project: sqlite3.Row,
    page: int,
    size: int,
    selected: str,
    field: str,
    response: Callable[
        [sqlite3.Connection, sqlite3.Row, sqlite3.Row], dict[str, object]
    ],
    order: str,
) -> dict[str, object]:
    clauses = ["project_id = ?"]
    parameters: list[object] = [project["id"]]
    if selected != "all":
        clauses.append(f"{field} = ?")
        parameters.append(selected)
    return _paged_query(
        connection, table, project, page, size, clauses, parameters, response, order
    )


def _paged_query(
    connection: sqlite3.Connection,
    table: str,
    project: sqlite3.Row,
    page: int,
    size: int,
    clauses: list[str],
    parameters: list[object],
    response: Callable[
        [sqlite3.Connection, sqlite3.Row, sqlite3.Row], dict[str, object]
    ],
    order: str,
) -> dict[str, object]:
    where = " AND ".join(clauses)
    total = int(
        connection.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {where}", parameters
        ).fetchone()[0]
    )
    rows = connection.execute(
        f"SELECT * FROM {table} WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
        (*parameters, size, (page - 1) * size),
    ).fetchall()
    return {
        "items": [response(connection, row, project) for row in rows],
        "total": total,
        "page": page,
        "page_size": size,
    }


def _project(connection: sqlite3.Connection, code: str) -> sqlite3.Row:
    try:
        key = project_code_identity(normalize_project_code(code))
    except (TypeError, UnicodeError, ValueError):
        raise _invalid("INVALID_PROJECT_CODE", "project_code", "is invalid") from None
    row = connection.execute(
        "SELECT id, project_code, status FROM projects WHERE project_code_key = ?",
        (key,),
    ).fetchone()
    if row is None:
        raise _not_found("Project not found", "PROJECT_NOT_FOUND")
    return row


def _active_project(connection: sqlite3.Connection, code: str) -> sqlite3.Row:
    row = _project(connection, code)
    if row["status"] != "active":
        raise _conflict("Project is archived", "PROJECT_ARCHIVED")
    return row


def _owned_row(
    connection: sqlite3.Connection, table: str, project: sqlite3.Row, resource_id: int
) -> sqlite3.Row:
    row = connection.execute(
        f"SELECT * FROM {table} WHERE project_id = ? AND id = ?",
        (project["id"], resource_id),
    ).fetchone()
    if row is None:
        raise _not_found("Delivery resource not found", "DELIVERY_RESOURCE_NOT_FOUND")
    return row


def _validate_documents(
    connection: sqlite3.Connection, project: sqlite3.Row, document_ids: object
) -> None:
    if not document_ids:
        return
    placeholders = ",".join("?" for _ in document_ids)
    found = connection.execute(
        f"""
        SELECT versions.id FROM document_versions versions
        JOIN documents ON documents.id = versions.document_id
        WHERE versions.id IN ({placeholders})
          AND documents.project_code = ? COLLATE NOCASE
          AND documents.archived_at IS NULL
        """,
        (*document_ids, project["project_code"]),
    ).fetchall()
    if {row[0] for row in found} != set(document_ids):
        raise _invalid(
            "INVALID_DOCUMENT_LINK",
            "document_version_ids",
            "must belong to the current project",
        )


def _is_under_warranty(
    connection: sqlite3.Connection, project_id: int, reported_on: str
) -> bool:
    return (
        connection.execute(
            """
            SELECT 1 FROM warranties
            WHERE project_id = ? AND starts_on <= ? AND ends_on >= ?
            """,
            (project_id, reported_on, reported_on),
        ).fetchone()
        is not None
    )


def _replace_links(
    connection: sqlite3.Connection,
    project: sqlite3.Row,
    resource_type: str,
    resource_id: int,
    document_ids: object,
    timestamp: str,
) -> None:
    connection.execute(
        "DELETE FROM workforce_document_links WHERE resource_type = ? AND resource_id = ?",
        (resource_type, resource_id),
    )
    for document_id in document_ids:
        connection.execute(
            """
            INSERT INTO workforce_document_links
                (project_id, resource_type, resource_id, document_version_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (project["id"], resource_type, resource_id, document_id, timestamp),
        )


def _links(
    connection: sqlite3.Connection, resource_type: str, resource_id: int
) -> list[int]:
    return [
        int(row[0])
        for row in connection.execute(
            """
            SELECT document_version_id FROM workforce_document_links
            WHERE resource_type = ? AND resource_id = ? ORDER BY document_version_id
            """,
            (resource_type, resource_id),
        ).fetchall()
    ]


async def _json(
    request: Request, fields: tuple[str, ...], error_code: str
) -> dict[str, object]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid(error_code, "body", "must be valid JSON") from None
    if not isinstance(payload, dict) or set(payload) != set(fields):
        raise _invalid(error_code, "body", "has invalid fields")
    return payload


def _pagination(request: Request) -> tuple[int, int]:
    page = _positive_query(request, "page", 1, _MAX_INT)
    size = _positive_query(request, "page_size", 50, 200)
    if page - 1 > _MAX_INT // size:
        raise _invalid("INVALID_PAGINATION", "page", "produces an invalid offset")
    return page, size


def _positive_query(request: Request, name: str, default: int, maximum: int) -> int:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or not values[0].isascii() or not values[0].isdecimal():
        raise _invalid("INVALID_PAGINATION", name, "must be a positive integer")
    value = int(values[0])
    if not 1 <= value <= maximum:
        raise _invalid("INVALID_PAGINATION", name, "is out of range")
    return value


def _enum_query(
    request: Request,
    name: str,
    allowed: frozenset[str] | set[str],
    default: str,
    error_code: str,
) -> str:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or values[0] not in allowed:
        raise _invalid(error_code, name, "has an invalid value")
    return values[0]


def _document_ids(value: object, error_code: str) -> list[int]:
    if not isinstance(value, list):
        raise _invalid(error_code, "document_version_ids", "must be an array")
    result = [_positive(item, "document_version_ids", error_code) for item in value]
    if len(set(result)) != len(result):
        raise _invalid(error_code, "document_version_ids", "contains duplicates")
    return result


def _idempotency_key(request: Request) -> str:
    values = request.headers.getlist("idempotency-key")
    if len(values) != 1:
        raise _invalid("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must occur once")
    try:
        return str(UUID(values[0]))
    except (AttributeError, ValueError):
        raise _invalid(
            "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key", "must be a UUID"
        ) from None


def _request_hash(payload: dict[str, object]) -> str:
    body = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(body.encode()).hexdigest()


def _start_idempotent(
    connection: sqlite3.Connection,
    project_code: str,
    suffix: str,
    key: str,
    payload: dict[str, object],
) -> tuple[sqlite3.Row, str, str, dict[str, object] | None]:
    project = _project(connection, project_code)
    scope = f"POST:/api/projects/{project['id']}/{suffix}"
    request_hash = _request_hash(payload)
    restored = restore_idempotent_response(
        connection, scope=scope, key=key, request_hash=request_hash
    )
    return project, scope, request_hash, restored


def _save_idempotent(
    connection: sqlite3.Connection,
    *,
    scope: str,
    key: str,
    request_hash: str,
    response: dict[str, object],
    response_status: int,
    resource_type: str,
    resource_id: int,
    timestamp: str,
) -> None:
    save_idempotent_response(
        connection,
        scope=scope,
        key=key,
        request_hash=request_hash,
        response=response,
        response_status=response_status,
        resource_type=resource_type,
        resource_id=resource_id,
        created_at=timestamp,
    )


def _require_active_project_row(project: sqlite3.Row) -> None:
    if project["status"] != "active":
        raise _conflict("Project is archived", "PROJECT_ARCHIVED")


def _business_date(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _invalid(error_code, field, "must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise _invalid(error_code, field, "must be YYYY-MM-DD") from None
    if parsed.isoformat() != value:
        raise _invalid(error_code, field, "must be YYYY-MM-DD")
    return value


def _optional_date(value: object, field: str, error_code: str) -> str | None:
    return None if value is None else _business_date(value, field, error_code)


def _aware_datetime(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _invalid(error_code, field, "must be an ISO 8601 datetime")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _invalid(error_code, field, "must be an ISO 8601 datetime") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _invalid(error_code, field, "must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat()


def _optional_datetime(value: object, field: str, error_code: str) -> str | None:
    return None if value is None else _aware_datetime(value, field, error_code)


def _enum(value: object, field: str, allowed: object, error_code: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _invalid(error_code, field, "has an invalid value")
    return value


def _text(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _invalid(error_code, field, "must be a string")
    result = value.strip()
    if "\x00" in result:
        raise _invalid(error_code, field, "contains an invalid character")
    try:
        result.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid(error_code, field, "must be valid UTF-8") from None
    return result


def _required_text(value: object, field: str, error_code: str) -> str:
    result = _text(value, field, error_code)
    if not result:
        raise _invalid(error_code, field, "must not be empty")
    return result


def _optional_text(value: object, field: str, error_code: str) -> str | None:
    if value is None:
        return None
    result = _text(value, field, error_code)
    return result or None


def _positive(value: object, field: str, error_code: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= _MAX_INT
    ):
        raise _invalid(error_code, field, "must be a positive integer")
    return value


def _nonnegative(value: object, field: str, error_code: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 0 <= value <= _MAX_INT
    ):
        raise _invalid(error_code, field, "must be a nonnegative integer")
    return value


def _signed(value: object, field: str, error_code: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not -_MAX_INT <= value <= _MAX_INT
    ):
        raise _invalid(error_code, field, "is out of range")
    return value


def _identifier(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid("INVALID_IDENTIFIER", "identifier", "must be a positive integer")
    return _positive(int(value), "identifier", "INVALID_IDENTIFIER")


def _require_revision(row: sqlite3.Row, expected: object) -> None:
    if expected is None or int(row["revision"]) != int(expected):
        raise _revision(int(row["revision"]))


def _add_months(value: object, months: int) -> str:
    start = date.fromisoformat(str(value))
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date(year, month, day).isoformat()


def _last_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not produce an identifier")
    return cursor.lastrowid


def _invalid(error_code: str, field: str, message: str) -> DeliveryError:
    return DeliveryError(
        422, "Invalid delivery payload", error_code, field_errors={field: message}
    )


def _not_found(detail: str, error_code: str) -> DeliveryError:
    return DeliveryError(404, detail, error_code)


def _conflict(detail: str, error_code: str) -> DeliveryError:
    return DeliveryError(409, detail, error_code)


def _revision(current: int | None) -> DeliveryError:
    return DeliveryError(
        409, "Resource was modified", "REVISION_CONFLICT", current_revision=current
    )


def _timestamp(clock: Clock) -> str:
    return _normalize_clock(clock()).isoformat()


def _normalize_clock(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)
