from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse

from backend.app.core.config import Settings
from backend.app.core.database import transaction, transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.api_common import ApiError, ApiErrorRoute
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
_MAX_INTEGER = 2**63 - 1
_QUANTITY = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$")
_REPORT_FIELDS = (
    "location",
    "weather",
    "work_summary",
    "blockers",
    "next_plan",
    "notes",
    "expected_revision",
)
_ADVANCE_FIELDS = (
    "worker_id",
    "spent_on",
    "vendor_name",
    "items",
    "notes",
    "document_version_ids",
)
_ITEM_FIELDS = (
    "name",
    "specification",
    "brand",
    "quantity",
    "unit",
    "unit_price_cents",
    "line_amount_cents",
)
_REIMBURSEMENT_FIELDS = (
    "amount_cents",
    "reimbursed_on",
    "payment_method",
    "notes",
)
_PAYMENT_METHODS = frozenset({"bank_transfer", "cash", "other"})
_ADVANCE_STATUSES = frozenset(
    {"unreimbursed", "partial", "reimbursed", "voided", "all"}
)


class SiteOperationsError(ApiError):
    pass


class SiteOperationsRoute(ApiErrorRoute):
    def get_route_handler(self) -> Callable[[Request], Any]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Any:
            try:
                return await original(request)
            except sqlite3.Error:
                logger.exception("Site operations database operation failed")
                return JSONResponse(
                    {
                        "detail": "Site operation failed",
                        "error_code": "SITE_OPERATION_FAILED",
                        "field_errors": {},
                        "current_revision": None,
                    },
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        return handler


def create_site_operations_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=SiteOperationsRoute, tags=["site-operations"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request, settings: Settings = settings_dependency
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/projects/{project_code}/site-daily-reports")
    def list_reports(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        page, page_size = _pagination(request)
        from_date = _optional_date_query(request, "from", "INVALID_REPORT_FILTER")
        to_date = _optional_date_query(request, "to", "INVALID_REPORT_FILTER")
        if from_date is not None and to_date is not None and from_date > to_date:
            raise _invalid("INVALID_REPORT_FILTER", "from", "must not be after to")
        clauses = ["project_id = ?"]
        parameters: list[object] = [0]
        if from_date is not None:
            clauses.append("work_date >= ?")
            parameters.append(from_date)
        if to_date is not None:
            clauses.append("work_date <= ?")
            parameters.append(to_date)
        where = " AND ".join(clauses)
        with transaction(connection):
            project = _project(connection, project_code)
            parameters[0] = project["id"]
            total = connection.execute(
                f"SELECT COUNT(*) FROM site_daily_reports WHERE {where}", parameters
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT * FROM site_daily_reports WHERE {where}
                ORDER BY work_date DESC, id DESC LIMIT ? OFFSET ?
                """,
                (*parameters, page_size, (page - 1) * page_size),
            ).fetchall()
            return _paged(
                [
                    _report_response(row, str(project["project_code"]))
                    for row in rows
                ],
                total,
                page,
                page_size,
            )

    @router.put("/api/projects/{project_code}/site-daily-reports/{work_date}")
    async def upsert_report(
        project_code: str,
        work_date: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _normalize_report(
            await _json_object(request, _REPORT_FIELDS, "INVALID_REPORT_PAYLOAD")
        )
        parsed_date = _business_date(work_date, "work_date", "INVALID_REPORT_PAYLOAD")
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = connection.execute(
                "SELECT * FROM site_daily_reports WHERE project_id = ? AND work_date = ?",
                (project["id"], parsed_date),
            ).fetchone()
            expected = payload["expected_revision"]
            if row is None:
                if expected is not None:
                    raise _revision_conflict(None)
                cursor = connection.execute(
                    """
                    INSERT INTO site_daily_reports
                        (project_id, work_date, location, weather, work_summary,
                         blockers, next_plan, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project["id"],
                        parsed_date,
                        payload["location"],
                        payload["weather"],
                        payload["work_summary"],
                        payload["blockers"],
                        payload["next_plan"],
                        payload["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                row = _report_row(connection, _last_id(cursor), int(project["id"]))
            else:
                _require_revision(row, expected)
                if row["status"] != "draft":
                    raise _conflict(
                        "Confirmed report must be reopened before editing",
                        "REPORT_CONFIRMED",
                    )
                connection.execute(
                    """
                    UPDATE site_daily_reports
                    SET location = ?, weather = ?, work_summary = ?, blockers = ?,
                        next_plan = ?, notes = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        payload["location"],
                        payload["weather"],
                        payload["work_summary"],
                        payload["blockers"],
                        payload["next_plan"],
                        payload["notes"],
                        timestamp,
                        row["id"],
                    ),
                )
                row = _report_row(connection, int(row["id"]), int(project["id"]))
        return _report_response(row, str(project["project_code"]))

    @router.post("/api/projects/{project_code}/site-daily-reports/{work_date}/confirm")
    async def confirm_report(
        project_code: str,
        work_date: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _json_object(
            request,
            ("confirmed_at", "expected_revision"),
            "INVALID_REPORT_CONFIRMATION",
        )
        confirmed_at = _aware_datetime(
            payload["confirmed_at"], "confirmed_at", "INVALID_REPORT_CONFIRMATION"
        )
        expected = _positive_integer(
            payload["expected_revision"],
            "expected_revision",
            "INVALID_REPORT_CONFIRMATION",
        )
        key = _idempotency_key(request)
        normalized = {
            "confirmed_at": confirmed_at,
            "expected_revision": expected,
        }
        return _transition_report(
            connection,
            project_code,
            work_date,
            expected,
            key=key,
            request_hash=_payload_hash(normalized),
            action="confirm",
            from_status="draft",
            to_status="confirmed",
            confirmed_at=confirmed_at,
            reason=None,
            timestamp=_timestamp(now),
        )

    @router.post("/api/projects/{project_code}/site-daily-reports/{work_date}/reopen")
    async def reopen_report(
        project_code: str,
        work_date: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _json_object(
            request, ("reason", "expected_revision"), "INVALID_REPORT_REOPEN"
        )
        reason = _required_text(payload["reason"], "reason", "INVALID_REPORT_REOPEN")
        expected = _positive_integer(
            payload["expected_revision"], "expected_revision", "INVALID_REPORT_REOPEN"
        )
        key = _idempotency_key(request)
        normalized = {"reason": reason, "expected_revision": expected}
        return _transition_report(
            connection,
            project_code,
            work_date,
            expected,
            key=key,
            request_hash=_payload_hash(normalized),
            action="reopen",
            from_status="confirmed",
            to_status="draft",
            confirmed_at=None,
            reason=reason,
            timestamp=_timestamp(now),
        )

    @router.get("/api/projects/{project_code}/material-advances")
    def list_advances(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        page, page_size = _pagination(request)
        selected_status = _enum_query(
            request, "status", _ADVANCE_STATUSES, "all", "INVALID_ADVANCE_FILTER"
        )
        worker_id = _optional_identifier_query(
            request, "worker_id", "INVALID_ADVANCE_FILTER"
        )
        with transaction(connection):
            project = _project(connection, project_code)
            rows = connection.execute(
                """
                SELECT a.*, w.name AS worker_name,
                       COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.amount_cents ELSE 0 END), 0)
                           AS reimbursed_amount_cents
                FROM material_advances a
                JOIN workers w ON w.id = a.worker_id
                LEFT JOIN advance_reimbursements r ON r.advance_id = a.id
                WHERE a.project_id = ?
                GROUP BY a.id ORDER BY a.spent_on DESC, a.id DESC
                """,
                (project["id"],),
            ).fetchall()
            filtered = [
                row
                for row in rows
                if (worker_id is None or row["worker_id"] == worker_id)
                and (
                    selected_status == "all"
                    or _advance_status(row) == selected_status
                )
            ]
            offset = (page - 1) * page_size
            items = [
                _advance_summary(connection, row, str(project["project_code"]))
                for row in filtered[offset : offset + page_size]
            ]
            return _paged(items, len(filtered), page, page_size)

    @router.post(
        "/api/projects/{project_code}/material-advances",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_advance(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _normalize_advance(
            await _json_object(request, _ADVANCE_FIELDS, "INVALID_ADVANCE_PAYLOAD"),
            updating=False,
        )
        key = _idempotency_key(request)
        request_hash = _payload_hash(payload)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _project(connection, project_code)
            scope = f"POST:/api/projects/{project['id']}/material-advances"
            restored = _restore_idempotency(connection, scope, key, request_hash)
            if restored is not None:
                return restored
            if project["status"] != "active":
                raise _conflict("Project is archived", "PROJECT_ARCHIVED")
            _validate_advance_references(connection, project, payload)
            cursor = connection.execute(
                """
                INSERT INTO material_advances
                    (project_id, worker_id, spent_on, vendor_name,
                     total_amount_cents, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    payload["worker_id"],
                    payload["spent_on"],
                    payload["vendor_name"],
                    payload["total_amount_cents"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            advance_id = _last_id(cursor)
            _replace_items(connection, advance_id, payload["items"])
            _replace_documents(
                connection,
                int(project["id"]),
                advance_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _advance_row(connection, int(project["id"]), advance_id)
            response = _advance_detail(connection, row, str(project["project_code"]))
            _save_idempotency(
                connection,
                scope,
                key,
                request_hash,
                response,
                advance_id,
                timestamp,
                response_status=201,
                resource_type="material_advance",
            )
            return response

    @router.get("/api/projects/{project_code}/material-advances/{advance_id}")
    def get_advance(
        project_code: str,
        advance_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        with transaction(connection):
            project = _project(connection, project_code)
            row = _advance_row(
                connection, int(project["id"]), _identifier(advance_id)
            )
            return _advance_detail(connection, row, str(project["project_code"]))

    @router.put("/api/projects/{project_code}/material-advances/{advance_id}")
    async def update_advance(
        project_code: str,
        advance_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _normalize_advance(
            await _json_object(
                request,
                (*_ADVANCE_FIELDS, "expected_revision"),
                "INVALID_ADVANCE_PAYLOAD",
            ),
            updating=True,
        )
        parsed_id = _identifier(advance_id)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, project_code)
            row = _advance_row(connection, int(project["id"]), parsed_id)
            _require_revision(row, payload["expected_revision"])
            _require_unreimbursed(connection, row)
            _validate_advance_references(connection, project, payload)
            connection.execute(
                """
                UPDATE material_advances
                SET worker_id = ?, spent_on = ?, vendor_name = ?,
                    total_amount_cents = ?, notes = ?, revision = revision + 1,
                    updated_at = ? WHERE id = ?
                """,
                (
                    payload["worker_id"],
                    payload["spent_on"],
                    payload["vendor_name"],
                    payload["total_amount_cents"],
                    payload["notes"],
                    timestamp,
                    parsed_id,
                ),
            )
            _replace_items(connection, parsed_id, payload["items"])
            _replace_documents(
                connection,
                int(project["id"]),
                parsed_id,
                payload["document_version_ids"],
                timestamp,
            )
            row = _advance_row(connection, int(project["id"]), parsed_id)
            return _advance_detail(connection, row, str(project["project_code"]))

    @router.post(
        "/api/projects/{project_code}/material-advances/{advance_id}/reimbursements",
        status_code=status.HTTP_201_CREATED,
    )
    async def reimburse_advance(
        project_code: str,
        advance_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = _normalize_reimbursement(
            await _json_object(
                request, _REIMBURSEMENT_FIELDS, "INVALID_REIMBURSEMENT_PAYLOAD"
            )
        )
        key = _idempotency_key(request)
        parsed_id = _identifier(advance_id)
        timestamp = _timestamp(now)
        request_hash = _payload_hash(payload)
        with transaction_immediate(connection):
            project = _project(connection, project_code)
            scope = f"POST:/api/projects/{project['id']}/material-advances/{parsed_id}/reimbursements"
            restored = _restore_idempotency(connection, scope, key, request_hash)
            if restored is not None:
                return restored
            if project["status"] != "active":
                raise _conflict("Project is archived", "PROJECT_ARCHIVED")
            row = _advance_row(connection, int(project["id"]), parsed_id)
            if row["status"] == "voided":
                raise _conflict("Voided advance cannot be reimbursed", "ADVANCE_VOIDED")
            reimbursed = _reimbursed_total(connection, parsed_id)
            amount = int(payload["amount_cents"])
            if reimbursed + amount > int(row["total_amount_cents"]):
                raise _conflict(
                    "Reimbursement exceeds advance total", "REIMBURSEMENT_EXCEEDS_TOTAL"
                )
            cursor = connection.execute(
                """
                INSERT INTO advance_reimbursements
                    (advance_id, amount_cents, reimbursed_on, payment_method,
                     notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    parsed_id,
                    amount,
                    payload["reimbursed_on"],
                    payload["payment_method"],
                    payload["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            reimbursement_id = _last_id(cursor)
            connection.execute(
                "UPDATE material_advances SET revision = revision + 1, updated_at = ? WHERE id = ?",
                (timestamp, parsed_id),
            )
            response = _reimbursement_response(connection, reimbursement_id, parsed_id)
            _save_idempotency(
                connection,
                scope,
                key,
                request_hash,
                response,
                reimbursement_id,
                timestamp,
                response_status=201,
                resource_type="advance_reimbursement",
            )
        return response

    @router.post("/api/projects/{project_code}/material-advances/{advance_id}/void")
    async def void_advance(
        project_code: str,
        advance_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _json_object(
            request, ("reason", "expected_revision"), "INVALID_ADVANCE_VOID"
        )
        reason = _required_text(payload["reason"], "reason", "INVALID_ADVANCE_VOID")
        expected = _positive_integer(
            payload["expected_revision"], "expected_revision", "INVALID_ADVANCE_VOID"
        )
        parsed_id = _identifier(advance_id)
        key = _idempotency_key(request)
        normalized = {"reason": reason, "expected_revision": expected}
        request_hash = _payload_hash(normalized)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _project(connection, project_code)
            scope = (
                f"POST:/api/projects/{project['id']}/material-advances/{parsed_id}/void"
            )
            restored = _restore_idempotency(connection, scope, key, request_hash)
            if restored is not None:
                return restored
            if project["status"] != "active":
                raise _conflict("Project is archived", "PROJECT_ARCHIVED")
            row = _advance_row(connection, int(project["id"]), parsed_id)
            _require_revision(row, expected)
            _require_unreimbursed(connection, row)
            connection.execute(
                """
                UPDATE material_advances
                SET status = 'voided', void_reason = ?, voided_at = ?,
                    revision = revision + 1, updated_at = ? WHERE id = ?
                """,
                (reason, timestamp, timestamp, parsed_id),
            )
            row = _advance_row(connection, int(project["id"]), parsed_id)
            response = _advance_detail(
                connection, row, str(project["project_code"])
            )
            _save_idempotency(
                connection,
                scope,
                key,
                request_hash,
                response,
                parsed_id,
                timestamp,
                response_status=200,
                resource_type="material_advance_void",
            )
            return response

    return router


def _transition_report(
    connection: sqlite3.Connection,
    project_code: str,
    work_date: str,
    expected_revision: int,
    *,
    key: str,
    request_hash: str,
    action: str,
    from_status: str,
    to_status: str,
    confirmed_at: str | None,
    reason: str | None,
    timestamp: str,
) -> dict[str, object]:
    parsed_date = _business_date(work_date, "work_date", "INVALID_REPORT_PAYLOAD")
    with transaction_immediate(connection):
        project = _project(connection, project_code)
        scope = (
            f"POST:/api/projects/{project['id']}/site-daily-reports/"
            f"{parsed_date}/{action}"
        )
        restored = _restore_idempotency(connection, scope, key, request_hash)
        if restored is not None:
            return restored
        if project["status"] != "active":
            raise _conflict("Project is archived", "PROJECT_ARCHIVED")
        row = connection.execute(
            "SELECT * FROM site_daily_reports WHERE project_id = ? AND work_date = ?",
            (project["id"], parsed_date),
        ).fetchone()
        if row is None:
            raise _not_found("Daily report not found", "REPORT_NOT_FOUND")
        _require_revision(row, expected_revision)
        if row["status"] != from_status:
            raise _conflict(
                "Daily report has an invalid status", "INVALID_REPORT_STATUS"
            )
        connection.execute(
            """
            UPDATE site_daily_reports
            SET status = ?, confirmed_at = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?
            """,
            (to_status, confirmed_at, timestamp, row["id"]),
        )
        connection.execute(
            """
            INSERT INTO site_daily_report_events
                (project_id, report_id, from_status, to_status, reason,
                 occurred_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project["id"],
                row["id"],
                from_status,
                to_status,
                reason,
                confirmed_at or timestamp,
                timestamp,
            ),
        )
        row = _report_row(connection, int(row["id"]), int(project["id"]))
        response = _report_response(row, str(project["project_code"]))
        _save_idempotency(
            connection,
            scope,
            key,
            request_hash,
            response,
            int(row["id"]),
            timestamp,
            response_status=200,
            resource_type="site_daily_report_event",
        )
        return response


def _normalize_report(payload: dict[str, object]) -> dict[str, object]:
    expected = payload["expected_revision"]
    if expected is not None:
        expected = _positive_integer(
            expected, "expected_revision", "INVALID_REPORT_PAYLOAD"
        )
    return {
        field: _optional_text(payload[field], field, "INVALID_REPORT_PAYLOAD")
        for field in _REPORT_FIELDS[:-1]
    } | {"expected_revision": expected}


def _normalize_advance(
    payload: dict[str, object], *, updating: bool
) -> dict[str, object]:
    raw_items = payload["items"]
    if not isinstance(raw_items, list) or not raw_items:
        raise _invalid("INVALID_ADVANCE_PAYLOAD", "items", "must be a non-empty array")
    items: list[dict[str, object]] = []
    total = 0
    for index, raw in enumerate(raw_items):
        prefix = f"items.{index}"
        if not isinstance(raw, dict) or set(raw) != set(_ITEM_FIELDS):
            raise _invalid("INVALID_ADVANCE_PAYLOAD", prefix, "has invalid fields")
        quantity = _quantity(raw["quantity"], f"{prefix}.quantity")
        unit_price = _nonnegative_integer(
            raw["unit_price_cents"],
            f"{prefix}.unit_price_cents",
            "INVALID_ADVANCE_PAYLOAD",
        )
        computed = _line_amount(unit_price, quantity)
        submitted = _nonnegative_integer(
            raw["line_amount_cents"],
            f"{prefix}.line_amount_cents",
            "INVALID_ADVANCE_PAYLOAD",
        )
        if submitted != computed:
            raise _invalid(
                "INVALID_ADVANCE_PAYLOAD",
                f"{prefix}.line_amount_cents",
                "must equal quantity multiplied by unit price",
            )
        total += computed
        if total > _MAX_INTEGER:
            raise _invalid("INVALID_ADVANCE_PAYLOAD", "items", "total is out of range")
        items.append(
            {
                "name": _required_text(
                    raw["name"], f"{prefix}.name", "INVALID_ADVANCE_PAYLOAD"
                ),
                "specification": _optional_text(
                    raw["specification"],
                    f"{prefix}.specification",
                    "INVALID_ADVANCE_PAYLOAD",
                ),
                "brand": _optional_text(
                    raw["brand"], f"{prefix}.brand", "INVALID_ADVANCE_PAYLOAD"
                ),
                "quantity_milli": quantity,
                "unit": _required_text(
                    raw["unit"], f"{prefix}.unit", "INVALID_ADVANCE_PAYLOAD"
                ),
                "unit_price_cents": unit_price,
                "line_amount_cents": submitted,
            }
        )
    raw_documents = payload["document_version_ids"]
    if not isinstance(raw_documents, list):
        raise _invalid(
            "INVALID_ADVANCE_PAYLOAD", "document_version_ids", "must be an array"
        )
    documents = [
        _positive_integer(item, "document_version_ids", "INVALID_ADVANCE_PAYLOAD")
        for item in raw_documents
    ]
    if len(set(documents)) != len(documents):
        raise _invalid(
            "INVALID_ADVANCE_PAYLOAD", "document_version_ids", "contains duplicates"
        )
    result: dict[str, object] = {
        "worker_id": _positive_integer(
            payload["worker_id"], "worker_id", "INVALID_ADVANCE_PAYLOAD"
        ),
        "spent_on": _business_date(
            payload["spent_on"], "spent_on", "INVALID_ADVANCE_PAYLOAD"
        ),
        "vendor_name": _optional_text(
            payload["vendor_name"], "vendor_name", "INVALID_ADVANCE_PAYLOAD"
        ),
        "items": items,
        "total_amount_cents": total,
        "notes": _optional_text(payload["notes"], "notes", "INVALID_ADVANCE_PAYLOAD"),
        "document_version_ids": documents,
    }
    if updating:
        result["expected_revision"] = _positive_integer(
            payload["expected_revision"], "expected_revision", "INVALID_ADVANCE_PAYLOAD"
        )
    return result


def _normalize_reimbursement(payload: dict[str, object]) -> dict[str, object]:
    method = payload["payment_method"]
    if not isinstance(method, str) or method not in _PAYMENT_METHODS:
        raise _invalid(
            "INVALID_REIMBURSEMENT_PAYLOAD", "payment_method", "has an invalid value"
        )
    return {
        "amount_cents": _positive_integer(
            payload["amount_cents"], "amount_cents", "INVALID_REIMBURSEMENT_PAYLOAD"
        ),
        "reimbursed_on": _business_date(
            payload["reimbursed_on"], "reimbursed_on", "INVALID_REIMBURSEMENT_PAYLOAD"
        ),
        "payment_method": method,
        "notes": _optional_text(
            payload["notes"], "notes", "INVALID_REIMBURSEMENT_PAYLOAD"
        ),
    }


def _validate_advance_references(
    connection: sqlite3.Connection,
    project: sqlite3.Row,
    payload: dict[str, object],
) -> None:
    worker = connection.execute(
        "SELECT id FROM workers WHERE id = ?", (payload["worker_id"],)
    ).fetchone()
    if worker is None:
        raise _invalid("INVALID_ADVANCE_PAYLOAD", "worker_id", "does not exist")
    document_ids = payload["document_version_ids"]
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
            "INVALID_ADVANCE_PAYLOAD",
            "document_version_ids",
            "must belong to the current project",
        )


def _replace_items(
    connection: sqlite3.Connection, advance_id: int, items: object
) -> None:
    connection.execute(
        "DELETE FROM material_advance_items WHERE advance_id = ?", (advance_id,)
    )
    for line_number, item in enumerate(items, start=1):
        connection.execute(
            """
            INSERT INTO material_advance_items
                (advance_id, line_number, name, specification, brand,
                 quantity_milli, unit, unit_price_cents, line_amount_cents)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                advance_id,
                line_number,
                item["name"],
                item["specification"],
                item["brand"],
                item["quantity_milli"],
                item["unit"],
                item["unit_price_cents"],
                item["line_amount_cents"],
            ),
        )


def _replace_documents(
    connection: sqlite3.Connection,
    project_id: int,
    advance_id: int,
    document_ids: object,
    timestamp: str,
) -> None:
    connection.execute(
        "DELETE FROM workforce_document_links WHERE resource_type = 'material_advance' AND resource_id = ?",
        (advance_id,),
    )
    for document_id in document_ids:
        connection.execute(
            """
            INSERT INTO workforce_document_links
                (project_id, resource_type, resource_id, document_version_id, created_at)
            VALUES (?, 'material_advance', ?, ?, ?)
            """,
            (project_id, advance_id, document_id, timestamp),
        )


def _report_row(
    connection: sqlite3.Connection, report_id: int, project_id: int
) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM site_daily_reports WHERE id = ? AND project_id = ?",
        (report_id, project_id),
    ).fetchone()
    if row is None:
        raise _not_found("Daily report not found", "REPORT_NOT_FOUND")
    return row


def _advance_row(
    connection: sqlite3.Connection, project_id: int, advance_id: int
) -> sqlite3.Row:
    row = connection.execute(
        """
        SELECT a.*, w.name AS worker_name,
               COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.amount_cents ELSE 0 END), 0)
                   AS reimbursed_amount_cents
        FROM material_advances a
        JOIN workers w ON w.id = a.worker_id
        LEFT JOIN advance_reimbursements r ON r.advance_id = a.id
        WHERE a.project_id = ? AND a.id = ? GROUP BY a.id
        """,
        (project_id, advance_id),
    ).fetchone()
    if row is None:
        raise _not_found("Material advance not found", "ADVANCE_NOT_FOUND")
    return row


def _report_response(row: sqlite3.Row, project_code: str) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project_code,
        "work_date": row["work_date"],
        "location": row["location"],
        "weather": row["weather"],
        "work_summary": row["work_summary"],
        "blockers": row["blockers"],
        "next_plan": row["next_plan"],
        "notes": row["notes"],
        "status": row["status"],
        "confirmed_at": row["confirmed_at"],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _advance_summary(
    connection: sqlite3.Connection, row: sqlite3.Row, project_code: str
) -> dict[str, object]:
    documents = connection.execute(
        """
        SELECT document_version_id FROM workforce_document_links
        WHERE resource_type = 'material_advance' AND resource_id = ?
        ORDER BY document_version_id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "project_code": project_code,
        "worker_id": row["worker_id"],
        "worker_name": row["worker_name"],
        "spent_on": row["spent_on"],
        "vendor_name": row["vendor_name"],
        "total_amount_cents": row["total_amount_cents"],
        "reimbursed_amount_cents": row["reimbursed_amount_cents"],
        "outstanding_amount_cents": int(row["total_amount_cents"])
        - int(row["reimbursed_amount_cents"]),
        "notes": row["notes"],
        "status": _advance_status(row),
        "void_reason": row["void_reason"],
        "voided_at": row["voided_at"],
        "document_version_ids": [item[0] for item in documents],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _advance_detail(
    connection: sqlite3.Connection, row: sqlite3.Row, project_code: str
) -> dict[str, object]:
    response = _advance_summary(connection, row, project_code)
    items = connection.execute(
        "SELECT * FROM material_advance_items WHERE advance_id = ? ORDER BY line_number",
        (row["id"],),
    ).fetchall()
    reimbursements = connection.execute(
        "SELECT * FROM advance_reimbursements WHERE advance_id = ? ORDER BY reimbursed_on, id",
        (row["id"],),
    ).fetchall()
    response["items"] = [
        {
            "id": item["id"],
            "line_number": item["line_number"],
            "name": item["name"],
            "specification": item["specification"],
            "brand": item["brand"],
            "quantity": _format_quantity(item["quantity_milli"]),
            "unit": item["unit"],
            "unit_price_cents": item["unit_price_cents"],
            "line_amount_cents": item["line_amount_cents"],
        }
        for item in items
    ]
    response["reimbursements"] = [
        {
            "id": item["id"],
            "advance_id": item["advance_id"],
            "amount_cents": item["amount_cents"],
            "reimbursed_on": item["reimbursed_on"],
            "payment_method": item["payment_method"],
            "notes": item["notes"],
            "status": item["status"],
            "revision": item["revision"],
            "created_at": item["created_at"],
            "updated_at": item["updated_at"],
        }
        for item in reimbursements
    ]
    return response


def _reimbursement_response(
    connection: sqlite3.Connection, reimbursement_id: int, advance_id: int
) -> dict[str, object]:
    reimbursement = connection.execute(
        "SELECT * FROM advance_reimbursements WHERE id = ?", (reimbursement_id,)
    ).fetchone()
    advance = connection.execute(
        """
        SELECT a.*, COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.amount_cents ELSE 0 END), 0)
            AS reimbursed_amount_cents
        FROM material_advances a LEFT JOIN advance_reimbursements r ON r.advance_id = a.id
        WHERE a.id = ? GROUP BY a.id
        """,
        (advance_id,),
    ).fetchone()
    if reimbursement is None or advance is None:
        raise sqlite3.DatabaseError("reimbursement insert could not be reloaded")
    return {
        "id": reimbursement["id"],
        "advance_id": advance_id,
        "amount_cents": reimbursement["amount_cents"],
        "reimbursed_on": reimbursement["reimbursed_on"],
        "payment_method": reimbursement["payment_method"],
        "notes": reimbursement["notes"],
        "status": reimbursement["status"],
        "revision": reimbursement["revision"],
        "advance_status": _advance_status(advance),
        "advance_revision": advance["revision"],
        "created_at": reimbursement["created_at"],
        "updated_at": reimbursement["updated_at"],
    }


def _advance_status(row: sqlite3.Row) -> str:
    if row["status"] == "voided":
        return "voided"
    reimbursed = int(row["reimbursed_amount_cents"])
    total = int(row["total_amount_cents"])
    if reimbursed == 0:
        return "unreimbursed"
    if reimbursed == total:
        return "reimbursed"
    return "partial"


def _require_unreimbursed(connection: sqlite3.Connection, row: sqlite3.Row) -> None:
    if row["status"] == "voided":
        raise _conflict("Voided advance cannot be changed", "ADVANCE_VOIDED")
    if _reimbursed_total(connection, int(row["id"])) != 0:
        raise _conflict(
            "Reimbursed advance cannot be changed", "ADVANCE_ALREADY_REIMBURSED"
        )


def _reimbursed_total(connection: sqlite3.Connection, advance_id: int) -> int:
    return int(
        connection.execute(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM advance_reimbursements WHERE advance_id = ? AND status = 'active'",
            (advance_id,),
        ).fetchone()[0]
    )


def _restore_idempotency(
    connection: sqlite3.Connection, scope: str, key: str, request_hash: str
) -> dict[str, object] | None:
    row = connection.execute(
        "SELECT request_sha256, response_json FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?",
        (scope, key),
    ).fetchone()
    if row is None:
        return None
    if row["request_sha256"] != request_hash:
        raise _conflict(
            "Idempotency key was already used with different content",
            "IDEMPOTENCY_CONFLICT",
        )
    restored = json.loads(row["response_json"])
    if not isinstance(restored, dict):
        raise sqlite3.DatabaseError("idempotency response is not an object")
    return restored


def _save_idempotency(
    connection: sqlite3.Connection,
    scope: str,
    key: str,
    request_hash: str,
    response: dict[str, object],
    resource_id: int,
    timestamp: str,
    *,
    response_status: int,
    resource_type: str,
) -> None:
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
            resource_type,
            resource_id,
            timestamp,
        ),
    )


def _project(connection: sqlite3.Connection, project_code: str) -> sqlite3.Row:
    try:
        key = project_code_identity(normalize_project_code(project_code))
    except (TypeError, UnicodeError, ValueError):
        raise _invalid("INVALID_PROJECT_CODE", "project_code", "is invalid") from None
    row = connection.execute(
        "SELECT id, project_code, status FROM projects WHERE project_code_key = ?",
        (key,),
    ).fetchone()
    if row is None:
        raise _not_found("Project not found", "PROJECT_NOT_FOUND")
    return row


def _active_project(connection: sqlite3.Connection, project_code: str) -> sqlite3.Row:
    row = _project(connection, project_code)
    if row["status"] != "active":
        raise _conflict("Project is archived", "PROJECT_ARCHIVED")
    return row


async def _json_object(
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
    page = _positive_query(request, "page", 1, _MAX_INTEGER)
    page_size = _positive_query(request, "page_size", 50, 200)
    if page - 1 > _MAX_INTEGER // page_size:
        raise _invalid("INVALID_PAGINATION", "page", "produces an invalid offset")
    return page, page_size


def _positive_query(
    request: Request, name: str, default: int, maximum: int | None
) -> int:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or not values[0].isascii() or not values[0].isdecimal():
        raise _invalid("INVALID_PAGINATION", name, "must be a positive integer")
    value = int(values[0])
    if value < 1 or (maximum is not None and value > maximum):
        raise _invalid("INVALID_PAGINATION", name, "is out of range")
    return value


def _optional_date_query(request: Request, name: str, error_code: str) -> str | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _invalid(error_code, name, "must occur once")
    return _business_date(values[0], name, error_code)


def _optional_identifier_query(
    request: Request, name: str, error_code: str
) -> int | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _invalid(error_code, name, "must occur once")
    return _ascii_identifier(values[0], name, error_code)


def _enum_query(
    request: Request,
    name: str,
    allowed: frozenset[str],
    default: str,
    error_code: str,
) -> str:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or values[0] not in allowed:
        raise _invalid(error_code, name, "has an invalid value")
    return values[0]


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


def _required_text(value: object, field: str, error_code: str) -> str:
    normalized = _text(value, field, error_code)
    if not normalized:
        raise _invalid(error_code, field, "must not be empty")
    return normalized


def _optional_text(value: object, field: str, error_code: str) -> str | None:
    if value is None:
        return None
    normalized = _text(value, field, error_code)
    return normalized or None


def _text(value: object, field: str, error_code: str) -> str:
    if not isinstance(value, str):
        raise _invalid(error_code, field, "must be a string")
    normalized = value.strip()
    if "\x00" in normalized:
        raise _invalid(error_code, field, "contains an invalid character")
    try:
        normalized.encode("utf-8")
    except UnicodeEncodeError:
        raise _invalid(error_code, field, "must be valid UTF-8") from None
    return normalized


def _positive_integer(value: object, field: str, error_code: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= _MAX_INTEGER
    ):
        raise _invalid(error_code, field, "must be a positive integer")
    return value


def _nonnegative_integer(value: object, field: str, error_code: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 0 <= value <= _MAX_INTEGER
    ):
        raise _invalid(error_code, field, "must be a nonnegative integer")
    return value


def _quantity(value: object, field: str) -> int:
    if not isinstance(value, str) or _QUANTITY.fullmatch(value) is None:
        raise _invalid(
            "INVALID_ADVANCE_PAYLOAD", field, "must be a positive decimal string"
        )
    try:
        milli = int((Decimal(value) * 1000).to_integral_exact())
    except (InvalidOperation, ValueError):
        raise _invalid(
            "INVALID_ADVANCE_PAYLOAD", field, "must be a positive decimal string"
        ) from None
    if not 1 <= milli <= _MAX_INTEGER:
        raise _invalid("INVALID_ADVANCE_PAYLOAD", field, "is out of range")
    return milli


def _line_amount(unit_price_cents: int, quantity_milli: int) -> int:
    amount = (unit_price_cents * quantity_milli + 500) // 1000
    if not 0 <= amount <= _MAX_INTEGER:
        raise _invalid("INVALID_ADVANCE_PAYLOAD", "items", "amount is out of range")
    return amount


def _format_quantity(value: int) -> str:
    return f"{value // 1000}.{value % 1000:03d}"


def _identifier(value: str) -> int:
    return _ascii_identifier(value, "identifier", "INVALID_IDENTIFIER")


def _ascii_identifier(value: str, field: str, error_code: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid(error_code, field, "must be a positive integer")
    return _positive_integer(int(value), field, error_code)


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


def _payload_hash(payload: dict[str, object]) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(encoded.encode()).hexdigest()


def _require_revision(row: sqlite3.Row, expected: object) -> None:
    if expected is None or int(row["revision"]) != int(expected):
        raise _revision_conflict(int(row["revision"]))


def _revision_conflict(current: int | None) -> SiteOperationsError:
    return SiteOperationsError(
        status.HTTP_409_CONFLICT,
        "Resource was modified",
        "REVISION_CONFLICT",
        current_revision=current,
    )


def _invalid(error_code: str, field: str, message: str) -> SiteOperationsError:
    return SiteOperationsError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "Invalid site operation payload",
        error_code,
        field_errors={field: message},
    )


def _not_found(detail: str, error_code: str) -> SiteOperationsError:
    return SiteOperationsError(status.HTTP_404_NOT_FOUND, detail, error_code)


def _conflict(detail: str, error_code: str) -> SiteOperationsError:
    return SiteOperationsError(status.HTTP_409_CONFLICT, detail, error_code)


def _last_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not produce an identifier")
    return cursor.lastrowid


def _paged(
    items: list[dict[str, object]], total: int, page: int, page_size: int
) -> dict[str, object]:
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)
