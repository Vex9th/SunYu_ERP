from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request, status

from backend.app.core.config import Settings
from backend.app.core.database import transaction
from backend.app.features import commercial, project_stages
from backend.app.features.api_common import ApiError, ApiErrorRoute
from backend.app.features.auth import require_authenticated_session

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
_UPCOMING_DELIVERY_DAYS = 30
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


def create_dashboards_router(
    get_connection: Callable[..., sqlite3.Connection],
    get_settings: Callable[..., Settings],
    *,
    clock: Clock | None = None,
) -> APIRouter:
    router = APIRouter(route_class=ApiErrorRoute, tags=["dashboards"])
    connection_dependency = Depends(get_connection)
    settings_dependency = Depends(get_settings)
    now = clock or _utc_now

    def require_session(
        request: Request,
        settings: Settings = settings_dependency,
    ) -> None:
        require_authenticated_session(request, settings.session_secret)

    authentication_dependency = Depends(require_session)

    @router.get("/api/dashboard")
    def get_global_dashboard(
        _: None = authentication_dependency,
        connection: sqlite3.Connection = connection_dependency,
        settings: Settings = settings_dependency,
    ) -> dict[str, object]:
        current_time = _aware_utc(now())
        today = commercial._business_today(lambda: current_time)
        try:
            with transaction(connection):
                return _global_dashboard(connection, settings, current_time, today)
        except sqlite3.Error as failure:
            raise _database_error(failure) from None

    return router


def _global_dashboard(
    connection: sqlite3.Connection,
    settings: Settings,
    current_time: datetime,
    today: str,
) -> dict[str, object]:
    project_rows: list[dict[str, object]] = []
    todos: list[dict[str, object]] = []
    summary = {
        "active_project_count": 0,
        "overdue_receivable_count": 0,
        "upcoming_delivery_count": 0,
        "contracted_amount_cents": 0,
        "received_amount_cents": 0,
        "outstanding_receivable_cents": 0,
    }
    for project in _active_projects(connection):
        operating = build_project_operating_snapshot(connection, project, today=today)
        final_delivery_on = _final_delivery_on(connection, int(project["id"]))
        project_rows.append(_global_project_row(project, operating, final_delivery_on))
        project_todos = operating["todos"]
        if not isinstance(project_todos, list):
            raise sqlite3.DatabaseError("project todos are invalid")
        todos.extend(project_todos)
        _accumulate_summary(summary, operating, final_delivery_on, today)
    summary["active_project_count"] = len(project_rows)
    backup = _backup_health(connection, settings, current_time)
    if backup["healthy"] is False:
        todos.append(_backup_todo(backup))
    return {
        "generated_at": current_time.isoformat(),
        "summary": summary,
        "projects": project_rows,
        "todos": _sorted_todos(todos),
        "backup": backup,
    }


def _global_project_row(
    project: sqlite3.Row,
    operating: dict[str, object],
    final_delivery_on: str | None,
) -> dict[str, object]:
    receivables = operating["receivables"]
    profit = operating["profit"]
    if not isinstance(receivables, dict) or not isinstance(profit, dict):
        raise sqlite3.DatabaseError("project operating summary is invalid")
    return {
        "project": _row_response(project, _PROJECT_DETAIL_FIELDS),
        "current_stage": _current_stage(operating["stages"]),
        "contracted_amount_cents": profit["contracted_amount_cents"],
        "received_amount_cents": receivables["received_amount_cents"],
        "outstanding_receivable_cents": receivables["outstanding_receivable_cents"],
        "final_delivery_on": final_delivery_on,
        "actual_profit_cents": profit["actual_profit_cents"],
    }


def _accumulate_summary(
    summary: dict[str, int],
    operating: dict[str, object],
    final_delivery_on: str | None,
    today: str,
) -> None:
    receivables = operating["receivables"]
    if not isinstance(receivables, dict):
        raise sqlite3.DatabaseError("receivables summary is invalid")
    summary["overdue_receivable_count"] += sum(
        1
        for term in receivables["terms"]
        if isinstance(term, dict) and term["is_overdue"] is True
    )
    summary["upcoming_delivery_count"] += int(_is_upcoming(final_delivery_on, today))
    for field in (
        "contracted_amount_cents",
        "received_amount_cents",
        "outstanding_receivable_cents",
    ):
        summary[field] += int(receivables[field])


def _backup_todo(backup: dict[str, object]) -> dict[str, object]:
    return {
        "code": "BACKUP_UNHEALTHY",
        "severity": "danger",
        "project_code": None,
        "due_on": None,
        "title": "Backup requires attention",
        "description": backup["message"],
    }


