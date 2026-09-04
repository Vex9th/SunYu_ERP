from __future__ import annotations

import importlib.util
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.features.dashboards import create_dashboards_router
from backend.app.features.projects import create_projects_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 31, 4, 0, tzinfo=timezone.utc)
TODAY = "2026-08-31"


def test_dashboards_router_module_exists() -> None:
    assert importlib.util.find_spec("backend.app.features.dashboards") is not None


@dataclass(frozen=True)
class DashboardHarness:
    app: FastAPI
    database_path: Path
    settings: Settings

    def client(
        self,
        *,
        authenticated: bool = True,
        raise_server_exceptions: bool = True,
    ) -> TestClient:
        client = TestClient(
            self.app,
            raise_server_exceptions=raise_server_exceptions,
        )
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


def _build_harness(
    tmp_path: Path,
    *,
    execute_failure: tuple[str, sqlite3.Error] | None = None,
    inject_cost_during_read: bool = False,
) -> DashboardHarness:
    tmp_path.mkdir(parents=True, exist_ok=True)
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
    finally:
        connection.close()

    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        backup_dir=backup_dir,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="test-session-secret-with-at-least-32-bytes",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        owned = connect_database(database_path)
        exposed: sqlite3.Connection
        if execute_failure is not None:
            exposed = cast(
                sqlite3.Connection,
                _ExecuteFailingConnection(owned, *execute_failure),
            )
        elif inject_cost_during_read:
            exposed = cast(
                sqlite3.Connection,
                _CostRaceConnection(owned, database_path),
            )
        else:
            exposed = owned
        try:
            yield exposed
        finally:
            owned.close()

    def get_settings() -> Settings:
        return settings

    app = FastAPI()
    app.include_router(
        create_projects_router(get_connection, get_settings, clock=lambda: NOW)
    )
    app.include_router(
        create_dashboards_router(get_connection, get_settings, clock=lambda: NOW)
    )
    return DashboardHarness(app, database_path, settings)


@pytest.fixture
def harness(tmp_path: Path) -> DashboardHarness:
    return _build_harness(tmp_path)


