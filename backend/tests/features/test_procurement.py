from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity
from backend.app.features import procurement

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 29, 1, 30, tzinfo=timezone.utc)


@dataclass(frozen=True)
class ProcurementHarness:
    app: FastAPI
    database_path: Path
    settings: Settings
    project_code: str
    supplier_company_id: int

    @contextmanager
    def client(self) -> Iterator[TestClient]:
        with TestClient(self.app) as client:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
            yield client


def test_procurement_router_factory_exists() -> None:
    assert callable(procurement.create_procurement_router)


def _build_harness(tmp_path: Path) -> ProcurementHarness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        customer_id = _insert_company(connection, "客户公司")
        supplier_id = _insert_company(connection, "供应商公司")
        _insert_project(connection, customer_id, "P-2026-001")
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
        session_secret="procurement-test-session-secret-32-bytes",
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
        procurement.create_procurement_router(
            get_connection,
            get_settings,
            clock=lambda: NOW,
        )
    )
    return ProcurementHarness(app, database_path, settings, "P-2026-001", supplier_id)


def _insert_company(connection: sqlite3.Connection, name: str) -> int:
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


def _insert_project(
    connection: sqlite3.Connection,
    company_id: int,
    project_code: str,
) -> None:
    connection.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
        """,
        (
            project_code,
            project_code_identity(project_code),
            company_id,
            "测试项目",
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    )


def _line_payload(*, quantity: str = "5.000") -> dict[str, object]:
    return {
        "sequence_no": 1,
        "category": "电气",
        "name": "接触器",
        "specification": "AC220V",
        "brand": "施耐德",
        "model": "LC1D09",
        "quantity": quantity,
        "unit": "PCS",
        "unit_cost_cents": 1000,
        "quoted_unit_price_cents": 1500,
    }


def _create_confirmed_list(client: TestClient, project_code: str) -> dict[str, object]:
    created = client.post(
        f"/api/projects/{project_code}/procurement-lists",
        headers={"Idempotency-Key": "10000000-0000-4000-8000-000000000001"},
        json={"name": "第一版采购清单", "notes": None},
    )
    assert created.status_code == 201, created.text
    procurement_list = created.json()
    line = client.post(
        f"/api/projects/{project_code}/procurement-lists/{procurement_list['id']}/lines",
        headers={"Idempotency-Key": "10000000-0000-4000-8000-000000000002"},
        json=_line_payload(),
    )
    assert line.status_code == 201, line.text
    confirmed = client.post(
        f"/api/projects/{project_code}/procurement-lists/{procurement_list['id']}/confirm",
        headers={"Idempotency-Key": "10000000-0000-4000-8000-000000000003"},
        json={"expected_revision": line.json()["list_revision"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def test_template_download_is_authenticated_and_contains_frozen_headers(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with TestClient(harness.app) as anonymous:
        assert anonymous.get("/api/procurement/import-template.xlsx").status_code == 401

    with harness.client() as client:
        response = client.get("/api/procurement/import-template.xlsx")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    workbook = load_workbook(BytesIO(response.content), read_only=True)
    worksheet = workbook.active
    assert [cell.value for cell in worksheet[1]] == [
        "序号",
        "大类",
        "名称",
        "规格",
        "品牌",
        "型号",
        "数量",
        "单位",
        "成本单价（元）",
        "报价单价（元）",
    ]


def test_procurement_list_draft_crud_confirmation_and_revision_conflict(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        create_headers = {"Idempotency-Key": "20000000-0000-4000-8000-000000000001"}
        first = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists",
            headers=create_headers,
            json={"name": "采购清单", "notes": "初稿"},
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists",
            headers=create_headers,
            json={"name": "采购清单", "notes": "初稿"},
        )
        assert first.status_code == replay.status_code == 201
        assert first.json()["id"] == replay.json()["id"]

        listing = client.get(f"/api/projects/{harness.project_code}/procurement-lists")
        assert listing.json()["total"] == 1
        assert listing.json()["items"][0]["status"] == "draft"

        procurement_list = first.json()
        line = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/lines",
            headers={"Idempotency-Key": "20000000-0000-4000-8000-000000000002"},
            json=_line_payload(),
        )
        assert line.status_code == 201
        assert line.json()["quantity"] == "5.000"
        assert line.json()["order_status"] == "not_ordered"

        stale = client.put(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/lines/{line.json()['id']}",
            json={**_line_payload(quantity="6.000"), "expected_revision": 99},
        )
        assert stale.status_code == 409
        assert stale.json() == {
            "detail": "Resource was modified",
            "error_code": "REVISION_CONFLICT",
            "field_errors": {},
            "current_revision": line.json()["revision"],
        }
        assert stale.headers["x-error-code"] == "REVISION_CONFLICT"
        assert stale.headers["x-current-revision"] == str(line.json()["revision"])

        updated = client.put(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/lines/{line.json()['id']}",
            json={
                **_line_payload(quantity="6.000"),
                "expected_revision": line.json()["revision"],
            },
        )
        assert updated.status_code == 200
        assert updated.json()["quantity"] == "6.000"

        confirmed = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/confirm",
            headers={"Idempotency-Key": "20000000-0000-4000-8000-000000000003"},
            json={"expected_revision": updated.json()["list_revision"]},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "confirmed"

        replay_after_confirmation = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists",
            headers=create_headers,
            json={"name": "采购清单", "notes": "初稿"},
        )
        assert replay_after_confirmation.status_code == 201
        assert replay_after_confirmation.json() == first.json()

        immutable = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/lines",
            headers={"Idempotency-Key": "20000000-0000-4000-8000-000000000004"},
            json={**_line_payload(), "sequence_no": 2},
        )
        assert immutable.status_code == 409
        assert immutable.json()["detail"] == "Procurement list is not editable"


def test_purchase_order_confirmation_drives_order_status_and_overview(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        procurement_list = _create_confirmed_list(client, harness.project_code)
        line = procurement_list["lines"][0]
        create_headers = {"Idempotency-Key": "30000000-0000-4000-8000-000000000001"}
        create_payload = {
            "order_no": "PO-001",
            "supplier_company_id": harness.supplier_company_id,
            "ordered_on": "2026-08-29",
            "expected_delivery_on": "2026-09-05",
            "lines": [
                {
                    "procurement_line_id": line["id"],
                    "quantity": "5.000",
                    "unit_cost_cents": 1000,
                    "overage_reason": None,
                }
            ],
            "notes": None,
            "document_version_ids": [],
        }
        created = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers=create_headers,
            json=create_payload,
        )
        assert created.status_code == 201, created.text
        assert created.json()["status"] == "draft"
        assert created.json()["ordered_amount_cents"] == 5000

        confirmed = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{created.json()['id']}/confirm",
            headers={"Idempotency-Key": "30000000-0000-4000-8000-000000000002"},
            json={"expected_revision": created.json()["revision"]},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["status"] == "confirmed"

        replay_after_confirmation = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers=create_headers,
            json=create_payload,
        )
        assert replay_after_confirmation.status_code == 201
        assert replay_after_confirmation.json() == created.json()

        detail = client.get(
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}"
        )
        assert detail.json()["lines"][0]["order_status"] == "ordered"
        overview = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        )
        assert overview.status_code == 200
        assert overview.json()["procurement_committed_cents"] == 5000
        assert overview.json()["line_status_counts"]["ordered"] == 1


def test_archived_project_does_not_block_successful_procurement_replays(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    line_headers = {"Idempotency-Key": "35000000-0000-4000-8000-000000000001"}
    list_confirm_headers = {"Idempotency-Key": "35000000-0000-4000-8000-000000000002"}
    order_confirm_headers = {"Idempotency-Key": "35000000-0000-4000-8000-000000000003"}

    with harness.client() as client:
        procurement_list = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists",
            headers={"Idempotency-Key": "35000000-0000-4000-8000-000000000004"},
            json={"name": "归档重放清单", "notes": None},
        ).json()
        line_path = (
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/lines"
        )
        line_payload = _line_payload()
        created_line = client.post(
            line_path,
            headers=line_headers,
            json=line_payload,
        )
        assert created_line.status_code == 201

        list_confirm_path = (
            f"/api/projects/{harness.project_code}/procurement-lists/"
            f"{procurement_list['id']}/confirm"
        )
        confirmed_list = client.post(
            list_confirm_path,
            headers=list_confirm_headers,
            json={"expected_revision": created_line.json()["list_revision"]},
        )
        assert confirmed_list.status_code == 200

        order = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers={"Idempotency-Key": "35000000-0000-4000-8000-000000000005"},
            json={
                "order_no": "PO-ARCHIVE-REPLAY",
                "supplier_company_id": harness.supplier_company_id,
                "ordered_on": "2026-08-29",
                "expected_delivery_on": None,
                "lines": [
                    {
                        "procurement_line_id": created_line.json()["id"],
                        "quantity": "5.000",
                        "unit_cost_cents": 1000,
                        "overage_reason": None,
                    }
                ],
                "notes": None,
                "document_version_ids": [],
            },
        )
        assert order.status_code == 201
        order_confirm_path = (
            f"/api/projects/{harness.project_code}/purchase-orders/"
            f"{order.json()['id']}/confirm"
        )
        confirmed_order = client.post(
            order_confirm_path,
            headers=order_confirm_headers,
            json={"expected_revision": order.json()["revision"]},
        )
        assert confirmed_order.status_code == 200

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

        line_replay = client.post(line_path, headers=line_headers, json=line_payload)
        list_confirm_replay = client.post(
            list_confirm_path,
            headers=list_confirm_headers,
            json={"expected_revision": created_line.json()["list_revision"]},
        )
        order_confirm_replay = client.post(
            order_confirm_path,
            headers=order_confirm_headers,
            json={"expected_revision": order.json()["revision"]},
        )

    assert line_replay.status_code == 201
    assert line_replay.json() == created_line.json()
    assert list_confirm_replay.status_code == 200
    assert list_confirm_replay.json() == confirmed_list.json()
    assert order_confirm_replay.status_code == 200
    assert order_confirm_replay.json() == confirmed_order.json()