def build_project_operating_snapshot(
    connection: sqlite3.Connection,
    project: sqlite3.Row | dict[str, object],
    *,
    today: str,
) -> dict[str, object]:
    project_id = int(project["id"])
    project_code = str(project["project_code"])
    stages = project_stages._stage_list(connection, project_id)
    accepted_quote = connection.execute(
        """
        SELECT * FROM quotes
        WHERE project_id = ? AND status = 'accepted'
        ORDER BY version_number DESC, id DESC
        LIMIT 1
        """,
        (project_id,),
    ).fetchone()
    contract_rows = connection.execute(
        """
        SELECT contracts.*
        FROM contracts
        JOIN contract_project_allocations AS allocations
            ON allocations.contract_id = contracts.id
        WHERE allocations.project_id = ?
        ORDER BY contracts.created_at DESC, contracts.id DESC
        """,
        (project_id,),
    ).fetchall()
    receivables = commercial._payment_overview(
        connection,
        project,  # type: ignore[arg-type]
        today,
    )
    costs = _project_costs(connection, project_id)
    contracted_amount = int(receivables["contracted_amount_cents"])
    actual_cost = int(costs["total_cents"])
    actual_profit = contracted_amount - actual_cost
    final_delivery_on = _final_delivery_on(connection, project_id)
    todos = _project_todos(
        stages,
        receivables,
        project_code=project_code,
        final_delivery_on=final_delivery_on,
        today=today,
    )
    return {
        "stages": stages,
        "commercial": {
            "accepted_quote": (
                None
                if accepted_quote is None
                else commercial._quote_response(
                    connection, accepted_quote, project_code
                )
            ),
            "contracts": [
                commercial._contract_response(connection, row) for row in contract_rows
            ],
        },
        "costs": costs,
        "profit": {
            "contracted_amount_cents": contracted_amount,
            "actual_cost_cents": actual_cost,
            "actual_profit_cents": actual_profit,
            "margin_basis_points": commercial._basis_points(
                actual_profit,
                contracted_amount,
            ),
        },
        "receivables": receivables,
        "todos": todos,
    }


