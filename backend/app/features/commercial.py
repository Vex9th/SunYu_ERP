from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    idempotency_scope,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session

Clock = Callable[[], datetime]

_QUOTE_FIELDS = {
    "quote_date",
    "amount_cents",
    "valid_until",
    "notes",
    "document_version_ids",
}
_CONTRACT_FIELDS = {
    "contract_no",
    "title",
    "customer_company_id",
    "signed_on",
    "total_amount_cents",
    "final_delivery_on",
    "allocations",
    "notes",
    "document_version_ids",
}
_ALLOCATION_FIELDS = {"project_code", "amount_cents"}
_TRANSITION_FIELDS = {"to_status", "occurred_at", "reason", "expected_revision"}
_PAYMENT_TERM_FIELDS = {
    "due_on",
    "planned_amount_cents",
    "notes",
    "expected_revision",
}
_RECEIPT_FIELDS = {
    "contract_allocation_id",
    "milestone",
    "received_on",
    "amount_cents",
    "payment_method",
    "reference_no",
    "notes",
}
_RECEIPT_UPDATE_FIELDS = {"reference_no", "notes", "expected_revision"}
_RECEIPT_VOID_FIELDS = {"voided_on", "reason", "expected_revision"}
_QUOTE_STATUSES = frozenset({"draft", "sent", "accepted", "rejected", "withdrawn"})
_CONTRACT_STATUSES = frozenset({"draft", "signed", "completed", "terminated"})
_LOCKED_CONTRACT_STATUSES = frozenset({"signed", "completed", "terminated"})
_PAYMENT_MILESTONES = ("advance", "progress", "final")
_PAYMENT_MILESTONE_SET = frozenset(_PAYMENT_MILESTONES)
_PAYMENT_METHODS = frozenset({"bank_transfer", "cash", "other"})
_QUOTE_TRANSITIONS = {
    "draft": frozenset({"sent", "withdrawn"}),
    "sent": frozenset({"accepted", "rejected", "withdrawn"}),
    "accepted": frozenset(),
    "rejected": frozenset(),
    "withdrawn": frozenset(),
}
_CONTRACT_TRANSITIONS = {
    "draft": frozenset({"signed", "terminated"}),
    "signed": frozenset({"completed", "terminated"}),
    "completed": frozenset(),
    "terminated": frozenset(),
}
_SQLITE_MAX_INTEGER = 2**63 - 1
_MAX_MONEY_CENTS = 9_000_000_000_000
_MAX_PAGE_SIZE = 200


