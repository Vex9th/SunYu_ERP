from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction_immediate
from backend.app.core.storage_paths import normalize_project_code, project_code_identity
from backend.app.features.api_common import (
    ApiError,
    ApiErrorRoute,
    idempotency_scope,
    idempotency_storage_key,
    restore_idempotent_response,
    save_idempotent_response,
)
from backend.app.features.auth import require_authenticated_session

Clock = Callable[[], datetime]


_ITEM_INPUT_FIELDS = {
    "brand",
    "name",
    "model",
    "specification",
    "unit",
    "opening_quantity",
    "opening_unit_cost_cents",
    "notes",
}
_ITEM_UPDATE_FIELDS = {
    "brand",
    "name",
    "model",
    "specification",
    "unit",
    "notes",
    "expected_revision",
}
_ADJUSTMENT_FIELDS = {
    "item_id",
    "quantity_delta",
    "unit_cost_cents",
    "reason",
    "occurred_on",
}
_ADJUSTMENT_REVERSAL_FIELDS = {"reason", "expected_revision"}
_ISSUE_FIELDS = {"issued_on", "worker_id", "lines", "notes"}
_ISSUE_LINE_FIELDS = {"inventory_item_id", "procurement_line_id", "quantity"}
_ISSUE_REVERSAL_FIELDS = {"reason", "expected_revision"}
_QUANTITY_PATTERN = re.compile(r"^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$")
_MAX_PAGE_SIZE = 200
_SQLITE_MAX_INTEGER = 2**63 - 1
_INVENTORY_ITEM_CREATE_SCOPE = "POST:/api/inventory/items"