def _active_projects(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            projects.id, projects.project_code, projects.company_id,
            companies.name AS company_name, projects.name,
            projects.description, projects.status, projects.closure_type,
            projects.archive_reason, projects.archived_at, projects.revision,
            projects.created_at, projects.updated_at
        FROM projects
        JOIN companies ON companies.id = projects.company_id
        WHERE projects.status = 'active'
        ORDER BY projects.created_at DESC, projects.id DESC
        """
    ).fetchall()


def _project_costs(
    connection: sqlite3.Connection,
    project_id: int,
) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT
            (SELECT COALESCE(SUM(total_cost_cents), 0)
             FROM inventory_issues
             WHERE project_id = ? AND status = 'active') AS material_consumed,
            (SELECT COALESCE(SUM(cost_cents), 0)
             FROM labor_entries
             WHERE project_id = ? AND status = 'active') AS labor,
            (SELECT COALESCE(SUM(total_amount_cents), 0)
             FROM material_advances
             WHERE project_id = ? AND status = 'active') AS field_material,
            (SELECT COALESCE(SUM(
                (order_lines.unit_cost_cents * order_lines.quantity_milli + 500)
                / 1000
             ), 0)
             FROM purchase_order_lines AS order_lines
             JOIN purchase_orders AS orders
                 ON orders.id = order_lines.purchase_order_id
             WHERE orders.project_id = ?
               AND orders.status IN (
                   'confirmed', 'partially_received', 'received'
               )) AS committed,
            (SELECT COALESCE(SUM(receipt_lines.value_cents), 0)
             FROM goods_receipt_lines AS receipt_lines
             JOIN goods_receipts AS receipts
                 ON receipts.id = receipt_lines.goods_receipt_id
             JOIN purchase_orders AS orders
                 ON orders.id = receipts.purchase_order_id
             WHERE orders.project_id = ?
               AND receipts.status = 'active') AS received,
            (SELECT COALESCE(SUM(payments.amount_cents), 0)
             FROM supplier_payments AS payments
             JOIN purchase_orders AS orders
                 ON orders.id = payments.purchase_order_id
             WHERE orders.project_id = ?
               AND payments.status = 'active') AS paid
        """,
        (project_id,) * 6,
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("project cost query returned no row")
    material_consumed = int(row["material_consumed"])
    labor = int(row["labor"])
    field_material = int(row["field_material"])
    return {
        "material_consumed_cents": material_consumed,
        "labor_cents": labor,
        "field_material_cents": field_material,
        "total_cents": material_consumed + labor + field_material,
        "procurement_committed_cents": int(row["committed"]),
        "procurement_received_cents": int(row["received"]),
        "procurement_paid_cents": int(row["paid"]),
        "completeness": "complete",
    }


def _final_delivery_on(
    connection: sqlite3.Connection,
    project_id: int,
) -> str | None:
    row = connection.execute(
        """
        SELECT MIN(contracts.final_delivery_on)
        FROM contracts
        JOIN contract_project_allocations AS allocations
            ON allocations.contract_id = contracts.id
        WHERE allocations.project_id = ?
          AND contracts.status IN ('signed', 'completed')
          AND contracts.final_delivery_on IS NOT NULL
        """,
        (project_id,),
    ).fetchone()
    if row is None:
        raise sqlite3.DatabaseError("delivery date query returned no row")
    return None if row[0] is None else str(row[0])


def _project_todos(
    stages: object,
    receivables: dict[str, object],
    *,
    project_code: str,
    final_delivery_on: str | None,
    today: str,
) -> list[dict[str, object]]:
    if not isinstance(stages, list):
        raise sqlite3.DatabaseError("project stages are invalid")
    todos: list[dict[str, object]] = []
    blocked = [stage for stage in stages if stage["status"] == "blocked"]
    if blocked:
        due_dates = [
            str(stage["planned_end_on"]) for stage in blocked if stage["planned_end_on"]
        ]
        todos.append(
            {
                "code": "STAGE_BLOCKED",
                "severity": "danger",
                "project_code": project_code,
                "due_on": min(due_dates) if due_dates else None,
                "title": "Project stage is blocked",
                "description": ", ".join(str(stage["stage_code"]) for stage in blocked),
            }
        )
    overdue_terms = [
        term
        for term in receivables["terms"]
        if isinstance(term, dict) and term["is_overdue"] is True
    ]
    if overdue_terms:
        todos.append(
            {
                "code": "RECEIVABLE_OVERDUE",
                "severity": "danger",
                "project_code": project_code,
                "due_on": min(str(term["due_on"]) for term in overdue_terms),
                "title": "Receivable is overdue",
                "description": ", ".join(
                    str(term["milestone"]) for term in overdue_terms
                ),
            }
        )
    if _is_upcoming(final_delivery_on, today):
        todos.append(
            {
                "code": "DELIVERY_UPCOMING",
                "severity": "warning",
                "project_code": project_code,
                "due_on": final_delivery_on,
                "title": "Final delivery is upcoming",
                "description": None,
            }
        )
    return _sorted_todos(todos)


def _current_stage(stages: object) -> dict[str, object] | None:
    if not isinstance(stages, list):
        raise sqlite3.DatabaseError("project stages are invalid")
    for selected_status in ("in_progress", "blocked"):
        for stage in stages:
            if stage["status"] == selected_status:
                return stage
    return None


def _is_upcoming(value: str | None, today: str) -> bool:
    if value is None:
        return False
    start = date.fromisoformat(today)
    selected = date.fromisoformat(value)
    return start <= selected <= start + timedelta(days=_UPCOMING_DELIVERY_DAYS)


def _backup_health(
    connection: sqlite3.Connection,
    settings: Settings,
    now: datetime,
) -> dict[str, object]:
    latest = connection.execute(
        """
        SELECT status FROM backup_runs
        ORDER BY id DESC LIMIT 1
        """
    ).fetchone()
    success = connection.execute(
        """
        SELECT finished_at FROM backup_runs
        WHERE status = 'success' AND finished_at IS NOT NULL
        ORDER BY id DESC LIMIT 1
        """
    ).fetchone()
    last_success_at = None if success is None else str(success["finished_at"])
    if settings.backup_dir is None:
        return {
            "healthy": False,
            "last_success_at": last_success_at,
            "message": "Backup is not configured",
        }
    if latest is not None and latest["status"] == "failed":
        return {
            "healthy": False,
            "last_success_at": last_success_at,
            "message": "Last backup failed",
        }
    if success is None:
        return {
            "healthy": False,
            "last_success_at": None,
            "message": "No successful backup",
        }
    try:
        finished_at = _aware_utc(datetime.fromisoformat(last_success_at))
    except (TypeError, ValueError):
        return {
            "healthy": False,
            "last_success_at": last_success_at,
            "message": "Backup history is invalid",
        }
    if finished_at > now:
        return {
            "healthy": False,
            "last_success_at": last_success_at,
            "message": "Backup history is invalid",
        }
    if now >= finished_at + timedelta(hours=settings.backup_interval_hours):
        return {
            "healthy": False,
            "last_success_at": last_success_at,
            "message": "Last successful backup is overdue",
        }
    return {"healthy": True, "last_success_at": last_success_at, "message": None}


def _sorted_todos(todos: list[dict[str, object]]) -> list[dict[str, object]]:
    severity_order = {"danger": 0, "warning": 1, "info": 2}
    return sorted(
        todos,
        key=lambda todo: (
            severity_order[str(todo["severity"])],
            str(todo["due_on"] or "9999-12-31"),
            str(todo["project_code"] or ""),
            str(todo["code"]),
        ),
    )


def _row_response(
    row: sqlite3.Row,
    fields: tuple[str, ...],
) -> dict[str, object]:
    return {field: row[field] for field in fields}


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(timezone.utc)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _database_error(failure: sqlite3.Error) -> ApiError:
    logger.exception(
        "Dashboard database operation failed (sqlite_errorcode=%s, sqlite_errorname=%s)",
        getattr(failure, "sqlite_errorcode", None),
        getattr(failure, "sqlite_errorname", None),
    )
    return ApiError(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "Dashboard operation failed",
        "DASHBOARD_OPERATION_FAILED",
    )