def _insert_company(connection: sqlite3.Connection, name: str) -> int:
    cursor = connection.execute(
        """
        INSERT INTO companies (name, created_at, updated_at)
        VALUES (?, ?, ?)
        """,
        (name, NOW.isoformat(), NOW.isoformat()),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def _insert_project(
    connection: sqlite3.Connection,
    company_id: int,
    code: str,
    *,
    status: str = "active",
) -> int:
    archived_at = None if status == "active" else NOW.isoformat()
    archive_reason = None if status == "active" else "已结束"
    cursor = connection.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description,
             status, archive_reason, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            code,
            code.casefold(),
            company_id,
            f"项目 {code}",
            "仪表台测试项目",
            status,
            archive_reason,
            archived_at,
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def _insert_contract(
    connection: sqlite3.Connection,
    project_id: int,
    customer_company_id: int,
    *,
    contract_no: str,
    status: str,
    allocation_cents: int,
    final_delivery_on: str,
) -> tuple[int, int]:
    signed_on = "2026-08-01" if status in {"signed", "completed"} else None
    cursor = connection.execute(
        """
        INSERT INTO contracts
            (contract_no, title, customer_company_id, status, signed_on,
             total_amount_cents, final_delivery_on, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (
            contract_no,
            f"合同 {contract_no}",
            customer_company_id,
            status,
            signed_on,
            allocation_cents,
            final_delivery_on,
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    )
    assert cursor.lastrowid is not None
    contract_id = cursor.lastrowid
    allocation = connection.execute(
        """
        INSERT INTO contract_project_allocations
            (contract_id, project_id, amount_cents)
        VALUES (?, ?, ?)
        """,
        (contract_id, project_id, allocation_cents),
    )
    assert allocation.lastrowid is not None
    return contract_id, allocation.lastrowid


def _insert_actual_costs(connection: sqlite3.Connection, project_id: int) -> None:
    connection.execute(
        """
        INSERT INTO inventory_issues
            (project_id, issued_on, status, total_cost_cents, revision,
             idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, 'active', 1000, 1, 'issue-active', 'hash', ?, ?)
        """,
        (project_id, TODAY, NOW.isoformat(), NOW.isoformat()),
    )
    connection.execute(
        """
        INSERT INTO inventory_issues
            (project_id, issued_on, status, total_cost_cents, revision,
             idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, 'reversed', 9000, 1, 'issue-reversed', 'hash', ?, ?)
        """,
        (project_id, TODAY, NOW.isoformat(), NOW.isoformat()),
    )
    worker = connection.execute(
        """
        INSERT INTO workers (name, status, revision, created_at, updated_at)
        VALUES ('施工员', 'active', 1, ?, ?)
        """,
        (NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert worker is not None
    assignment = connection.execute(
        """
        INSERT INTO crew_assignments
            (project_id, worker_id, role, scheduled_start_on, pay_basis,
             rate_cents, status, revision, created_at, updated_at)
        VALUES (?, ?, '电工', ?, 'daily', 2000, 'active', 1, ?, ?)
        """,
        (project_id, worker, TODAY, NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert assignment is not None
    for work_date, entry_status, cost in (
        (TODAY, "active", 2000),
        ("2026-08-30", "voided", 9000),
    ):
        connection.execute(
            """
            INSERT INTO labor_entries
                (project_id, assignment_id, worker_id, work_date,
                 attendance_status, day_fraction_milli, pay_basis, rate_cents,
                 cost_cents, status, void_reason, voided_at, revision,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, 'present', 1000, 'daily', ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                project_id,
                assignment,
                worker,
                work_date,
                cost,
                cost,
                entry_status,
                None if entry_status == "active" else "作废",
                None if entry_status == "active" else NOW.isoformat(),
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    for advance_status, amount in (("active", 3000), ("voided", 9000)):
        connection.execute(
            """
            INSERT INTO material_advances
                (project_id, worker_id, spent_on, total_amount_cents, status,
                 void_reason, voided_at, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                project_id,
                worker,
                TODAY,
                amount,
                advance_status,
                None if advance_status == "active" else "作废",
                None if advance_status == "active" else NOW.isoformat(),
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )


def _insert_procurement_cash_flow(
    connection: sqlite3.Connection,
    project_id: int,
    supplier_company_id: int,
) -> None:
    item = connection.execute(
        """
        INSERT INTO inventory_items
            (name, unit, quantity_milli, inventory_value_cents, revision,
             create_idempotency_key, create_request_hash, created_at, updated_at)
        VALUES ('电机', '台', 1000, 600, 1, 'item-key', 'hash', ?, ?)
        """,
        (NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert item is not None
    procurement_list = connection.execute(
        """
        INSERT INTO procurement_lists
            (project_id, name, status, revision, create_idempotency_key,
             create_request_hash, confirm_idempotency_key,
             confirm_request_hash, confirmed_at, created_at, updated_at)
        VALUES (?, '正式清单', 'confirmed', 1, 'list-key', 'hash',
                'list-confirm-key', 'hash', ?, ?, ?)
        """,
        (project_id, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert procurement_list is not None
    procurement_line = connection.execute(
        """
        INSERT INTO procurement_lines
            (procurement_list_id, inventory_item_id, sequence_no, category,
             name, quantity_milli, unit, unit_cost_cents,
             quoted_unit_price_cents, revision, create_idempotency_key,
             create_request_hash, created_at, updated_at)
        VALUES (?, ?, 1, '驱动', '电机', 1500, '台', 1000, 1200,
                1, 'line-key', 'hash', ?, ?)
        """,
        (procurement_list, item, NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert procurement_line is not None
    order = connection.execute(
        """
        INSERT INTO purchase_orders
            (project_id, order_no, supplier_company_id, ordered_on, status,
             revision, create_idempotency_key, create_request_hash,
             confirm_idempotency_key, confirm_request_hash, confirmed_at,
             created_at, updated_at)
        VALUES (?, 'PO-A', ?, ?, 'confirmed', 1, 'order-key', 'hash',
                'order-confirm-key', 'hash', ?, ?, ?)
        """,
        (
            project_id,
            supplier_company_id,
            TODAY,
            NOW.isoformat(),
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    ).lastrowid
    assert order is not None
    order_line = connection.execute(
        """
        INSERT INTO purchase_order_lines
            (purchase_order_id, procurement_line_id, quantity_milli,
             received_quantity_milli, unit_cost_cents, created_at)
        VALUES (?, ?, 1500, 1000, 1000, ?)
        """,
        (order, procurement_line, NOW.isoformat()),
    ).lastrowid
    assert order_line is not None
    receipt = connection.execute(
        """
        INSERT INTO goods_receipts
            (purchase_order_id, received_on, warehouse_name, status, revision,
             idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, '主仓', 'active', 1, 'receipt-key', 'hash', ?, ?)
        """,
        (order, TODAY, NOW.isoformat(), NOW.isoformat()),
    ).lastrowid
    assert receipt is not None
    movement = connection.execute(
        """
        INSERT INTO inventory_movements
            (inventory_item_id, movement_type, quantity_delta_milli,
             value_delta_cents, quantity_after_milli, value_after_cents,
             source_type, source_id, occurred_on, created_at)
        VALUES (?, 'goods_receipt', 1000, 600, 1000, 600,
                'goods_receipt', ?, ?, ?)
        """,
        (item, receipt, TODAY, NOW.isoformat()),
    ).lastrowid
    assert movement is not None
    connection.execute(
        """
        INSERT INTO goods_receipt_lines
            (goods_receipt_id, purchase_order_line_id, inventory_item_id,
             quantity_milli, value_cents, movement_id)
        VALUES (?, ?, ?, 1000, 600, ?)
        """,
        (receipt, order_line, item, movement),
    )
    connection.execute(
        """
        INSERT INTO supplier_payments
            (purchase_order_id, paid_on, amount_cents, payment_method, status,
             revision, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, 500, 'bank_transfer', 'active', 1,
                'payment-key', 'hash', ?, ?)
        """,
        (order, TODAY, NOW.isoformat(), NOW.isoformat()),
    )
    connection.execute(
        """
        INSERT INTO supplier_payments
            (purchase_order_id, paid_on, amount_cents, payment_method, status,
             revision, idempotency_key, request_hash, created_at, updated_at)
        VALUES (?, ?, 9000, 'bank_transfer', 'reversed', 1,
                'payment-reversed-key', 'hash', ?, ?)
        """,
        (order, TODAY, NOW.isoformat(), NOW.isoformat()),
    )


def _seed_operating_data(harness: DashboardHarness) -> dict[str, int]:
    connection = connect_database(harness.database_path)
    try:
        customer_id = _insert_company(connection, "客户公司")
        supplier_id = _insert_company(connection, "供应商")
        project_id = _insert_project(connection, customer_id, "P-A")
        other_project_id = _insert_project(connection, customer_id, "P-B")
        future_project_id = _insert_project(connection, customer_id, "P-C")
        _insert_project(connection, customer_id, "P-CLOSED", status="archived")
        connection.execute(
            """
            UPDATE project_stages
            SET status = 'in_progress', started_at = ?, revision = 2,
                updated_at = ?
            WHERE project_id = ? AND stage_code = 'mechanical_design'
            """,
            (NOW.isoformat(), NOW.isoformat(), project_id),
        )
        connection.execute(
            """
            UPDATE project_stages
            SET status = 'blocked', status_reason = '等待接口确认',
                started_at = ?, blocked_at = ?, planned_end_on = '2026-09-05',
                revision = 2, updated_at = ?
            WHERE project_id = ? AND stage_code = 'electrical_design'
            """,
            (NOW.isoformat(), NOW.isoformat(), NOW.isoformat(), project_id),
        )
        connection.execute(
            """
            INSERT INTO quotes
                (project_id, version_number, status, quote_date, amount_cents,
                 revision, created_at, updated_at)
            VALUES (?, 1, 'accepted', '2026-08-01', 15000, 1, ?, ?)
            """,
            (project_id, NOW.isoformat(), NOW.isoformat()),
        )
        _, allocation_id = _insert_contract(
            connection,
            project_id,
            customer_id,
            contract_no="C-A",
            status="signed",
            allocation_cents=12000,
            final_delivery_on="2026-09-30",
        )
        _insert_contract(
            connection,
            project_id,
            customer_id,
            contract_no="C-TERMINATED",
            status="terminated",
            allocation_cents=99000,
            final_delivery_on="2026-09-01",
        )
        _insert_contract(
            connection,
            future_project_id,
            customer_id,
            contract_no="C-FUTURE",
            status="signed",
            allocation_cents=5000,
            final_delivery_on="2026-10-01",
        )
        for milestone, due_on, amount in (
            ("advance", "2026-08-30", 10000),
            ("progress", "2026-09-20", 2000),
        ):
            connection.execute(
                """
                INSERT INTO payment_terms
                    (project_id, milestone, due_on, planned_amount_cents,
                     revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    project_id,
                    milestone,
                    due_on,
                    amount,
                    NOW.isoformat(),
                    NOW.isoformat(),
                ),
            )
        for allocation, receipt_status, amount, key in (
            (allocation_id, "active", 4000, "allocated"),
            (None, "active", 1000, "unallocated"),
            (allocation_id, "voided", 9000, "voided"),
        ):
            connection.execute(
                """
                INSERT INTO receipts
                    (project_id, contract_allocation_id, milestone, received_on,
                     amount_cents, payment_method, status, voided_on,
                     void_reason, revision, created_at, updated_at)
                VALUES (?, ?, 'advance', ?, ?, 'bank_transfer', ?, ?, ?, 1, ?, ?)
                """,
                (
                    project_id,
                    allocation,
                    "2026-08-29",
                    amount,
                    receipt_status,
                    None if receipt_status == "active" else "2026-08-30",
                    None if receipt_status == "active" else "错误到账",
                    f"{NOW.isoformat()}-{key}",
                    f"{NOW.isoformat()}-{key}",
                ),
            )
        _insert_actual_costs(connection, project_id)
        _insert_procurement_cash_flow(connection, project_id, supplier_id)
        connection.execute(
            """
            INSERT INTO inventory_issues
                (project_id, issued_on, status, total_cost_cents, revision,
                 idempotency_key, request_hash, created_at, updated_at)
            VALUES (?, ?, 'active', 70000, 1, 'other-project-cost', 'hash', ?, ?)
            """,
            (other_project_id, TODAY, NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO backup_runs
                (started_at, finished_at, status, target_path)
            VALUES (?, ?, 'success', ?)
            """,
            (
                (NOW - timedelta(hours=1, minutes=5)).isoformat(),
                (NOW - timedelta(hours=1)).isoformat(),
                str(harness.settings.backup_dir / "2026-08-31_030000"),
            ),
        )
        return {
            "project_id": project_id,
            "other_project_id": other_project_id,
            "future_project_id": future_project_id,
        }
    finally:
        connection.close()


def test_project_dashboard_returns_frozen_operating_types_and_real_costs(
    harness: DashboardHarness,
) -> None:
    _seed_operating_data(harness)

    with harness.client() as client:
        response = client.get("/api/projects/p-a/dashboard")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "project",
        "company",
        "contacts",
        "documents",
        "stages",
        "commercial",
        "costs",
        "profit",
        "receivables",
        "todos",
        "completion_check",
    }
    assert body["project"]["project_code"] == "P-A"
    assert body["project"]["company_name"] == "客户公司"
    assert body["project"]["closure_type"] is None
    assert body["project"]["revision"] == 1
    assert len(body["stages"]) == 18
    assert all("sequence" not in stage for stage in body["stages"])
    assert body["commercial"]["accepted_quote"]["amount_cents"] == 15000
    assert {contract["status"] for contract in body["commercial"]["contracts"]} == {
        "signed",
        "terminated",
    }
    assert body["costs"] == {
        "material_consumed_cents": 1000,
        "labor_cents": 2000,
        "field_material_cents": 3000,
        "total_cents": 6000,
        "procurement_committed_cents": 1500,
        "procurement_received_cents": 600,
        "procurement_paid_cents": 500,
        "completeness": "complete",
    }
    assert body["profit"] == {
        "contracted_amount_cents": 12000,
        "actual_cost_cents": 6000,
        "actual_profit_cents": 6000,
        "margin_basis_points": 5000,
    }
    receivables = body["receivables"]
    assert receivables["contracted_amount_cents"] == 12000
    assert receivables["receivable_amount_cents"] == 12000
    assert receivables["received_amount_cents"] == 5000
    assert receivables["allocated_received_amount_cents"] == 4000
    assert receivables["unallocated_received_amount_cents"] == 1000
    assert receivables["outstanding_receivable_cents"] == 7000
    assert receivables["contract_collection_basis_points"] == 3333
    assert len(receivables["terms"]) == 3
    assert len(receivables["receipts"]) == 3
    assert body["completion_check"] == {
        "stages_ready": False,
        "final_acceptance_ready": False,
        "receivables_ready": False,
        "ready": False,
        "blockers": [
            "PROJECT_STAGES_INCOMPLETE",
            "FINAL_ACCEPTANCE_NOT_PASSED",
            "RECEIVABLES_OUTSTANDING",
        ],
    }
    assert {todo["code"] for todo in body["todos"]} == {
        "STAGE_BLOCKED",
        "RECEIVABLE_OVERDUE",
        "DELIVERY_UPCOMING",
    }
    assert "70000" not in response.text


def test_global_dashboard_aggregates_active_projects_date_boundaries_and_backup(
    harness: DashboardHarness,
) -> None:
    _seed_operating_data(harness)

    with harness.client() as client:
        response = client.get("/api/dashboard")

    assert response.status_code == 200
    body = response.json()
    assert body["generated_at"] == NOW.isoformat()
    assert body["summary"] == {
        "active_project_count": 3,
        "overdue_receivable_count": 1,
        "upcoming_delivery_count": 1,
        "contracted_amount_cents": 17000,
        "received_amount_cents": 5000,
        "outstanding_receivable_cents": 7000,
    }
    assert [row["project"]["project_code"] for row in body["projects"]] == [
        "P-C",
        "P-B",
        "P-A",
    ]
    project_a = next(
        row for row in body["projects"] if row["project"]["project_code"] == "P-A"
    )
    project_b = next(
        row for row in body["projects"] if row["project"]["project_code"] == "P-B"
    )
    assert project_a["current_stage"]["stage_code"] == "mechanical_design"
    assert project_a["final_delivery_on"] == "2026-09-30"
    assert project_a["actual_profit_cents"] == 6000
    assert project_b["contracted_amount_cents"] == 0
    assert project_b["actual_profit_cents"] == -70000
    assert body["backup"] == {
        "healthy": True,
        "last_success_at": (NOW - timedelta(hours=1)).isoformat(),
        "message": None,
    }
    assert {todo["project_code"] for todo in body["todos"]} >= {"P-A"}
    assert all(todo["project_code"] != "P-CLOSED" for todo in body["todos"])


def test_global_dashboard_marks_failed_backup_unhealthy(
    harness: DashboardHarness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            INSERT INTO backup_runs
                (started_at, finished_at, status, target_path, error_message)
            VALUES (?, ?, 'failed', 'private-target', 'private-error')
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        response = client.get("/api/dashboard")

    assert response.status_code == 200
    assert response.json()["backup"] == {
        "healthy": False,
        "last_success_at": None,
        "message": "Last backup failed",
    }
    assert "private-target" not in response.text
    assert "private-error" not in response.text
    assert any(todo["code"] == "BACKUP_UNHEALTHY" for todo in response.json()["todos"])


def test_global_dashboard_uses_one_read_snapshot(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path, inject_cost_during_read=True)
    connection = connect_database(harness.database_path)
    try:
        company_id = _insert_company(connection, "客户公司")
        _insert_project(connection, company_id, "P-SNAPSHOT")
    finally:
        connection.close()

    with harness.client() as client:
        response = client.get("/api/dashboard")

    assert response.status_code == 200
    assert response.json()["projects"][0]["actual_profit_cents"] == 0
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute(
                "SELECT SUM(total_cost_cents) FROM inventory_issues"
            ).fetchone()[0]
            == 7000
        )
    finally:
        connection.close()


def test_dashboards_require_auth_and_use_structured_errors(tmp_path: Path) -> None:
    failing_harness = _build_harness(
        tmp_path / "failure",
        execute_failure=("FROM projects", sqlite3.OperationalError("private failure")),
    )
    clean_harness = _build_harness(tmp_path / "validation")
    with failing_harness.client(authenticated=False) as client:
        unauthenticated = client.get("/api/dashboard")
    with failing_harness.client(raise_server_exceptions=False) as client:
        failed = client.get("/api/dashboard")
    with clean_harness.client(raise_server_exceptions=False) as client:
        invalid_project = client.get("/api/projects/CON/dashboard")
        missing_project = client.get("/api/projects/MISSING/dashboard")

    assert unauthenticated.status_code == 401
    assert unauthenticated.json() == {"detail": "Authentication required"}
    assert failed.status_code == 500
    assert failed.json() == {
        "detail": "Dashboard operation failed",
        "error_code": "DASHBOARD_OPERATION_FAILED",
        "field_errors": {},
        "current_revision": None,
    }
    assert "private failure" not in failed.text
    assert invalid_project.status_code == 422
    assert invalid_project.json()["error_code"] == "VALIDATION_ERROR"
    assert missing_project.status_code == 404
    assert missing_project.json()["error_code"] == "RESOURCE_NOT_FOUND"


class _ExecuteFailingConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        marker: str,
        failure: sqlite3.Error,
    ) -> None:
        self._connection = connection
        self._marker = " ".join(marker.upper().split())
        self._failure = failure

    @property
    def in_transaction(self) -> bool:
        return self._connection.in_transaction

    def execute(
        self,
        sql: str,
        parameters: tuple[object, ...] = (),
    ) -> sqlite3.Cursor:
        normalized = " ".join(sql.upper().split())
        if self._marker in normalized:
            raise self._failure
        return self._connection.execute(sql, parameters)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()


class _CostRaceConnection:
    def __init__(self, connection: sqlite3.Connection, database_path: Path) -> None:
        self._connection = connection
        self._database_path = database_path
        self._injected = False

    @property
    def in_transaction(self) -> bool:
        return self._connection.in_transaction

    def execute(
        self,
        sql: str,
        parameters: tuple[object, ...] = (),
    ) -> sqlite3.Cursor:
        normalized = " ".join(sql.upper().split())
        if not self._injected and "FROM INVENTORY_ISSUES" in normalized:
            self._injected = True
            writer = connect_database(self._database_path)
            try:
                project_id = writer.execute(
                    "SELECT id FROM projects WHERE project_code = 'P-SNAPSHOT'"
                ).fetchone()[0]
                writer.execute(
                    """
                    INSERT INTO inventory_issues
                        (project_id, issued_on, status, total_cost_cents, revision,
                         idempotency_key, request_hash, created_at, updated_at)
                    VALUES (?, ?, 'active', 7000, 1, 'race-cost', 'hash', ?, ?)
                    """,
                    (project_id, TODAY, NOW.isoformat(), NOW.isoformat()),
                )
            finally:
                writer.close()
        return self._connection.execute(sql, parameters)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()