def create_inventory_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=ApiErrorRoute, tags=["inventory"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/inventory/items")
    def list_inventory_items(
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        page, page_size = _read_pagination(request)
        query = _read_single_query(request, "query")
        selected_status = _read_single_query(request, "status") or "all"
        if selected_status not in {"all", "in_stock", "out_of_stock"}:
            raise _invalid_payload("Invalid inventory status")
        clauses: list[str] = []
        parameters: list[object] = []
        if query is not None:
            clauses.append(
                "(name LIKE ? ESCAPE '\\' COLLATE NOCASE "
                "OR brand LIKE ? ESCAPE '\\' COLLATE NOCASE "
                "OR model LIKE ? ESCAPE '\\' COLLATE NOCASE)"
            )
            pattern = f"%{_escape_like(query)}%"
            parameters.extend((pattern, pattern, pattern))
        if selected_status == "in_stock":
            clauses.append("quantity_milli > 0")
        elif selected_status == "out_of_stock":
            clauses.append("quantity_milli = 0")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        total = connection.execute(
            f"SELECT COUNT(*) FROM inventory_items {where}",
            parameters,
        ).fetchone()[0]
        rows = connection.execute(
            f"""
            SELECT * FROM inventory_items
            {where}
            ORDER BY name COLLATE NOCASE, brand COLLATE NOCASE, model COLLATE NOCASE, id
            LIMIT ? OFFSET ?
            """,
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [_item_response(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post("/api/inventory/items", status_code=status.HTTP_201_CREATED)
    async def create_inventory_item(
        request: Request,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _validate_idempotency_key(idempotency_key)
        payload = await _read_json(
            request, _ITEM_INPUT_FIELDS, "Invalid inventory payload"
        )
        normalized = _normalize_item_payload(payload, creating=True)
        request_hash = _request_hash(normalized)
        storage_key = idempotency_storage_key(_INVENTORY_ITEM_CREATE_SCOPE, key)
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            restored = restore_idempotent_response(
                connection,
                scope=_INVENTORY_ITEM_CREATE_SCOPE,
                key=key,
                request_hash=request_hash,
            )
            if restored is not None:
                return restored
            quantity_milli = int(normalized.pop("opening_quantity_milli"))
            unit_cost_cents = normalized.pop("opening_unit_cost_cents")
            inventory_value_cents = (
                0
                if quantity_milli == 0
                else _line_value(int(unit_cost_cents), quantity_milli)
            )
            cursor = connection.execute(
                """
                INSERT INTO inventory_items
                    (brand, name, model, specification, unit, notes,
                     quantity_milli, inventory_value_cents, revision,
                     create_idempotency_key, create_request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    normalized["brand"],
                    normalized["name"],
                    normalized["model"],
                    normalized["specification"],
                    normalized["unit"],
                    normalized["notes"],
                    quantity_milli,
                    inventory_value_cents,
                    storage_key,
                    request_hash,
                    timestamp,
                    timestamp,
                ),
            )
            item_id = _last_insert_id(cursor)
            if quantity_milli > 0:
                _insert_movement(
                    connection,
                    item_id=item_id,
                    project_id=None,
                    procurement_line_id=None,
                    movement_type="opening",
                    quantity_delta_milli=quantity_milli,
                    value_delta_cents=inventory_value_cents,
                    quantity_after_milli=quantity_milli,
                    value_after_cents=inventory_value_cents,
                    source_type="inventory_item",
                    source_id=item_id,
                    occurred_on=timestamp[:10],
                    reason="Opening balance",
                    created_at=timestamp,
                )
            row = _item_row(connection, item_id)
            if row is None:
                raise sqlite3.DatabaseError("created inventory item is missing")
            response = _item_response(row)
            save_idempotent_response(
                connection,
                scope=_INVENTORY_ITEM_CREATE_SCOPE,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_201_CREATED,
                resource_type="inventory_item",
                resource_id=item_id,
                created_at=timestamp,
            )
            return response

    @router.get("/api/inventory/items/{item_id}")
    def get_inventory_item(
        item_id: str,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(item_id)
        row = _item_row(connection, identifier)
        if row is None:
            raise _not_found("Inventory item not found")
        movements = connection.execute(
            """
            SELECT movements.*, projects.project_code,
                   issues.status AS issue_status,
                   issues.revision AS issue_revision,
                   adjustments.status AS adjustment_status,
                   adjustments.revision AS adjustment_revision
            FROM inventory_movements AS movements
            LEFT JOIN projects ON projects.id = movements.project_id
            LEFT JOIN inventory_issues AS issues
              ON issues.id = movements.source_id
             AND movements.source_type IN (
                 'inventory_issue', 'inventory_issue_reversal'
             )
            LEFT JOIN inventory_adjustments AS adjustments
              ON adjustments.id = movements.source_id
             AND movements.source_type = 'inventory_adjustment'
            WHERE movements.inventory_item_id = ?
            ORDER BY movements.created_at DESC, movements.id DESC
            LIMIT 20
            """,
            (identifier,),
        ).fetchall()
        return {
            **_item_response(row),
            "movements": [_movement_response(row) for row in movements],
        }

    @router.put("/api/inventory/items/{item_id}")
    async def update_inventory_item(
        item_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(item_id)
        payload = await _read_json(
            request, _ITEM_UPDATE_FIELDS, "Invalid inventory payload"
        )
        normalized = _normalize_item_payload(payload, creating=False)
        expected_revision = _positive_integer(
            payload["expected_revision"], "Invalid inventory payload"
        )
        timestamp = _timestamp(now)
        with transaction_immediate(connection):
            current = _item_row(connection, identifier)
            if current is None:
                raise _not_found("Inventory item not found")
            if current["revision"] != expected_revision:
                raise _revision_conflict(int(current["revision"]))
            connection.execute(
                """
                UPDATE inventory_items
                SET brand = ?, name = ?, model = ?, specification = ?,
                    unit = ?, notes = ?, revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?
                """,
                (
                    normalized["brand"],
                    normalized["name"],
                    normalized["model"],
                    normalized["specification"],
                    normalized["unit"],
                    normalized["notes"],
                    timestamp,
                    identifier,
                    expected_revision,
                ),
            )
            updated = _item_row(connection, identifier)
            if updated is None:
                raise sqlite3.DatabaseError("updated inventory item is missing")
            return _item_response(updated)

    @router.get("/api/inventory/items/{item_id}/movements")
    def list_inventory_movements(
        item_id: str,
        request: Request,
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(item_id)
        if _item_row(connection, identifier) is None:
            raise _not_found("Inventory item not found")
        page, page_size = _read_pagination(request)
        total = connection.execute(
            "SELECT COUNT(*) FROM inventory_movements WHERE inventory_item_id = ?",
            (identifier,),
        ).fetchone()[0]
        rows = connection.execute(
            """
            SELECT movements.*, projects.project_code,
                   issues.status AS issue_status,
                   issues.revision AS issue_revision,
                   adjustments.status AS adjustment_status,
                   adjustments.revision AS adjustment_revision
            FROM inventory_movements AS movements
            LEFT JOIN projects ON projects.id = movements.project_id
            LEFT JOIN inventory_issues AS issues
              ON issues.id = movements.source_id
             AND movements.source_type IN (
                 'inventory_issue', 'inventory_issue_reversal'
             )
            LEFT JOIN inventory_adjustments AS adjustments
              ON adjustments.id = movements.source_id
             AND movements.source_type = 'inventory_adjustment'
            WHERE movements.inventory_item_id = ?
            ORDER BY movements.created_at DESC, movements.id DESC
            LIMIT ? OFFSET ?
            """,
            (identifier, page_size, (page - 1) * page_size),
        ).fetchall()
        return {
            "items": [_movement_response(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @router.post("/api/inventory/adjustments", status_code=status.HTTP_201_CREATED)
    async def create_inventory_adjustment(
        request: Request,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _validate_idempotency_key(idempotency_key)
        payload = await _read_json(
            request, _ADJUSTMENT_FIELDS, "Invalid inventory payload"
        )
        normalized = _normalize_adjustment(payload)
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
            replay = connection.execute(
                "SELECT * FROM inventory_adjustments WHERE idempotency_key = ?",
                (key,),
            ).fetchone()
            if replay is not None:
                _require_same_request(replay["request_hash"], request_hash)
                return _adjustment_response(connection, replay)
            item = _item_row(connection, int(normalized["item_id"]))
            if item is None:
                raise _not_found("Inventory item not found")
            delta = int(normalized["quantity_delta_milli"])
            quantity_after = int(item["quantity_milli"]) + delta
            if quantity_after < 0:
                raise _business_conflict(
                    "Insufficient inventory", "INSUFFICIENT_INVENTORY"
                )
            value_delta = _adjustment_value_delta(
                int(item["quantity_milli"]),
                int(item["inventory_value_cents"]),
                delta,
                normalized["unit_cost_cents"],
            )
            value_after = int(item["inventory_value_cents"]) + value_delta
            if quantity_after == 0:
                value_after = 0
                value_delta = -int(item["inventory_value_cents"])
            if value_after > _SQLITE_MAX_INTEGER:
                raise _invalid_payload("Invalid inventory payload")
            cursor = connection.execute(
                """
                INSERT INTO inventory_adjustments
                    (inventory_item_id, quantity_delta_milli, unit_cost_cents,
                     value_delta_cents, occurred_on, reason, idempotency_key,
                     request_hash, movement_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    normalized["item_id"],
                    delta,
                    normalized["unit_cost_cents"],
                    value_delta,
                    normalized["occurred_on"],
                    normalized["reason"],
                    key,
                    request_hash,
                    timestamp,
                ),
            )
            adjustment_id = _last_insert_id(cursor)
            movement_id = _insert_movement(
                connection,
                item_id=int(normalized["item_id"]),
                project_id=None,
                procurement_line_id=None,
                movement_type="adjustment",
                quantity_delta_milli=delta,
                value_delta_cents=value_delta,
                quantity_after_milli=quantity_after,
                value_after_cents=value_after,
                source_type="inventory_adjustment",
                source_id=adjustment_id,
                occurred_on=str(normalized["occurred_on"]),
                reason=str(normalized["reason"]),
                created_at=timestamp,
            )
            connection.execute(
                """
                UPDATE inventory_adjustments SET movement_id = ? WHERE id = ?
                """,
                (movement_id, adjustment_id),
            )
            _update_balance(
                connection,
                int(normalized["item_id"]),
                quantity_after,
                value_after,
                timestamp,
            )
            row = connection.execute(
                "SELECT * FROM inventory_adjustments WHERE id = ?",
                (adjustment_id,),
            ).fetchone()
            response = _adjustment_response(connection, row)
            save_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_201_CREATED,
                resource_type="inventory_adjustment",
                resource_id=adjustment_id,
                created_at=timestamp,
            )
            return response

    @router.post("/api/inventory/adjustments/{adjustment_id}/reverse")
    async def reverse_inventory_adjustment(
        adjustment_id: str,
        request: Request,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(adjustment_id)
        key = _validate_idempotency_key(idempotency_key)
        payload = await _read_json(
            request,
            _ADJUSTMENT_REVERSAL_FIELDS,
            "Invalid inventory adjustment reversal payload",
        )
        normalized = _normalize_adjustment_reversal(payload)
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
            adjustment = _adjustment_row(connection, identifier)
            if adjustment is None:
                raise _not_found("Inventory adjustment not found")
            if adjustment["status"] != "active":
                raise _business_conflict(
                    "Inventory adjustment is already reversed",
                    "INVENTORY_ADJUSTMENT_ALREADY_REVERSED",
                )
            expected_revision = int(normalized["expected_revision"])
            if int(adjustment["revision"]) != expected_revision:
                raise _revision_conflict(int(adjustment["revision"]))
            item = _item_row(connection, int(adjustment["inventory_item_id"]))
            if item is None:
                raise sqlite3.DatabaseError("inventory adjustment item is missing")
            quantity_delta = -int(adjustment["quantity_delta_milli"])
            value_delta = -int(adjustment["value_delta_cents"])
            quantity_after = int(item["quantity_milli"]) + quantity_delta
            value_after = int(item["inventory_value_cents"]) + value_delta
            if quantity_after < 0 or value_after < 0:
                raise _business_conflict(
                    "Inventory is insufficient to reverse this adjustment",
                    "INVENTORY_ADJUSTMENT_REVERSAL_INSUFFICIENT_INVENTORY",
                )
            if (
                quantity_after > _SQLITE_MAX_INTEGER
                or value_after > _SQLITE_MAX_INTEGER
                or (quantity_after == 0 and value_after != 0)
            ):
                raise _business_conflict(
                    "Inventory adjustment reversal exceeds storage capacity",
                    "INVENTORY_ADJUSTMENT_REVERSAL_OVERFLOW",
                )
            reversal_movement_id = _insert_movement(
                connection,
                item_id=int(item["id"]),
                project_id=None,
                procurement_line_id=None,
                movement_type="reversal",
                quantity_delta_milli=quantity_delta,
                value_delta_cents=value_delta,
                quantity_after_milli=quantity_after,
                value_after_cents=value_after,
                source_type="inventory_adjustment_reversal",
                source_id=identifier,
                occurred_on=timestamp[:10],
                reason=str(normalized["reason"]),
                created_at=timestamp,
            )
            updated = connection.execute(
                """
                UPDATE inventory_adjustments
                SET status = 'reversed', reversal_reason = ?, reversed_at = ?,
                    reversal_movement_id = ?, revision = revision + 1
                WHERE id = ? AND status = 'active' AND revision = ?
                """,
                (
                    normalized["reason"],
                    timestamp,
                    reversal_movement_id,
                    identifier,
                    expected_revision,
                ),
            )
            if updated.rowcount != 1:
                raise sqlite3.DatabaseError("inventory adjustment reversal update failed")
            _update_balance(
                connection,
                int(item["id"]),
                quantity_after,
                value_after,
                timestamp,
            )
            reversed_adjustment = _adjustment_row(connection, identifier)
            if reversed_adjustment is None:
                raise sqlite3.DatabaseError("reversed inventory adjustment is missing")
            response = _adjustment_response(connection, reversed_adjustment)
            save_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_200_OK,
                resource_type="inventory_adjustment",
                resource_id=identifier,
                created_at=timestamp,
            )
            return response

    @router.post(
        "/api/projects/{project_code}/inventory-issues",
        status_code=status.HTTP_201_CREATED,
    )
    async def create_project_issue(
        project_code: str,
        request: Request,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        key = _validate_idempotency_key(idempotency_key)
        payload = await _read_json(
            request, _ISSUE_FIELDS, "Invalid inventory issue payload"
        )
        normalized = _normalize_issue(payload)
        request_hash = _request_hash(normalized)
        scope = idempotency_scope(request)
        storage_key = idempotency_storage_key(scope, key)
        timestamp = _timestamp(now)
        project_key = _normalize_project_path(project_code)
        with transaction_immediate(connection):
            restored = restore_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
            )
            if restored is not None:
                return restored
            project = _active_project(connection, project_key)
            worker_id = normalized["worker_id"]
            if (
                worker_id is not None
                and _table_exists(connection, "workers")
                and connection.execute(
                    "SELECT 1 FROM workers WHERE id = ?",
                    (worker_id,),
                ).fetchone()
                is None
            ):
                raise _not_found("Worker not found")
            cursor = connection.execute(
                """
                INSERT INTO inventory_issues
                    (project_id, issued_on, worker_id, notes, status,
                     total_cost_cents, revision, idempotency_key, request_hash,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', 0, 1, ?, ?, ?, ?)
                """,
                (
                    project["id"],
                    normalized["issued_on"],
                    worker_id,
                    normalized["notes"],
                    storage_key,
                    request_hash,
                    timestamp,
                    timestamp,
                ),
            )
            issue_id = _last_insert_id(cursor)
            total_cost = 0
            for line in normalized["lines"]:
                total_cost += _post_issue_line(
                    connection,
                    issue_id=issue_id,
                    project_id=int(project["id"]),
                    line=line,
                    issued_on=str(normalized["issued_on"]),
                    created_at=timestamp,
                )
                if total_cost > _SQLITE_MAX_INTEGER:
                    raise _invalid_payload("Invalid inventory issue payload")
            connection.execute(
                "UPDATE inventory_issues SET total_cost_cents = ? WHERE id = ?",
                (total_cost, issue_id),
            )
            issue = connection.execute(
                "SELECT * FROM inventory_issues WHERE id = ?",
                (issue_id,),
            ).fetchone()
            if issue is None:
                raise sqlite3.DatabaseError("created inventory issue is missing")
            response = _issue_response(connection, issue)
            save_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_201_CREATED,
                resource_type="inventory_issue",
                resource_id=issue_id,
                created_at=timestamp,
            )
            return response

    @router.post(
        "/api/projects/{project_code}/inventory-issues/{issue_id}/reverse"
    )
    async def reverse_project_issue(
        project_code: str,
        issue_id: str,
        request: Request,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
    ) -> dict[str, object]:
        identifier = _parse_identifier(issue_id)
        key = _validate_idempotency_key(idempotency_key)
        payload = await _read_json(
            request,
            _ISSUE_REVERSAL_FIELDS,
            "Invalid inventory issue reversal payload",
        )
        normalized = _normalize_issue_reversal(payload)
        request_hash = _request_hash(normalized)
        scope = idempotency_scope(request)
        timestamp = _timestamp(now)
        project_key = _normalize_project_path(project_code)
        with transaction_immediate(connection):
            restored = restore_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
            )
            if restored is not None:
                return restored
            project = _active_project(connection, project_key)
            issue = _project_issue_row(
                connection,
                issue_id=identifier,
                project_id=int(project["id"]),
            )
            if issue is None:
                raise _not_found("Inventory issue not found")
            if issue["status"] != "active":
                raise _business_conflict(
                    "Inventory issue is already reversed",
                    "INVENTORY_ISSUE_ALREADY_REVERSED",
                )
            expected_revision = int(normalized["expected_revision"])
            if int(issue["revision"]) != expected_revision:
                raise _revision_conflict(int(issue["revision"]))
            _reverse_issue_inventory(
                connection,
                issue=issue,
                project_id=int(project["id"]),
                reason=str(normalized["reason"]),
                timestamp=timestamp,
            )
            updated = connection.execute(
                """
                UPDATE inventory_issues
                SET status = 'reversed', revision = revision + 1, updated_at = ?
                WHERE id = ? AND status = 'active' AND revision = ?
                """,
                (timestamp, identifier, expected_revision),
            )
            if updated.rowcount != 1:
                raise sqlite3.DatabaseError("inventory issue reversal update failed")
            reversed_issue = _project_issue_row(
                connection,
                issue_id=identifier,
                project_id=int(project["id"]),
            )
            if reversed_issue is None:
                raise sqlite3.DatabaseError("reversed inventory issue is missing")
            response = _issue_response(connection, reversed_issue)
            save_idempotent_response(
                connection,
                scope=scope,
                key=key,
                request_hash=request_hash,
                response=response,
                response_status=status.HTTP_200_OK,
                resource_type="inventory_issue",
                resource_id=identifier,
                created_at=timestamp,
            )
            return response

    return router


def ensure_receipt_inventory_item(
    connection: sqlite3.Connection,
    procurement_line: sqlite3.Row,
    *,
    timestamp: str,
) -> sqlite3.Row:
    procurement_line_id = int(procurement_line["procurement_line_id"])
    item_id = procurement_line["inventory_item_id"]
    if item_id is not None:
        item = _item_row(connection, int(item_id))
        if item is None:
            raise sqlite3.DatabaseError("procurement inventory item is missing")
        if _receipt_inventory_identity(item) == _receipt_inventory_identity(
            procurement_line
        ):
            return item
    matches = connection.execute(
        """
        SELECT * FROM inventory_items
        WHERE name = ? COLLATE NOCASE
          AND unit = ? COLLATE NOCASE
          AND brand IS ?
          AND model IS ?
          AND specification IS ?
        ORDER BY id
        LIMIT 2
        """,
        (
            procurement_line["name"],
            procurement_line["unit"],
            procurement_line["brand"],
            procurement_line["model"],
            procurement_line["specification"],
        ),
    ).fetchall()
    if len(matches) == 1:
        item = matches[0]
    else:
        stable_key = f"procurement-line-{procurement_line_id}"
        cursor = connection.execute(
            """
            INSERT INTO inventory_items
                (brand, name, model, specification, unit, notes,
                 quantity_milli, inventory_value_cents, revision,
                 create_idempotency_key, create_request_hash,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?, ?, ?)
            """,
            (
                procurement_line["brand"],
                procurement_line["name"],
                procurement_line["model"],
                procurement_line["specification"],
                procurement_line["unit"],
                stable_key,
                hashlib.sha256(stable_key.encode()).hexdigest(),
                timestamp,
                timestamp,
            ),
        )
        created_id = _last_insert_id(cursor)
        item = _item_row(connection, created_id)
    if item is None:
        raise sqlite3.DatabaseError("receipt inventory item was not created")
    connection.execute(
        "UPDATE procurement_lines SET inventory_item_id = ? WHERE id = ?",
        (item["id"], procurement_line_id),
    )
    return item


def _receipt_inventory_identity(row: sqlite3.Row) -> tuple[object, ...]:
    return (
        str(row["name"]).casefold(),
        str(row["unit"]).casefold(),
        row["brand"],
        row["model"],
        row["specification"],
    )


def post_receipt_movement(
    connection: sqlite3.Connection,
    *,
    item: sqlite3.Row,
    project_id: int,
    procurement_line_id: int,
    receipt_id: int,
    quantity_milli: int,
    value_cents: int,
    received_on: str,
    created_at: str,
) -> int:
    quantity_after = int(item["quantity_milli"]) + quantity_milli
    value_after = int(item["inventory_value_cents"]) + value_cents
    if value_after > _SQLITE_MAX_INTEGER:
        raise _invalid_payload("Invalid goods receipt payload")
    movement_id = _insert_movement(
        connection,
        item_id=int(item["id"]),
        project_id=project_id,
        procurement_line_id=procurement_line_id,
        movement_type="goods_receipt",
        quantity_delta_milli=quantity_milli,
        value_delta_cents=value_cents,
        quantity_after_milli=quantity_after,
        value_after_cents=value_after,
        source_type="goods_receipt",
        source_id=receipt_id,
        occurred_on=received_on,
        reason=None,
        created_at=created_at,
    )
    _update_balance(
        connection,
        int(item["id"]),
        quantity_after,
        value_after,
        created_at,
    )
    return movement_id


def parse_quantity(value: object, *, allow_negative: bool = False) -> int:
    if not isinstance(value, str) or _QUANTITY_PATTERN.fullmatch(value) is None:
        raise _invalid_payload("Invalid quantity")
    try:
        decimal_value = Decimal(value)
    except InvalidOperation:
        raise _invalid_payload("Invalid quantity") from None
    milli = int((decimal_value * 1000).to_integral_exact())
    if milli == 0 or (milli < 0 and not allow_negative):
        raise _invalid_payload("Invalid quantity")
    return milli


def format_quantity(quantity_milli: int) -> str:
    sign = "-" if quantity_milli < 0 else ""
    absolute = abs(quantity_milli)
    return f"{sign}{absolute // 1000}.{absolute % 1000:03d}"


def line_value(
    unit_cost_cents: int,
    quantity_milli: int,
    *,
    detail: str = "Invalid monetary value",
) -> int:
    value = _line_value(unit_cost_cents, quantity_milli)
    if not 0 <= value <= _SQLITE_MAX_INTEGER:
        raise _invalid_payload(detail)
    return value


def _normalize_item_payload(
    payload: dict[str, Any], *, creating: bool
) -> dict[str, object]:
    normalized: dict[str, object] = {
        "brand": _optional_text(payload["brand"]),
        "name": _required_text(payload["name"], "Invalid inventory payload"),
        "model": _optional_text(payload["model"]),
        "specification": _optional_text(payload["specification"]),
        "unit": _required_text(payload["unit"], "Invalid inventory payload"),
        "notes": _optional_text(payload["notes"]),
    }
    if creating:
        raw_quantity = payload["opening_quantity"]
        if raw_quantity == "0":
            quantity_milli = 0
        else:
            quantity_milli = parse_quantity(raw_quantity)
        unit_cost = payload["opening_unit_cost_cents"]
        if quantity_milli > 0 or unit_cost is not None:
            unit_cost = _nonnegative_money(unit_cost, "Invalid inventory payload")
        if quantity_milli > 0:
            line_value(
                int(unit_cost),
                quantity_milli,
                detail="Invalid inventory payload",
            )
        normalized["opening_quantity_milli"] = quantity_milli
        normalized["opening_unit_cost_cents"] = unit_cost
    return normalized


def _normalize_adjustment(payload: dict[str, Any]) -> dict[str, object]:
    item_id = _positive_integer(payload["item_id"], "Invalid inventory payload")
    delta = parse_quantity(payload["quantity_delta"], allow_negative=True)
    unit_cost = payload["unit_cost_cents"]
    if delta > 0:
        unit_cost = _nonnegative_money(unit_cost, "Invalid inventory payload")
        line_value(
            int(unit_cost),
            delta,
            detail="Invalid inventory payload",
        )
    elif unit_cost is not None:
        raise _invalid_payload("Invalid inventory payload")
    return {
        "item_id": item_id,
        "quantity_delta_milli": delta,
        "unit_cost_cents": unit_cost,
        "reason": _required_text(payload["reason"], "Invalid inventory payload"),
        "occurred_on": _business_date(
            payload["occurred_on"], "Invalid inventory payload"
        ),
    }


def _normalize_adjustment_reversal(payload: dict[str, Any]) -> dict[str, object]:
    return {
        "reason": _required_text(
            payload["reason"], "Invalid inventory adjustment reversal payload"
        ),
        "expected_revision": _positive_integer(
            payload["expected_revision"],
            "Invalid inventory adjustment reversal payload",
        ),
    }


def _normalize_issue(payload: dict[str, Any]) -> dict[str, object]:
    raw_lines = payload["lines"]
    if not isinstance(raw_lines, list) or not raw_lines:
        raise _invalid_payload("Invalid inventory issue payload")
    lines: list[dict[str, int | None]] = []
    identities: set[tuple[int, int | None]] = set()
    for raw_line in raw_lines:
        if not isinstance(raw_line, dict) or set(raw_line) != _ISSUE_LINE_FIELDS:
            raise _invalid_payload("Invalid inventory issue payload")
        item_id = _positive_integer(
            raw_line["inventory_item_id"], "Invalid inventory issue payload"
        )
        raw_procurement_id = raw_line["procurement_line_id"]
        procurement_line_id = (
            None
            if raw_procurement_id is None
            else _positive_integer(
                raw_procurement_id, "Invalid inventory issue payload"
            )
        )
        identity = (item_id, procurement_line_id)
        if identity in identities:
            raise _invalid_payload("Invalid inventory issue payload")
        identities.add(identity)
        lines.append(
            {
                "inventory_item_id": item_id,
                "procurement_line_id": procurement_line_id,
                "quantity_milli": parse_quantity(raw_line["quantity"]),
            }
        )
    worker_id = payload["worker_id"]
    if worker_id is not None:
        worker_id = _positive_integer(worker_id, "Invalid inventory issue payload")
    return {
        "issued_on": _business_date(
            payload["issued_on"], "Invalid inventory issue payload"
        ),
        "worker_id": worker_id,
        "lines": lines,
        "notes": _optional_text(payload["notes"]),
    }


def _normalize_issue_reversal(payload: dict[str, Any]) -> dict[str, object]:
    return {
        "reason": _required_text(
            payload["reason"], "Invalid inventory issue reversal payload"
        ),
        "expected_revision": _positive_integer(
            payload["expected_revision"],
            "Invalid inventory issue reversal payload",
        ),
    }


def _reverse_issue_inventory(
    connection: sqlite3.Connection,
    *,
    issue: sqlite3.Row,
    project_id: int,
    reason: str,
    timestamp: str,
) -> None:
    lines = connection.execute(
        """
        SELECT * FROM inventory_issue_lines
        WHERE inventory_issue_id = ? ORDER BY id
        """,
        (issue["id"],),
    ).fetchall()
    for line in lines:
        item = _item_row(connection, int(line["inventory_item_id"]))
        if item is None:
            raise sqlite3.DatabaseError("inventory issue item is missing")
        quantity_after = int(item["quantity_milli"]) + int(line["quantity_milli"])
        value_after = int(item["inventory_value_cents"]) + int(line["cost_cents"])
        if quantity_after > _SQLITE_MAX_INTEGER or value_after > _SQLITE_MAX_INTEGER:
            raise _business_conflict(
                "Inventory issue reversal exceeds storage capacity",
                "INVENTORY_ISSUE_REVERSAL_OVERFLOW",
            )
        _insert_movement(
            connection,
            item_id=int(item["id"]),
            project_id=project_id,
            procurement_line_id=(
                None
                if line["procurement_line_id"] is None
                else int(line["procurement_line_id"])
            ),
            movement_type="reversal",
            quantity_delta_milli=int(line["quantity_milli"]),
            value_delta_cents=int(line["cost_cents"]),
            quantity_after_milli=quantity_after,
            value_after_cents=value_after,
            source_type="inventory_issue_reversal",
            source_id=int(issue["id"]),
            occurred_on=timestamp[:10],
            reason=reason,
            created_at=timestamp,
        )
        _update_balance(
            connection,
            int(item["id"]),
            quantity_after,
            value_after,
            timestamp,
        )


def _post_issue_line(
    connection: sqlite3.Connection,
    *,
    issue_id: int,
    project_id: int,
    line: dict[str, int | None],
    issued_on: str,
    created_at: str,
) -> int:
    item_id = int(line["inventory_item_id"])
    quantity = int(line["quantity_milli"])
    item = _item_row(connection, item_id)
    if item is None:
        raise _not_found("Inventory item not found")
    if quantity > int(item["quantity_milli"]):
        raise _business_conflict("Insufficient inventory", "INSUFFICIENT_INVENTORY")
    procurement_line_id = line["procurement_line_id"]
    if procurement_line_id is not None:
        procurement = connection.execute(
            """
            SELECT lines.id, lines.quantity_milli, lines.inventory_item_id
            FROM procurement_lines AS lines
            JOIN procurement_lists AS lists ON lists.id = lines.procurement_list_id
            WHERE lines.id = ? AND lists.project_id = ?
            """,
            (procurement_line_id, project_id),
        ).fetchone()
        if procurement is None or procurement["inventory_item_id"] != item_id:
            raise _invalid_payload("Invalid inventory issue payload")
        used = connection.execute(
            """
            SELECT COALESCE(SUM(lines.quantity_milli), 0)
            FROM inventory_issue_lines AS lines
            JOIN inventory_issues AS issues ON issues.id = lines.inventory_issue_id
            WHERE lines.procurement_line_id = ? AND issues.status = 'active'
            """,
            (procurement_line_id,),
        ).fetchone()[0]
        if used + quantity > procurement["quantity_milli"]:
            raise _business_conflict(
                "Issue quantity exceeds procurement requirement",
                "PROCUREMENT_USAGE_EXCEEDED",
            )
    current_quantity = int(item["quantity_milli"])
    current_value = int(item["inventory_value_cents"])
    cost = (
        current_value
        if quantity == current_quantity
        else _round_ratio(current_value * quantity, current_quantity)
    )
    quantity_after = current_quantity - quantity
    value_after = current_value - cost
    if quantity_after == 0:
        value_after = 0
        cost = current_value
    movement_id = _insert_movement(
        connection,
        item_id=item_id,
        project_id=project_id,
        procurement_line_id=(
            None if procurement_line_id is None else int(procurement_line_id)
        ),
        movement_type="project_issue",
        quantity_delta_milli=-quantity,
        value_delta_cents=-cost,
        quantity_after_milli=quantity_after,
        value_after_cents=value_after,
        source_type="inventory_issue",
        source_id=issue_id,
        occurred_on=issued_on,
        reason=None,
        created_at=created_at,
    )
    connection.execute(
        """
        INSERT INTO inventory_issue_lines
            (inventory_issue_id, inventory_item_id, procurement_line_id,
             quantity_milli, cost_cents, movement_id)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (issue_id, item_id, procurement_line_id, quantity, cost, movement_id),
    )
    _update_balance(connection, item_id, quantity_after, value_after, created_at)
    return cost


def _insert_movement(
    connection: sqlite3.Connection,
    *,
    item_id: int,
    project_id: int | None,
    procurement_line_id: int | None,
    movement_type: str,
    quantity_delta_milli: int,
    value_delta_cents: int,
    quantity_after_milli: int,
    value_after_cents: int,
    source_type: str,
    source_id: int,
    occurred_on: str,
    reason: str | None,
    created_at: str,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO inventory_movements
            (inventory_item_id, project_id, procurement_line_id, movement_type,
             quantity_delta_milli, value_delta_cents, quantity_after_milli,
             value_after_cents, source_type, source_id, occurred_on, reason,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item_id,
            project_id,
            procurement_line_id,
            movement_type,
            quantity_delta_milli,
            value_delta_cents,
            quantity_after_milli,
            value_after_cents,
            source_type,
            source_id,
            occurred_on,
            reason,
            created_at,
        ),
    )
    return _last_insert_id(cursor)


def _update_balance(
    connection: sqlite3.Connection,
    item_id: int,
    quantity_milli: int,
    inventory_value_cents: int,
    timestamp: str,
) -> None:
    cursor = connection.execute(
        """
        UPDATE inventory_items
        SET quantity_milli = ?, inventory_value_cents = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
        """,
        (quantity_milli, inventory_value_cents, timestamp, item_id),
    )
    if cursor.rowcount != 1:
        raise sqlite3.DatabaseError("inventory balance update failed")


def _adjustment_value_delta(
    current_quantity: int,
    current_value: int,
    quantity_delta: int,
    unit_cost_cents: object,
) -> int:
    if quantity_delta > 0:
        return _line_value(int(unit_cost_cents), quantity_delta)
    outbound = -quantity_delta
    if outbound == current_quantity:
        return -current_value
    return -_round_ratio(current_value * outbound, current_quantity)


def _item_response(row: sqlite3.Row) -> dict[str, object]:
    quantity = int(row["quantity_milli"])
    value = int(row["inventory_value_cents"])
    average = 0 if quantity == 0 else _round_ratio(value * 1000, quantity)
    return {
        "id": row["id"],
        "brand": row["brand"],
        "name": row["name"],
        "model": row["model"],
        "specification": row["specification"],
        "unit": row["unit"],
        "quantity": format_quantity(quantity),
        "average_unit_cost_cents": average,
        "inventory_value_cents": value,
        "notes": row["notes"],
        "revision": row["revision"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _movement_response(row: sqlite3.Row) -> dict[str, object]:
    columns = set(row.keys())
    return {
        "id": row["id"],
        "inventory_item_id": row["inventory_item_id"],
        "project_id": row["project_id"],
        "procurement_line_id": row["procurement_line_id"],
        "movement_type": row["movement_type"],
        "quantity_delta": format_quantity(int(row["quantity_delta_milli"])),
        "value_delta_cents": row["value_delta_cents"],
        "quantity_after": format_quantity(int(row["quantity_after_milli"])),
        "value_after_cents": row["value_after_cents"],
        "source_type": row["source_type"],
        "source_id": row["source_id"],
        "occurred_on": row["occurred_on"],
        "reason": row["reason"],
        "created_at": row["created_at"],
        "project_code": row["project_code"] if "project_code" in columns else None,
        "issue_status": row["issue_status"] if "issue_status" in columns else None,
        "issue_revision": (
            row["issue_revision"] if "issue_revision" in columns else None
        ),
        "adjustment_status": (
            row["adjustment_status"] if "adjustment_status" in columns else None
        ),
        "adjustment_revision": (
            row["adjustment_revision"]
            if "adjustment_revision" in columns
            else None
        ),
    }


def _adjustment_response(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
) -> dict[str, object]:
    movement = connection.execute(
        "SELECT * FROM inventory_movements WHERE id = ?",
        (row["movement_id"],),
    ).fetchone()
    reversal_movement = (
        None
        if row["reversal_movement_id"] is None
        else connection.execute(
            "SELECT * FROM inventory_movements WHERE id = ?",
            (row["reversal_movement_id"],),
        ).fetchone()
    )
    return {
        "id": row["id"],
        "inventory_item_id": row["inventory_item_id"],
        "quantity_delta": format_quantity(int(row["quantity_delta_milli"])),
        "unit_cost_cents": row["unit_cost_cents"],
        "value_delta_cents": row["value_delta_cents"],
        "occurred_on": row["occurred_on"],
        "reason": row["reason"],
        "status": row["status"],
        "revision": row["revision"],
        "reversal_reason": row["reversal_reason"],
        "reversed_at": row["reversed_at"],
        "movement": _movement_response(movement),
        "reversal_movement": (
            None
            if reversal_movement is None
            else _movement_response(reversal_movement)
        ),
        "created_at": row["created_at"],
    }


def _issue_response(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> dict[str, object]:
    lines = connection.execute(
        """
        SELECT * FROM inventory_issue_lines
        WHERE inventory_issue_id = ? ORDER BY id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "issued_on": row["issued_on"],
        "worker_id": row["worker_id"],
        "notes": row["notes"],
        "status": row["status"],
        "total_cost_cents": row["total_cost_cents"],
        "revision": row["revision"],
        "lines": [
            {
                "id": line["id"],
                "inventory_item_id": line["inventory_item_id"],
                "procurement_line_id": line["procurement_line_id"],
                "quantity": format_quantity(int(line["quantity_milli"])),
                "cost_cents": line["cost_cents"],
                "movement_id": line["movement_id"],
            }
            for line in lines
        ],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _item_row(connection: sqlite3.Connection, item_id: int) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM inventory_items WHERE id = ?",
        (item_id,),
    ).fetchone()


def _adjustment_row(
    connection: sqlite3.Connection, adjustment_id: int
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM inventory_adjustments WHERE id = ?",
        (adjustment_id,),
    ).fetchone()


def _project_issue_row(
    connection: sqlite3.Connection,
    *,
    issue_id: int,
    project_id: int,
) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM inventory_issues WHERE id = ? AND project_id = ?",
        (issue_id, project_id),
    ).fetchone()


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


def _read_pagination(request: Request) -> tuple[int, int]:
    return (
        _query_integer(request, "page", default=1, maximum=_SQLITE_MAX_INTEGER),
        _query_integer(request, "page_size", default=50, maximum=_MAX_PAGE_SIZE),
    )


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


def _read_single_query(request: Request, name: str) -> str | None:
    values = request.query_params.getlist(name)
    if not values:
        return None
    if len(values) != 1:
        raise _invalid_payload(f"Invalid {name}")
    normalized = values[0].strip()
    return normalized or None


def _required_text(value: object, detail: str) -> str:
    normalized = _optional_text(value)
    if normalized is None:
        raise _invalid_payload(detail)
    return normalized


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid_payload("Invalid inventory payload")
    normalized = value.strip()
    if not normalized:
        return None
    if "\x00" in normalized:
        raise _invalid_payload("Invalid inventory payload")
    return normalized


def _positive_integer(value: object, detail: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid_payload(detail)
    if not 1 <= value <= _SQLITE_MAX_INTEGER:
        raise _invalid_payload(detail)
    return value


def _nonnegative_money(value: object, detail: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _invalid_payload(detail)
    if value > 9_000_000_000_000:
        raise _invalid_payload(detail)
    return value


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


def _validate_idempotency_key(value: str) -> str:
    try:
        parsed = UUID(value)
    except (AttributeError, ValueError):
        raise _invalid_payload("Invalid Idempotency-Key") from None
    canonical = str(parsed)
    if value.lower() != canonical:
        raise _invalid_payload("Invalid Idempotency-Key")
    return canonical


def _request_hash(payload: object) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _require_same_request(stored_hash: str, request_hash: str) -> None:
    if stored_hash != request_hash:
        raise _business_conflict("Idempotency key reused", "IDEMPOTENCY_KEY_REUSED")


def _normalize_project_path(project_code: str) -> str:
    try:
        return project_code_identity(normalize_project_code(project_code))
    except (TypeError, UnicodeError, ValueError):
        raise _invalid_payload("Invalid project code") from None


def _active_project(connection: sqlite3.Connection, project_key: str) -> sqlite3.Row:
    project = connection.execute(
        "SELECT id, status FROM projects WHERE project_code_key = ?",
        (project_key,),
    ).fetchone()
    if project is None:
        raise _not_found("Project not found")
    if project["status"] != "active":
        raise _business_conflict("Project is archived", "PROJECT_ARCHIVED")
    return project


def _parse_identifier(value: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise _invalid_payload("Invalid identifier")
    return _positive_integer(int(value), "Invalid identifier")


def _line_value(unit_cost_cents: int, quantity_milli: int) -> int:
    return int(
        (Decimal(unit_cost_cents) * Decimal(quantity_milli) / Decimal(1000)).quantize(
            Decimal(1),
            rounding=ROUND_HALF_UP,
        )
    )


def _round_ratio(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise sqlite3.DatabaseError("cost allocation denominator must be positive")
    return (numerator * 2 + denominator) // (denominator * 2)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _last_insert_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise sqlite3.DatabaseError("insert did not return an identifier")
    return cursor.lastrowid


def _timestamp(clock: Clock) -> str:
    value = clock()
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        is not None
    )


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


def _revision_conflict(current_revision: int) -> ApiError:
    return ApiError(
        status.HTTP_409_CONFLICT,
        "Resource was modified",
        "REVISION_CONFLICT",
        current_revision=current_revision,
        headers={
            "X-Error-Code": "REVISION_CONFLICT",
            "X-Current-Revision": str(current_revision),
        },
    )
