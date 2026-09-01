from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity
from backend.app.features.inventory import create_inventory_router
from backend.app.features.procurement import create_procurement_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 29, 1, 30, tzinfo=timezone.utc)


@dataclass(frozen=True)
class IntegrationHarness:
    app: FastAPI
    database_path: Path
    settings: Settings
    project_code: str
    supplier_id: int

    @contextmanager
    def client(self) -> Iterator[TestClient]:
        with TestClient(self.app) as client:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
            yield client


def _build_harness(tmp_path: Path) -> IntegrationHarness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        customer = _company(connection, "客户")
        supplier = _company(connection, "供应商")
        project_code = "P-2026-001"
        connection.execute(
            """
            INSERT INTO projects
                (project_code, project_code_key, company_id, name, description,
                 created_at, updated_at)
            VALUES (?, ?, ?, '测试项目', NULL, ?, ?)
            """,
            (
                project_code,
                project_code_identity(project_code),
                customer,
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()
    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="integration-test-session-secret-32-bytes",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        owned = connect_database(database_path)
        try:
            yield owned
        finally:
            owned.close()

    def get_settings() -> Settings:
        return settings

    app = FastAPI()
    app.include_router(
        create_procurement_router(get_connection, get_settings, clock=lambda: NOW)
    )
    app.include_router(
        create_inventory_router(get_connection, get_settings, clock=lambda: NOW)
    )
    return IntegrationHarness(app, database_path, settings, project_code, supplier)


def _company(connection: sqlite3.Connection, name: str) -> int:
    cursor = connection.execute(
        """
        INSERT INTO companies
            (name, taxpayer_id, registered_address, registered_phone,
             bank_name, bank_account, notes, created_at, updated_at)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        """,
        (name, NOW.isoformat(), NOW.isoformat()),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def _prepare_order(
    client: TestClient, harness: IntegrationHarness
) -> dict[str, object]:
    procurement_list = client.post(
        f"/api/projects/{harness.project_code}/procurement-lists",
        headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000001"},
        json={"name": "采购清单", "notes": None},
    ).json()
    line = client.post(
        f"/api/projects/{harness.project_code}/procurement-lists/"
        f"{procurement_list['id']}/lines",
        headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000002"},
        json={
            "sequence_no": 1,
            "category": "电气",
            "name": "接触器",
            "specification": "AC220V",
            "brand": "施耐德",
            "model": "LC1D09",
            "quantity": "5.000",
            "unit": "PCS",
            "unit_cost_cents": 1000,
            "quoted_unit_price_cents": 1500,
        },
    ).json()
    confirmed_list = client.post(
        f"/api/projects/{harness.project_code}/procurement-lists/"
        f"{procurement_list['id']}/confirm",
        headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000003"},
        json={"expected_revision": line["list_revision"]},
    ).json()
    procurement_line = confirmed_list["lines"][0]
    order = client.post(
        f"/api/projects/{harness.project_code}/purchase-orders",
        headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000004"},
        json={
            "order_no": "PO-001",
            "supplier_company_id": harness.supplier_id,
            "ordered_on": "2026-08-29",
            "expected_delivery_on": None,
            "lines": [
                {
                    "procurement_line_id": procurement_line["id"],
                    "quantity": "5.000",
                    "unit_cost_cents": 1000,
                    "overage_reason": None,
                }
            ],
            "notes": None,
            "document_version_ids": [],
        },
    ).json()
    confirmed_order = client.post(
        f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/confirm",
        headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000005"},
        json={"expected_revision": order["revision"]},
    ).json()
    return {
        "list_id": procurement_list["id"],
        "procurement_line_id": procurement_line["id"],
        "order": confirmed_order,
    }


def test_receipt_adds_inventory_once_and_issue_records_actual_project_cost(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        prepared = _prepare_order(client, harness)
        order = prepared["order"]
        order_line = order["lines"][0]
        receipt_headers = {"Idempotency-Key": "70000000-0000-4000-8000-000000000001"}
        receipt_payload = {
            "received_on": "2026-08-29",
            "warehouse_name": "主仓",
            "lines": [
                {
                    "purchase_order_line_id": order_line["id"],
                    "quantity": "5.000",
                }
            ],
            "notes": None,
        }
        received = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order['id']}/goods-receipts",
            headers=receipt_headers,
            json=receipt_payload,
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order['id']}/goods-receipts",
            headers=receipt_headers,
            json=receipt_payload,
        )
        assert received.status_code == replay.status_code == 201
        assert received.json()["id"] == replay.json()["id"]
        inventory_item_id = received.json()["lines"][0]["inventory_item_id"]

        stock = client.get(f"/api/inventory/items/{inventory_item_id}")
        assert stock.json()["quantity"] == "5.000"
        assert stock.json()["inventory_value_cents"] == 5000

        over_receipt = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order['id']}/goods-receipts",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000002"},
            json=receipt_payload,
        )
        assert over_receipt.status_code == 409
        assert over_receipt.json()["detail"] == (
            "Receipt quantity exceeds ordered quantity"
        )

        overview_before_issue = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        ).json()
        assert overview_before_issue["procurement_received_cents"] == 5000
        assert overview_before_issue["material_consumed_cents"] == 0

        issue_headers = {"Idempotency-Key": "70000000-0000-4000-8000-000000000003"}
        issue_payload = {
            "issued_on": "2026-08-29",
            "worker_id": None,
            "lines": [
                {
                    "inventory_item_id": inventory_item_id,
                    "procurement_line_id": prepared["procurement_line_id"],
                    "quantity": "2.000",
                }
            ],
            "notes": "现场领用",
        }
        issue = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues",
            headers=issue_headers,
            json=issue_payload,
        )
        repeated_issue = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues",
            headers=issue_headers,
            json=issue_payload,
        )
        assert issue.status_code == repeated_issue.status_code == 201, issue.text
        assert issue.json()["id"] == repeated_issue.json()["id"]
        assert issue.json()["total_cost_cents"] == 2000
        stock_after = client.get(f"/api/inventory/items/{inventory_item_id}").json()
        assert stock_after["quantity"] == "3.000"
        assert stock_after["inventory_value_cents"] == 3000

        procurement_list = client.get(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{prepared['list_id']}"
        ).json()
        assert procurement_list["lines"][0]["usage_status"] == "partial"
        overview_after_issue = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        ).json()
        assert overview_after_issue["material_consumed_cents"] == 2000

        insufficient = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000004"},
            json={
                "issued_on": "2026-08-29",
                "worker_id": None,
                "lines": [
                    {
                        "inventory_item_id": inventory_item_id,
                        "procurement_line_id": prepared["procurement_line_id"],
                        "quantity": "4.000",
                    }
                ],
                "notes": None,
            },
        )
        assert insufficient.status_code == 409
        assert insufficient.json()["detail"] == "Insufficient inventory"
        unchanged = client.get(f"/api/inventory/items/{inventory_item_id}").json()
        assert unchanged["quantity"] == "3.000"

        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?,
                    archive_reason = '幂等重放测试'
                WHERE project_code = ? COLLATE NOCASE
                """,
                (NOW.isoformat(), harness.project_code),
            )
        finally:
            connection.close()

        receipt_after_archive = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order['id']}/goods-receipts",
            headers=receipt_headers,
            json=receipt_payload,
        )
        issue_after_archive = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues",
            headers=issue_headers,
            json=issue_payload,
        )
        assert receipt_after_archive.status_code == 201
        assert receipt_after_archive.json() == received.json()
        assert issue_after_archive.status_code == 201
        assert issue_after_archive.json() == issue.json()


def test_inventory_issue_reversal_restores_frozen_cost_once_and_updates_usage(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        prepared = _prepare_order(client, harness)
        order = prepared["order"]
        receipt = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order['id']}/goods-receipts",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000001"},
            json={
                "received_on": "2026-08-29",
                "warehouse_name": "主仓",
                "lines": [{
                    "purchase_order_line_id": order["lines"][0]["id"],
                    "quantity": "5.000",
                }],
                "notes": None,
            },
        )
        assert receipt.status_code == 201, receipt.text
        inventory_item_id = receipt.json()["lines"][0]["inventory_item_id"]
        issue = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000002"},
            json={
                "issued_on": "2026-08-29",
                "worker_id": None,
                "lines": [{
                    "inventory_item_id": inventory_item_id,
                    "procurement_line_id": prepared["procurement_line_id"],
                    "quantity": "2.000",
                }],
                "notes": "现场领用",
            },
        )
        assert issue.status_code == 201, issue.text
        issue_body = issue.json()

        invalid = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000003"},
            json={"reason": "  ", "expected_revision": issue_body["revision"]},
        )
        assert invalid.status_code == 422
        assert invalid.json()["error_code"] == "VALIDATION_ERROR"

        stale = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000004"},
            json={"reason": "领用单录错项目", "expected_revision": 99},
        )
        assert stale.status_code == 409
        assert stale.json() == {
            "detail": "Resource was modified",
            "error_code": "REVISION_CONFLICT",
            "field_errors": {},
            "current_revision": issue_body["revision"],
        }

        reverse_headers = {
            "Idempotency-Key": "71000000-0000-4000-8000-000000000005"
        }
        reverse_payload = {
            "reason": "领用单录错项目",
            "expected_revision": issue_body["revision"],
        }
        reversed_issue = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        assert reversed_issue.status_code == replay.status_code == 200
        assert reversed_issue.json() == replay.json()
        assert reversed_issue.json() == {
            **issue_body,
            "status": "reversed",
            "revision": issue_body["revision"] + 1,
            "updated_at": NOW.isoformat(),
        }

        stock = client.get(f"/api/inventory/items/{inventory_item_id}").json()
        assert stock["quantity"] == "5.000"
        assert stock["inventory_value_cents"] == 5000
        movements = client.get(
            f"/api/inventory/items/{inventory_item_id}/movements"
        ).json()["items"]
        assert [movement["movement_type"] for movement in movements] == [
            "reversal",
            "project_issue",
            "goods_receipt",
        ]
        assert movements[0] == {
            **movements[0],
            "project_code": harness.project_code,
            "issue_status": "reversed",
            "issue_revision": issue_body["revision"] + 1,
            "quantity_delta": "2.000",
            "value_delta_cents": 2000,
            "quantity_after": "5.000",
            "value_after_cents": 5000,
            "source_type": "inventory_issue_reversal",
            "source_id": issue_body["id"],
            "reason": "领用单录错项目",
        }
        assert movements[1]["source_type"] == "inventory_issue"
        assert movements[1]["quantity_delta"] == "-2.000"

        procurement_list = client.get(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{prepared['list_id']}"
        ).json()
        assert procurement_list["lines"][0]["usage_status"] == "unused"
        overview = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        ).json()
        assert overview["material_consumed_cents"] == 0

        conflicting_replay = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers=reverse_headers,
            json={**reverse_payload, "reason": "不同原因"},
        )
        assert conflicting_replay.status_code == 409
        assert conflicting_replay.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"

        repeated = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/"
            f"{issue_body['id']}/reverse",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000006"},
            json={
                "reason": "重复冲销",
                "expected_revision": reversed_issue.json()["revision"],
            },
        )
        assert repeated.status_code == 409
        assert repeated.json()["error_code"] == "INVENTORY_ISSUE_ALREADY_REVERSED"
        assert client.get(
            f"/api/inventory/items/{inventory_item_id}/movements"
        ).json()["total"] == 3

        missing = client.post(
            f"/api/projects/{harness.project_code}/inventory-issues/999999/reverse",
            headers={"Idempotency-Key": "71000000-0000-4000-8000-000000000007"},
            json={"reason": "不存在", "expected_revision": 1},
        )
        assert missing.status_code == 404