def create_commercial_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=ApiErrorRoute, tags=["commercial"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/projects/{project_code}/quotes")
    def list_quotes(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, _normalize_project_path(project_code))
        page, page_size = _read_pagination(request)
        total = int(
            connection.execute(
                "SELECT COUNT(*) FROM quotes WHERE project_id = ?",
                (project["id"],),
            ).fetchone()[0]
        )
        rows = connection.execute(
            """
            SELECT * FROM quotes
            WHERE project_id = ?
            ORDER BY version_number DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            (project["id"], page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [
                _quote_response(connection, row, str(project["project_code"]))
                for row in rows
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post(
        "/api/projects/{project_code}/quotes",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_quote(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _read_json(request, _QUOTE_FIELDS, "Invalid quote payload")
        normalized = _normalize_quote(payload)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            _validate_document_versions(
                connection,
                str(project["project_code"]),
                normalized["document_version_ids"],
                "Invalid quote payload",
            )
            version_number = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(version_number), 0) + 1
                    FROM quotes WHERE project_id = ?
                    """,
                    (project["id"],),
                ).fetchone()[0]
            )
            cursor = connection.execute(
                """
                INSERT INTO quotes
                    (project_id, version_number, status, quote_date,
                     amount_cents, valid_until, notes, revision,
                     created_at, updated_at)
                VALUES (?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    project["id"],
                    version_number,
                    normalized["quote_date"],
                    normalized["amount_cents"],
                    normalized["valid_until"],
                    normalized["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            quote_id = _last_insert_id(cursor)
            _replace_document_links(
                connection,
                "quote_document_versions",
                "quote_id",
                quote_id,
                normalized["document_version_ids"],
            )
            row = _quote_row(connection, quote_id, int(project["id"]))
            if row is None:
                raise sqlite3.DatabaseError("created quote is missing")
            return _quote_response(connection, row, str(project["project_code"]))

    @router.get("/api/projects/{project_code}/quotes/{quote_id}")
    def get_quote(
        project_code: str,
        quote_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, _normalize_project_path(project_code))
        row = _quote_row(connection, _parse_identifier(quote_id), int(project["id"]))
        if row is None:
            raise _not_found("Quote not found")
        return _quote_response(connection, row, str(project["project_code"]))

    @router.put("/api/projects/{project_code}/quotes/{quote_id}")
    async def update_quote(
        project_code: str,
        quote_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(quote_id)
        payload = await _read_json(
            request,
            {*_QUOTE_FIELDS, "expected_revision"},
            "Invalid quote payload",
        )
        normalized = _normalize_quote(payload)
        expected_revision = _positive_integer(
            payload["expected_revision"], "Invalid quote payload"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            row = _quote_row(connection, identifier, int(project["id"]))
            if row is None:
                raise _not_found("Quote not found")
            _require_revision(row, expected_revision)
            if row["status"] != "draft":
                raise _business_conflict(
                    "Quote is not editable",
                    "QUOTE_NOT_EDITABLE",
                )
            _validate_document_versions(
                connection,
                str(project["project_code"]),
                normalized["document_version_ids"],
                "Invalid quote payload",
            )
            cursor = connection.execute(
                """
                UPDATE quotes
                SET quote_date = ?, amount_cents = ?, valid_until = ?, notes = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (
                    normalized["quote_date"],
                    normalized["amount_cents"],
                    normalized["valid_until"],
                    normalized["notes"],
                    timestamp,
                    identifier,
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                current = _quote_row(connection, identifier, int(project["id"]))
                if current is None:
                    raise _not_found("Quote not found")
                raise _revision_conflict(int(current["revision"]))
            _replace_document_links(
                connection,
                "quote_document_versions",
                "quote_id",
                identifier,
                normalized["document_version_ids"],
            )
            updated = _quote_row(connection, identifier, int(project["id"]))
            if updated is None:
                raise sqlite3.DatabaseError("updated quote is missing")
            return _quote_response(connection, updated, str(project["project_code"]))

    @router.post("/api/projects/{project_code}/quotes/{quote_id}/transition")
    async def transition_quote(
        project_code: str,
        quote_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(quote_id)
        payload = await _read_transition(
            request,
            _QUOTE_STATUSES,
            "Invalid quote transition",
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            row = _quote_row(connection, identifier, int(project["id"]))
            if row is None:
                raise _not_found("Quote not found")
            _require_revision(row, int(payload["expected_revision"]))
            to_status = str(payload["to_status"])
            if to_status not in _QUOTE_TRANSITIONS[str(row["status"])]:
                raise _business_conflict(
                    "Invalid quote transition",
                    "INVALID_QUOTE_TRANSITION",
                )
            if to_status == "accepted":
                accepted = connection.execute(
                    """
                    SELECT 1 FROM quotes
                    WHERE project_id = ? AND status = 'accepted' AND id <> ?
                    """,
                    (project["id"], identifier),
                ).fetchone()
                if accepted is not None:
                    raise _business_conflict(
                        "Project already has an accepted quote",
                        "ACCEPTED_QUOTE_EXISTS",
                    )
            cursor = connection.execute(
                """
                UPDATE quotes
                SET status = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (
                    to_status,
                    timestamp,
                    identifier,
                    payload["expected_revision"],
                ),
            )
            if cursor.rowcount != 1:
                current = _quote_row(connection, identifier, int(project["id"]))
                if current is None:
                    raise _not_found("Quote not found")
                raise _revision_conflict(int(current["revision"]))
            updated = _quote_row(connection, identifier, int(project["id"]))
            if updated is None:
                raise sqlite3.DatabaseError("transitioned quote is missing")
            return _quote_response(connection, updated, str(project["project_code"]))

    @router.get("/api/projects/{project_code}/contracts")
    def list_contracts(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, _normalize_project_path(project_code))
        page, page_size = _read_pagination(request)
        total = int(
            connection.execute(
                """
                SELECT COUNT(*)
                FROM contracts
                JOIN contract_project_allocations AS allocations
                    ON allocations.contract_id = contracts.id
                WHERE allocations.project_id = ?
                """,
                (project["id"],),
            ).fetchone()[0]
        )
        rows = connection.execute(
            """
            SELECT contracts.*
            FROM contracts
            JOIN contract_project_allocations AS allocations
                ON allocations.contract_id = contracts.id
            WHERE allocations.project_id = ?
            ORDER BY contracts.created_at DESC, contracts.id DESC
            LIMIT ? OFFSET ?
            """,
            (project["id"], page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [_contract_response(connection, row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post(
        "/api/projects/{project_code}/contracts",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_contract(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        payload = await _read_json(
            request,
            _CONTRACT_FIELDS,
            "Invalid contract payload",
        )
        normalized = _normalize_contract(payload)
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                project = _active_project(
                    connection, _normalize_project_path(project_code)
                )
                _validate_company(
                    connection,
                    int(normalized["customer_company_id"]),
                )
                allocations = _resolve_allocations(
                    connection,
                    normalized["allocations"],
                    str(project["project_code"]),
                )
                _validate_document_versions(
                    connection,
                    str(project["project_code"]),
                    normalized["document_version_ids"],
                    "Invalid contract payload",
                )
                cursor = connection.execute(
                    """
                    INSERT INTO contracts
                        (contract_no, title, customer_company_id, status,
                         signed_on, total_amount_cents, final_delivery_on,
                         notes, revision, created_at, updated_at)
                    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        normalized["contract_no"],
                        normalized["title"],
                        normalized["customer_company_id"],
                        normalized["signed_on"],
                        normalized["total_amount_cents"],
                        normalized["final_delivery_on"],
                        normalized["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                contract_id = _last_insert_id(cursor)
                _replace_allocations(connection, contract_id, allocations)
                _replace_document_links(
                    connection,
                    "contract_document_versions",
                    "contract_id",
                    contract_id,
                    normalized["document_version_ids"],
                )
                row = _contract_row(connection, contract_id, int(project["id"]))
                if row is None:
                    raise sqlite3.DatabaseError("created contract is missing")
                return _contract_response(connection, row)
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise _business_conflict(
                    "Contract number already exists",
                    "CONTRACT_NO_EXISTS",
                ) from None
            raise

    @router.get("/api/projects/{project_code}/contracts/{contract_id}")
    def get_contract(
        project_code: str,
        contract_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, _normalize_project_path(project_code))
        row = _contract_row(
            connection,
            _parse_identifier(contract_id),
            int(project["id"]),
        )
        if row is None:
            raise _not_found("Contract not found")
        return _contract_response(connection, row)

    @router.put("/api/projects/{project_code}/contracts/{contract_id}")
    async def update_contract(
        project_code: str,
        contract_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(contract_id)
        payload = await _read_json(
            request,
            {*_CONTRACT_FIELDS, "expected_revision"},
            "Invalid contract payload",
        )
        normalized = _normalize_contract(payload)
        expected_revision = _positive_integer(
            payload["expected_revision"], "Invalid contract payload"
        )
        timestamp = _timestamp(now)
        try:
            with transaction_immediate(connection):
                project = _active_project(
                    connection, _normalize_project_path(project_code)
                )
                row = _contract_row(connection, identifier, int(project["id"]))
                if row is None:
                    raise _not_found("Contract not found")
                _require_revision(row, expected_revision)
                _validate_company(
                    connection,
                    int(normalized["customer_company_id"]),
                )
                allocations = _resolve_allocations(
                    connection,
                    normalized["allocations"],
                    str(project["project_code"]),
                )
                _validate_document_versions(
                    connection,
                    str(project["project_code"]),
                    normalized["document_version_ids"],
                    "Invalid contract payload",
                )
                if row["status"] in _LOCKED_CONTRACT_STATUSES and (
                    int(row["total_amount_cents"])
                    != normalized["total_amount_cents"]
                    or _allocation_amounts(
                        _allocation_values(connection, identifier)
                    )
                    != _allocation_amounts(allocations)
                ):
                    raise _business_conflict(
                        "Signed contract amount cannot be changed",
                        "CONTRACT_AMOUNT_LOCKED",
                    )
                if row["status"] in {"signed", "completed"}:
                    _require_signing_values(normalized, allocations)
                cursor = connection.execute(
                    """
                    UPDATE contracts
                    SET contract_no = ?, title = ?, customer_company_id = ?,
                        signed_on = ?, total_amount_cents = ?,
                        final_delivery_on = ?, notes = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (
                        normalized["contract_no"],
                        normalized["title"],
                        normalized["customer_company_id"],
                        normalized["signed_on"],
                        normalized["total_amount_cents"],
                        normalized["final_delivery_on"],
                        normalized["notes"],
                        timestamp,
                        identifier,
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    current = _contract_row(
                        connection, identifier, int(project["id"])
                    )
                    if current is None:
                        raise _not_found("Contract not found")
                    raise _revision_conflict(int(current["revision"]))
                if row["status"] not in _LOCKED_CONTRACT_STATUSES:
                    _replace_allocations(connection, identifier, allocations)
                _replace_document_links(
                    connection,
                    "contract_document_versions",
                    "contract_id",
                    identifier,
                    normalized["document_version_ids"],
                )
                updated = _contract_row(connection, identifier, int(project["id"]))
                if updated is None:
                    raise sqlite3.DatabaseError("updated contract is missing")
                return _contract_response(connection, updated)
        except sqlite3.IntegrityError as exc:
            if _is_unique_constraint(exc):
                raise _business_conflict(
                    "Contract number already exists",
                    "CONTRACT_NO_EXISTS",
                ) from None
            raise

    @router.post("/api/projects/{project_code}/contracts/{contract_id}/transition")
    async def transition_contract(
        project_code: str,
        contract_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(contract_id)
        payload = await _read_transition(
            request,
            _CONTRACT_STATUSES,
            "Invalid contract transition",
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            row = _contract_row(connection, identifier, int(project["id"]))
            if row is None:
                raise _not_found("Contract not found")
            _require_revision(row, int(payload["expected_revision"]))
            to_status = str(payload["to_status"])
            if to_status not in _CONTRACT_TRANSITIONS[str(row["status"])]:
                raise _business_conflict(
                    "Invalid contract transition",
                    "INVALID_CONTRACT_TRANSITION",
                )
            if to_status == "signed":
                _require_signing_values(
                    {
                        "signed_on": row["signed_on"],
                        "final_delivery_on": row["final_delivery_on"],
                        "total_amount_cents": int(row["total_amount_cents"]),
                    },
                    _allocation_values(connection, identifier),
                )
            cursor = connection.execute(
                """
                UPDATE contracts
                SET status = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (
                    to_status,
                    timestamp,
                    identifier,
                    payload["expected_revision"],
                ),
            )
            if cursor.rowcount != 1:
                current = _contract_row(connection, identifier, int(project["id"]))
                if current is None:
                    raise _not_found("Contract not found")
                raise _revision_conflict(int(current["revision"]))
            updated = _contract_row(connection, identifier, int(project["id"]))
            if updated is None:
                raise sqlite3.DatabaseError("transitioned contract is missing")
            return _contract_response(connection, updated)

    @router.get("/api/projects/{project_code}/payments")
    def get_payments(
        project_code: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        project = _project(connection, _normalize_project_path(project_code))
        return _payment_overview(connection, project, _business_today(now))

    @router.put("/api/projects/{project_code}/payment-terms/{milestone}")
    async def put_payment_term(
        project_code: str,
        milestone: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        normalized_milestone = _payment_milestone(milestone)
        payload = await _read_json(
            request,
            _PAYMENT_TERM_FIELDS,
            "Invalid payment term payload",
        )
        normalized = _normalize_payment_term(payload)
        timestamp = _timestamp(now)
        today = _business_today(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            current = _payment_term_row(
                connection,
                int(project["id"]),
                normalized_milestone,
            )
            expected_revision = normalized["expected_revision"]
            if current is None:
                if expected_revision is not None:
                    raise _revision_conflict(None)
                cursor = connection.execute(
                    """
                    INSERT INTO payment_terms
                        (project_id, milestone, due_on, planned_amount_cents,
                         notes, revision, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        project["id"],
                        normalized_milestone,
                        normalized["due_on"],
                        normalized["planned_amount_cents"],
                        normalized["notes"],
                        timestamp,
                        timestamp,
                    ),
                )
                term_id = _last_insert_id(cursor)
            else:
                if expected_revision is None:
                    raise _revision_conflict(int(current["revision"]))
                _require_revision(current, expected_revision)
                cursor = connection.execute(
                    """
                    UPDATE payment_terms
                    SET due_on = ?, planned_amount_cents = ?, notes = ?,
                        revision = revision + 1, updated_at = ?
                    WHERE id = ? AND revision = ?
                    """,
                    (
                        normalized["due_on"],
                        normalized["planned_amount_cents"],
                        normalized["notes"],
                        timestamp,
                        current["id"],
                        expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    refreshed = _payment_term_row(
                        connection,
                        int(project["id"]),
                        normalized_milestone,
                    )
                    raise _revision_conflict(
                        None if refreshed is None else int(refreshed["revision"])
                    )
                term_id = int(current["id"])
            updated = connection.execute(
                "SELECT * FROM payment_terms WHERE id = ?", (term_id,)
            ).fetchone()
            if updated is None:
                raise sqlite3.DatabaseError("saved payment term is missing")
            received = _milestone_received(
                connection,
                int(project["id"]),
                normalized_milestone,
            )
            return _payment_term_response(updated, received, today)

    @router.post(
        "/api/projects/{project_code}/receipts",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_receipt(
        project_code: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _read_idempotency_key(request)
        payload = await _read_json(
            request,
            _RECEIPT_FIELDS,
            "Invalid receipt payload",
        )
        normalized = _normalize_receipt(payload)
        request_hash = _request_hash(normalized)
        scope = idempotency_scope(request)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            restored = restore_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
            )
            if restored is not None:
                return restored
            project = _active_project(connection, _normalize_project_path(project_code))
            allocation_id = normalized["contract_allocation_id"]
            if allocation_id is not None:
                _validate_receipt_allocation(
                    connection,
                    int(allocation_id),
                    int(project["id"]),
                )
            cursor = connection.execute(
                """
                INSERT INTO receipts
                    (project_id, contract_allocation_id, milestone, received_on,
                     amount_cents, payment_method, reference_no, notes,
                     status, voided_on, void_reason, revision,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, 1, ?, ?)
                """,
                (
                    project["id"],
                    allocation_id,
                    normalized["milestone"],
                    normalized["received_on"],
                    normalized["amount_cents"],
                    normalized["payment_method"],
                    normalized["reference_no"],
                    normalized["notes"],
                    timestamp,
                    timestamp,
                ),
            )
            receipt_id = _last_insert_id(cursor)
            row = _receipt_row(connection, receipt_id, int(project["id"]))
            if row is None:
                raise sqlite3.DatabaseError("created receipt is missing")
            response = _receipt_response(row, str(project["project_code"]))
            save_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_201_CREATED,
                resource_type="receipt",
                resource_id=receipt_id,
                created_at=timestamp,
            )
            return response

    @router.put("/api/projects/{project_code}/receipts/{receipt_id}")
    async def update_receipt(
        project_code: str,
        receipt_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(receipt_id)
        payload = await _read_json(
            request,
            _RECEIPT_UPDATE_FIELDS,
            "Invalid receipt payload",
        )
        reference_no = _optional_text(
            payload["reference_no"], "Invalid receipt payload"
        )
        notes = _optional_text(payload["notes"], "Invalid receipt payload")
        expected_revision = _positive_integer(
            payload["expected_revision"], "Invalid receipt payload"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            row = _receipt_row(connection, identifier, int(project["id"]))
            if row is None:
                raise _not_found("Receipt not found")
            _require_revision(row, expected_revision)
            if row["status"] != "active":
                raise _business_conflict(
                    "Receipt is not active",
                    "RECEIPT_NOT_ACTIVE",
                )
            cursor = connection.execute(
                """
                UPDATE receipts
                SET reference_no = ?, notes = ?, revision = revision + 1,
                    updated_at = ?
                WHERE id = ? AND revision = ? AND status = 'active'
                """,
                (reference_no, notes, timestamp, identifier, expected_revision),
            )
            if cursor.rowcount != 1:
                refreshed = _receipt_row(connection, identifier, int(project["id"]))
                if refreshed is None:
                    raise _not_found("Receipt not found")
                raise _revision_conflict(int(refreshed["revision"]))
            updated = _receipt_row(connection, identifier, int(project["id"]))
            if updated is None:
                raise sqlite3.DatabaseError("updated receipt is missing")
            return _receipt_response(updated, str(project["project_code"]))

    @router.post("/api/projects/{project_code}/receipts/{receipt_id}/void")
    async def void_receipt(
        project_code: str,
        receipt_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(receipt_id)
        payload = await _read_json(
            request,
            _RECEIPT_VOID_FIELDS,
            "Invalid receipt void payload",
        )
        voided_on = _business_date(
            payload["voided_on"], "Invalid receipt void payload"
        )
        reason = _required_text(payload["reason"], "Invalid receipt void payload")
        expected_revision = _positive_integer(
            payload["expected_revision"], "Invalid receipt void payload"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            project = _active_project(connection, _normalize_project_path(project_code))
            row = _receipt_row(connection, identifier, int(project["id"]))
            if row is None:
                raise _not_found("Receipt not found")
            _require_revision(row, expected_revision)
            if row["status"] != "active":
                raise _business_conflict(
                    "Receipt is not active",
                    "RECEIPT_NOT_ACTIVE",
                )
            if voided_on < str(row["received_on"]):
                raise _invalid_payload("Invalid receipt void payload")
            cursor = connection.execute(
                """
                UPDATE receipts
                SET status = 'voided', voided_on = ?, void_reason = ?,
                    revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ? AND status = 'active'
                """,
                (voided_on, reason, timestamp, identifier, expected_revision),
            )
            if cursor.rowcount != 1:
                refreshed = _receipt_row(connection, identifier, int(project["id"]))
                if refreshed is None:
                    raise _not_found("Receipt not found")
                raise _revision_conflict(int(refreshed["revision"]))
            updated = _receipt_row(connection, identifier, int(project["id"]))
            if updated is None:
                raise sqlite3.DatabaseError("voided receipt is missing")
            return _receipt_response(updated, str(project["project_code"]))

    return router


def _normalize_payment_term(payload: dict[str, Any]) -> dict[str, object]:
    expected_revision = payload["expected_revision"]
    if expected_revision is not None:
        expected_revision = _positive_integer(
            expected_revision,
            "Invalid payment term payload",
        )
    return {
        "due_on": _optional_business_date(
            payload["due_on"], "Invalid payment term payload"
        ),
        "planned_amount_cents": _money(
            payload["planned_amount_cents"], "Invalid payment term payload"
        ),
        "notes": _optional_text(payload["notes"], "Invalid payment term payload"),
        "expected_revision": expected_revision,
    }


def _normalize_receipt(payload: dict[str, Any]) -> dict[str, object]:
    allocation_id = payload["contract_allocation_id"]
    if allocation_id is not None:
        allocation_id = _positive_integer(allocation_id, "Invalid receipt payload")
    milestone = payload["milestone"]
    if not isinstance(milestone, str) or milestone not in _PAYMENT_MILESTONE_SET:
        raise _invalid_payload("Invalid receipt payload")
    payment_method = payload["payment_method"]
    if not isinstance(payment_method, str) or payment_method not in _PAYMENT_METHODS:
        raise _invalid_payload("Invalid receipt payload")
    return {
        "contract_allocation_id": allocation_id,
        "milestone": milestone,
        "received_on": _business_date(
            payload["received_on"], "Invalid receipt payload"
        ),
        "amount_cents": _positive_money(
            payload["amount_cents"], "Invalid receipt payload"
        ),
        "payment_method": payment_method,
        "reference_no": _optional_text(
            payload["reference_no"], "Invalid receipt payload"
        ),
        "notes": _optional_text(payload["notes"], "Invalid receipt payload"),
    }


def _normalize_quote(payload: dict[str, Any]) -> dict[str, object]:
    quote_date = _business_date(payload["quote_date"], "Invalid quote payload")
    valid_until = _optional_business_date(
        payload["valid_until"], "Invalid quote payload"
    )
    if valid_until is not None and valid_until < quote_date:
        raise _invalid_payload("Invalid quote payload")
    return {
        "quote_date": quote_date,
        "amount_cents": _money(payload["amount_cents"], "Invalid quote payload"),
        "valid_until": valid_until,
        "notes": _optional_text(payload["notes"], "Invalid quote payload"),
        "document_version_ids": _document_ids(
            payload["document_version_ids"], "Invalid quote payload"
        ),
    }


def _normalize_contract(payload: dict[str, Any]) -> dict[str, object]:
    raw_allocations = payload["allocations"]
    if not isinstance(raw_allocations, list) or not raw_allocations:
        raise _invalid_payload("Invalid contract payload")
    allocations: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in raw_allocations:
        if not isinstance(raw, dict) or set(raw) != _ALLOCATION_FIELDS:
            raise _invalid_payload("Invalid contract payload")
        project_code = _normalized_project_code(
            raw["project_code"], "Invalid contract payload"
        )
        project_key = project_code_identity(project_code)
        if project_key in seen:
            raise _invalid_payload("Invalid contract payload")
        seen.add(project_key)
        allocations.append(
            {
                "project_code": project_code,
                "project_key": project_key,
                "amount_cents": _positive_money(
                    raw["amount_cents"], "Invalid contract payload"
                ),
            }
        )
    return {
        "contract_no": _required_text(
            payload["contract_no"], "Invalid contract payload"
        ),
        "title": _required_text(payload["title"], "Invalid contract payload"),
        "customer_company_id": _positive_integer(
            payload["customer_company_id"], "Invalid contract payload"
        ),
        "signed_on": _optional_business_date(
            payload["signed_on"], "Invalid contract payload"
        ),
        "total_amount_cents": _money(
            payload["total_amount_cents"], "Invalid contract payload"
        ),
        "final_delivery_on": _optional_business_date(
            payload["final_delivery_on"], "Invalid contract payload"
        ),
        "allocations": allocations,
        "notes": _optional_text(payload["notes"], "Invalid contract payload"),
        "document_version_ids": _document_ids(
            payload["document_version_ids"], "Invalid contract payload"
        ),
    }


async def _read_transition(
    request: Request,
    statuses: frozenset[str],
    detail: str,
) -> dict[str, object]:
    payload = await _read_json(request, _TRANSITION_FIELDS, detail)
    to_status = payload["to_status"]
    if not isinstance(to_status, str) or to_status not in statuses:
        raise _invalid_payload(detail)
    return {
        "to_status": to_status,
        "occurred_at": _aware_timestamp(payload["occurred_at"], detail),
        "reason": _optional_text(payload["reason"], detail),
        "expected_revision": _positive_integer(payload["expected_revision"], detail),
    }


def _quote_response(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    project_code: str,
) -> dict[str, object]:
    documents = connection.execute(
        """
        SELECT document_version_id FROM quote_document_versions
        WHERE quote_id = ? ORDER BY document_version_id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "project_code": project_code,
        "version_number": row["version_number"],
        "status": row["status"],
        "quote_date": row["quote_date"],
        "amount_cents": row["amount_cents"],
        "valid_until": row["valid_until"],
        "notes": row["notes"],
        "document_version_ids": [item[0] for item in documents],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _contract_response(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
) -> dict[str, object]:
    customer = connection.execute(
        "SELECT name FROM companies WHERE id = ?",
        (row["customer_company_id"],),
    ).fetchone()
    if customer is None:
        raise sqlite3.DatabaseError("contract customer is missing")
    allocations = connection.execute(
        """
        SELECT allocations.id, allocations.contract_id,
               projects.project_code, allocations.amount_cents
        FROM contract_project_allocations AS allocations
        JOIN projects ON projects.id = allocations.project_id
        WHERE allocations.contract_id = ?
        ORDER BY allocations.id
        """,
        (row["id"],),
    ).fetchall()
    documents = connection.execute(
        """
        SELECT document_version_id FROM contract_document_versions
        WHERE contract_id = ? ORDER BY document_version_id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "contract_no": row["contract_no"],
        "title": row["title"],
        "customer_company_id": row["customer_company_id"],
        "customer_company_name": customer["name"],
        "status": row["status"],
        "signed_on": row["signed_on"],
        "total_amount_cents": row["total_amount_cents"],
        "final_delivery_on": row["final_delivery_on"],
        "allocations": [
            {
                "id": item["id"],
                "contract_id": item["contract_id"],
                "project_code": item["project_code"],
                "amount_cents": item["amount_cents"],
            }
            for item in allocations
        ],
        "notes": row["notes"],
        "document_version_ids": [item[0] for item in documents],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _payment_overview(
    connection: sqlite3.Connection,
    project: sqlite3.Row,
    today: str,
) -> dict[str, object]:
    project_id = int(project["id"])
    contract_rows = connection.execute(
        """
        SELECT allocations.amount_cents
        FROM contract_project_allocations AS allocations
        JOIN contracts ON contracts.id = allocations.contract_id
        WHERE allocations.project_id = ?
          AND contracts.status IN ('signed', 'completed')
        """,
        (project_id,),
    ).fetchall()
    contracted_amount = sum(int(row[0]) for row in contract_rows)
    term_rows = connection.execute(
        "SELECT * FROM payment_terms WHERE project_id = ?",
        (project_id,),
    ).fetchall()
    terms_by_milestone = {str(row["milestone"]): row for row in term_rows}
    receipt_rows = connection.execute(
        """
        SELECT * FROM receipts
        WHERE project_id = ?
        ORDER BY created_at DESC, id DESC
        """,
        (project_id,),
    ).fetchall()
    active_rows = [row for row in receipt_rows if row["status"] == "active"]
    received_by_milestone = {milestone: 0 for milestone in _PAYMENT_MILESTONES}
    for row in active_rows:
        received_by_milestone[str(row["milestone"])] += int(row["amount_cents"])
    term_responses = [
        _payment_term_response(
            terms_by_milestone.get(milestone),
            received_by_milestone[milestone],
            today,
            missing_milestone=milestone,
        )
        for milestone in _PAYMENT_MILESTONES
    ]
    receivable_amount = sum(
        int(term["planned_amount_cents"]) for term in term_responses
    )
    received_amount = sum(int(row["amount_cents"]) for row in active_rows)
    allocated_received = sum(
        int(row["amount_cents"])
        for row in active_rows
        if row["contract_allocation_id"] is not None
    )
    unallocated_received = received_amount - allocated_received
    return {
        "contracted_amount_cents": contracted_amount,
        "receivable_amount_cents": receivable_amount,
        "received_amount_cents": received_amount,
        "allocated_received_amount_cents": allocated_received,
        "unallocated_received_amount_cents": unallocated_received,
        "outstanding_receivable_cents": max(
            receivable_amount - received_amount,
            0,
        ),
        "contract_collection_basis_points": _basis_points(
            allocated_received,
            contracted_amount,
        ),
        "terms": term_responses,
        "receipts": [
            _receipt_response(row, str(project["project_code"]))
            for row in receipt_rows
        ],
    }


def _payment_term_response(
    row: sqlite3.Row | None,
    received_amount: int,
    today: str,
    *,
    missing_milestone: str | None = None,
) -> dict[str, object]:
    if row is None:
        if missing_milestone is None:
            raise sqlite3.DatabaseError("payment milestone is missing")
        milestone = missing_milestone
        term_id = None
        due_on = None
        planned_amount = 0
        notes = None
        revision = None
    else:
        milestone = str(row["milestone"])
        term_id = int(row["id"])
        due_on = row["due_on"]
        planned_amount = int(row["planned_amount_cents"])
        notes = row["notes"]
        revision = int(row["revision"])
    outstanding = max(planned_amount - received_amount, 0)
    if planned_amount == 0:
        term_status = "unplanned"
    elif received_amount == 0:
        term_status = "scheduled"
    elif received_amount < planned_amount:
        term_status = "partial"
    else:
        term_status = "paid"
    return {
        "id": term_id,
        "milestone": milestone,
        "due_on": due_on,
        "planned_amount_cents": planned_amount,
        "received_amount_cents": received_amount,
        "outstanding_amount_cents": outstanding,
        "term_fulfillment_basis_points": _basis_points(
            received_amount,
            planned_amount,
        ),
        "status": term_status,
        "is_overdue": bool(
            due_on is not None
            and planned_amount > 0
            and received_amount < planned_amount
            and str(due_on) < today
        ),
        "notes": notes,
        "revision": revision,
    }


def _receipt_response(
    row: sqlite3.Row,
    project_code: str,
) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_code": project_code,
        "contract_allocation_id": row["contract_allocation_id"],
        "milestone": row["milestone"],
        "received_on": row["received_on"],
        "amount_cents": row["amount_cents"],
        "payment_method": row["payment_method"],
        "reference_no": row["reference_no"],
        "notes": row["notes"],
        "status": row["status"],
        "voided_on": row["voided_on"],
        "void_reason": row["void_reason"],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _quote_row(
    connection: sqlite3.Connection,
    quote_id: int,
    project_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM quotes WHERE id = ? AND project_id = ?",
        (quote_id, project_id),
    ).fetchone()


def _payment_term_row(
    connection: sqlite3.Connection,
    project_id: int,
    milestone: str,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT * FROM payment_terms
        WHERE project_id = ? AND milestone = ?
        """,
        (project_id, milestone),
    ).fetchone()


def _receipt_row(
    connection: sqlite3.Connection,
    receipt_id: int,
    project_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM receipts WHERE id = ? AND project_id = ?",
        (receipt_id, project_id),
    ).fetchone()


def _milestone_received(
    connection: sqlite3.Connection,
    project_id: int,
    milestone: str,
) -> int:
    rows = connection.execute(
        """
        SELECT amount_cents FROM receipts
        WHERE project_id = ? AND milestone = ? AND status = 'active'
        """,
        (project_id, milestone),
    ).fetchall()
    return sum(int(row[0]) for row in rows)


def _validate_receipt_allocation(
    connection: sqlite3.Connection,
    allocation_id: int,
    project_id: int,
) -> None:
    if (
        connection.execute(
            """
            SELECT 1
            FROM contract_project_allocations AS allocations
            JOIN contracts ON contracts.id = allocations.contract_id
            WHERE allocations.id = ? AND allocations.project_id = ?
              AND contracts.status IN ('signed', 'completed')
            """,
            (allocation_id, project_id),
        ).fetchone()
        is None
    ):
        raise _invalid_payload("Invalid receipt payload")


def _contract_row(
    connection: sqlite3.Connection,
    contract_id: int,
    project_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT contracts.*
        FROM contracts
        JOIN contract_project_allocations AS allocations
            ON allocations.contract_id = contracts.id
        WHERE contracts.id = ? AND allocations.project_id = ?
        """,
        (contract_id, project_id),
    ).fetchone()


def _validate_company(connection: sqlite3.Connection, company_id: int) -> None:
    if (
        connection.execute(
            "SELECT 1 FROM companies WHERE id = ?", (company_id,)
        ).fetchone()
        is None
    ):
        raise _invalid_payload("Invalid contract payload")


def _resolve_allocations(
    connection: sqlite3.Connection,
    values: object,
    current_project_code: str,
) -> list[dict[str, object]]:
    if not isinstance(values, list):
        raise _invalid_payload("Invalid contract payload")
    resolved: list[dict[str, object]] = []
    includes_current = False
    for value in values:
        if not isinstance(value, dict):
            raise _invalid_payload("Invalid contract payload")
        project = connection.execute(
            "SELECT * FROM projects WHERE project_code_key = ?",
            (value["project_key"],),
        ).fetchone()
        if project is None or project["status"] != "active":
            raise _invalid_payload("Invalid contract payload")
        includes_current = includes_current or (
            str(project["project_code"]).casefold() == current_project_code.casefold()
        )
        resolved.append(
            {
                "project_id": int(project["id"]),
                "project_code": str(project["project_code"]),
                "amount_cents": int(value["amount_cents"]),
            }
        )
    if not includes_current:
        raise _invalid_payload("Invalid contract payload")
    return resolved


def _replace_allocations(
    connection: sqlite3.Connection,
    contract_id: int,
    allocations: list[dict[str, object]],
) -> None:
    connection.execute(
        "DELETE FROM contract_project_allocations WHERE contract_id = ?",
        (contract_id,),
    )
    for allocation in allocations:
        connection.execute(
            """
            INSERT INTO contract_project_allocations
                (contract_id, project_id, amount_cents)
            VALUES (?, ?, ?)
            """,
            (
                contract_id,
                allocation["project_id"],
                allocation["amount_cents"],
            ),
        )


def _allocation_values(
    connection: sqlite3.Connection,
    contract_id: int,
) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT allocations.project_id, projects.project_code,
               allocations.amount_cents
        FROM contract_project_allocations AS allocations
        JOIN projects ON projects.id = allocations.project_id
        WHERE allocations.contract_id = ?
        ORDER BY allocations.id
        """,
        (contract_id,),
    ).fetchall()
    return [
        {
            "project_id": int(row["project_id"]),
            "project_code": str(row["project_code"]),
            "amount_cents": int(row["amount_cents"]),
        }
        for row in rows
    ]


def _allocation_amounts(
    allocations: list[dict[str, object]],
) -> dict[int, int]:
    return {
        int(allocation["project_id"]): int(allocation["amount_cents"])
        for allocation in allocations
    }


def _require_signing_values(
    contract: dict[str, object],
    allocations: list[dict[str, object]],
) -> None:
    if (
        contract["signed_on"] is None
        or contract["final_delivery_on"] is None
        or not allocations
        or sum(int(item["amount_cents"]) for item in allocations)
        != int(contract["total_amount_cents"])
    ):
        raise _business_conflict(
            "Contract signing requirements are not satisfied",
            "CONTRACT_SIGNING_REQUIREMENTS",
        )


def _replace_document_links(
    connection: sqlite3.Connection,
    table: str,
    owner_column: str,
    owner_id: int,
    document_ids: object,
) -> None:
    if not isinstance(document_ids, list):
        raise sqlite3.DatabaseError("document identifiers are not normalized")
    connection.execute(f"DELETE FROM {table} WHERE {owner_column} = ?", (owner_id,))
    for document_id in document_ids:
        connection.execute(
            f"""
            INSERT INTO {table} ({owner_column}, document_version_id)
            VALUES (?, ?)
            """,
            (owner_id, document_id),
        )


def _validate_document_versions(
    connection: sqlite3.Connection,
    project_code: str,
    document_ids: object,
    detail: str,
) -> None:
    if not isinstance(document_ids, list):
        raise _invalid_payload(detail)
    if not document_ids:
        return
    placeholders = ",".join("?" for _ in document_ids)
    found = connection.execute(
        f"""
        SELECT versions.id
        FROM document_versions AS versions
        JOIN documents ON documents.id = versions.document_id
        WHERE versions.id IN ({placeholders})
          AND documents.project_code = ? COLLATE NOCASE
          AND documents.archived_at IS NULL
        """,
        (*document_ids, project_code),
    ).fetchall()
    if {int(row[0]) for row in found} != set(document_ids):
        raise _invalid_payload(detail)


def _project(connection: sqlite3.Connection, project_key: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT * FROM projects WHERE project_code_key = ?",
        (project_key,),
    ).fetchone()
    if row is None:
        raise _not_found("Project not found")
    return row


def _active_project(connection: sqlite3.Connection, project_key: str) -> sqlite3.Row:
    row = _project(connection, project_key)
    if row["status"] != "active":
        raise _business_conflict("Project is archived", "PROJECT_ARCHIVED")
    return row


async def _read_json(
    request: Request,
    expected_fields: set[str],
    detail: str,
) -> dict[str, Any]:
    try:
        payload: Any = await request.json()
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None
    if not isinstance(payload, dict) or set(payload) != expected_fields:
        raise _invalid_payload(detail)
    return payload


def _read_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("Idempotency-Key")
    if len(values) != 1:
        raise _invalid_payload("Invalid Idempotency-Key")
    try:
        parsed = UUID(values[0])
    except (AttributeError, ValueError):
        raise _invalid_payload("Invalid Idempotency-Key") from None
    canonical = str(parsed)
    if values[0].lower() != canonical:
        raise _invalid_payload("Invalid Idempotency-Key")
    return canonical


def _request_hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _read_pagination(request: Request) -> tuple[int, int]:
    page = _query_integer(
        request,
        "page",
        default=1,
        maximum=_SQLITE_MAX_INTEGER,
    )
    page_size = _query_integer(
        request,
        "page_size",
        default=50,
        maximum=_MAX_PAGE_SIZE,
    )
    if (page - 1) * page_size > _SQLITE_MAX_INTEGER:
        raise _invalid_payload("Invalid pagination")
    return page, page_size


def _query_integer(request: Request, name: str, *, default: int, maximum: int) -> int:
    values = request.query_params.getlist(name)
    if not values:
        return default
    if len(values) != 1 or not values[0].isascii() or not values[0].isdecimal():
        raise _invalid_payload("Invalid pagination")
    value = int(values[0])
    if not 1 <= value <= maximum:
        raise _invalid_payload("Invalid pagination")
    return value


def _normalize_project_path(project_code: str) -> str:
    try:
        return project_code_identity(normalize_project_code(project_code))
    except (TypeError, UnicodeError, ValueError):
        raise _invalid_payload("Invalid project code") from None


def _normalized_project_code(value: object, detail: str) -> str:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    try:
        return normalize_project_code(value)
    except (TypeError, UnicodeError, ValueError):
        raise _invalid_payload(detail) from None


def _payment_milestone(value: str) -> str:
    if value not in _PAYMENT_MILESTONE_SET:
        raise _invalid_payload("Invalid payment milestone")
    return value


def _required_text(value: object, detail: str) -> str:
    normalized = _optional_text(value, detail)
    if normalized is None:
        raise _invalid_payload(detail)
    return normalized


def _optional_text(value: object, detail: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    normalized = value.strip()
    if not normalized:
        return None
    if "\x00" in normalized:
        raise _invalid_payload(detail)
    return normalized


def _positive_integer(value: object, detail: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid_payload(detail)
    if not 1 <= value <= _SQLITE_MAX_INTEGER:
        raise _invalid_payload(detail)
    return value


def _money(value: object, detail: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid_payload(detail)
    if not 0 <= value <= _MAX_MONEY_CENTS:
        raise _invalid_payload(detail)
    return value


def _positive_money(value: object, detail: str) -> int:
    amount = _money(value, detail)
    if amount == 0:
        raise _invalid_payload(detail)
    return amount


def _document_ids(value: object, detail: str) -> list[int]:
    if not isinstance(value, list):
        raise _invalid_payload(detail)
    identifiers = [_positive_integer(item, detail) for item in value]
    if len(set(identifiers)) != len(identifiers):
        raise _invalid_payload(detail)
    return identifiers


def _business_date(value: object, detail: str) -> str:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise _invalid_payload(detail) from None
    if parsed.isoformat() != value:
        raise _invalid_payload(detail)
    return value


def _optional_business_date(value: object, detail: str) -> str | None:
    if value is None:
        return None
    return _business_date(value, detail)


def _aware_timestamp(value: object, detail: str) -> str:
    if not isinstance(value, str):
        raise _invalid_payload(detail)
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _invalid_payload(detail) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise _invalid_payload(detail)
    return parsed.astimezone(timezone.utc).isoformat()


def _basis_points(numerator: int, denominator: int) -> int | None:
    if denominator == 0:
        return None
    return (numerator * 10_000 + denominator // 2) // denominator


def _parse_identifier(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid_payload("Invalid identifier")
    return _positive_integer(int(value), "Invalid identifier")


def _require_revision(row: sqlite3.Row, expected_revision: int) -> None:
    if int(row["revision"]) != expected_revision:
        raise _revision_conflict(int(row["revision"]))


def _revision_conflict(current_revision: int | None) -> ApiError:
    headers = {"X-Error-Code": "REVISION_CONFLICT"}
    if current_revision is not None:
        headers["X-Current-Revision"] = str(current_revision)
    return ApiError(
        status.HTTP_409_CONFLICT,
        "Resource was modified",
        "REVISION_CONFLICT",
        current_revision=current_revision,
        headers=headers,
    )


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not return an identifier")
    return int(cursor.lastrowid)


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _business_today(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_unique_constraint(failure: sqlite3.IntegrityError) -> bool:
    return getattr(failure, "sqlite_errorcode", None) == sqlite3.SQLITE_CONSTRAINT_UNIQUE


def _invalid_payload(detail: str) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail,
        "VALIDATION_ERROR",
    )


def _not_found(detail: str) -> ApiError:
    return ApiError(status.HTTP_404_NOT_FOUND, detail, "RESOURCE_NOT_FOUND")


def _business_conflict(detail: str, error_code: str) -> ApiError:
    return ApiError(
        status.HTTP_409_CONFLICT,
        detail,
        error_code,
        headers={"X-Error-Code": error_code},
    )
