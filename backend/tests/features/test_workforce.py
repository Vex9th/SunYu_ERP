from __future__ import annotations

import importlib
import sqlite3
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import (
    SESSION_COOKIE_NAME,
    create_session_token,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 29, 2, 30, tzinfo=timezone.utc)


@dataclass
class WorkforceHarness:
    app: FastAPI
    database_path: Path
    settings: Settings

    def client(self, *, authenticated: bool = True) -> TestClient:
        client = TestClient(self.app)
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


def _idempotency_headers(key: str | None = None) -> dict[str, str]:
    return {"Idempotency-Key": key or str(uuid.uuid4())}


def _build_harness(tmp_path: Path) -> WorkforceHarness:
    workforce = importlib.import_module("backend.app.features.workforce")
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        connection.execute(
            """
            INSERT INTO companies (id, name, created_at, updated_at)
            VALUES (1, '测试客户', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 status, created_at, updated_at)
            VALUES (1, 'P-001', 'p-001', 1, '测试项目', 'active', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 status, archived_at, created_at, updated_at)
            VALUES (2, 'P-ARCHIVED', 'p-archived', 1, '归档项目', 'archived', ?, ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
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
        session_secret="test-session-secret-with-at-least-32-bytes",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(database_path)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(
        workforce.create_workforce_router(
            get_connection,
            lambda: settings,
            clock=lambda: NOW,
        )
    )
    return WorkforceHarness(app, database_path, settings)


@pytest.fixture
def harness(tmp_path: Path) -> WorkforceHarness:
    return _build_harness(tmp_path)


def _create_worker(
    client: TestClient,
    *,
    name: str = "张师傅",
    phone: str | None = "13800000000",
) -> dict[str, Any]:
    response = client.post(
        "/api/workers",
        headers=_idempotency_headers(),
        json={"name": name, "phone": phone, "notes": None},
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


def _create_assignment(
    client: TestClient,
    worker_id: int,
    *,
    project_code: str = "P-001",
    pay_basis: str = "daily",
    rate_cents: int = 60_000,
) -> dict[str, Any]:
    response = client.post(
        f"/api/projects/{project_code}/crew-assignments",
        headers=_idempotency_headers(),
        json={
            "worker_id": worker_id,
            "role": "施工员",
            "scheduled_start_on": "2026-08-29",
            "scheduled_end_on": "2026-09-05",
            "pay_basis": pay_basis,
            "rate_cents": rate_cents,
            "notes": None,
        },
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


def test_migration_creates_workforce_and_later_delivery_tables(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.sqlite3"
    connection = connect_database(database_path)
    try:
        applied = apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        unique_labor_keys = {
            tuple(
                column[2]
                for column in connection.execute(
                    f"PRAGMA index_info({index[1]})"
                ).fetchall()
            )
            for index in connection.execute(
                "PRAGMA index_list(labor_entries)"
            ).fetchall()
            if index[2]
        }
    finally:
        connection.close()

    assert "009_workforce_delivery" in applied
    assert {
        "workers",
        "crew_assignments",
        "labor_entries",
        "site_daily_reports",
        "material_advances",
        "material_advance_items",
        "advance_reimbursements",
        "drawing_signoffs",
        "commissioning_sessions",
        "engineering_changes",
        "acceptances",
        "warranties",
        "project_invoices",
        "after_sales_cases",
    } <= tables
    assert ("project_id", "worker_id", "work_date") in unique_labor_keys


def test_workers_support_create_get_update_search_and_pagination(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client, name="  张师傅  ", phone=" 13800000000 ")
        _create_worker(client, name="李师傅", phone=None)
        page = client.get("/api/workers?page=1&page_size=1&status=active&query=张")
        detail = client.get(f"/api/workers/{worker['id']}")
        updated = client.put(
            f"/api/workers/{worker['id']}",
            json={
                "name": "张工",
                "phone": "13900000000",
                "notes": "电气施工",
                "expected_revision": worker["revision"],
            },
        )

    assert worker["name"] == "张师傅"
    assert worker["status"] == "active"
    assert worker["revision"] == 1
    assert page.status_code == 200
    assert page.json()["total"] == 1
    assert [item["name"] for item in page.json()["items"]] == ["张师傅"]
    assert detail.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["name"] == "张工"
    assert updated.json()["revision"] == 2


def test_worker_rejects_unknown_fields_and_revision_conflicts(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        invalid = client.post(
            "/api/workers",
            headers=_idempotency_headers(),
            json={"name": "李师傅", "phone": None, "notes": None, "private": True},
        )
        conflict = client.put(
            f"/api/workers/{worker['id']}",
            json={
                "name": "错误覆盖",
                "phone": None,
                "notes": None,
                "expected_revision": 99,
            },
        )

    assert invalid.status_code == 422
    assert invalid.json()["error_code"] == "INVALID_WORKER_PAYLOAD"
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "REVISION_CONFLICT"
    assert conflict.json()["current_revision"] == 1


def test_deactivate_worker_preserves_assignment_history_and_is_idempotent(
    harness: WorkforceHarness,
) -> None:
    key = str(uuid.uuid4())
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        first = client.post(
            f"/api/workers/{worker['id']}/deactivate",
            headers=_idempotency_headers(key),
            json={
                "effective_on": "2026-08-30",
                "reason": "暂停接单",
                "expected_revision": worker["revision"],
            },
        )
        replay = client.post(
            f"/api/workers/{worker['id']}/deactivate",
            headers=_idempotency_headers(key),
            json={
                "effective_on": "2026-08-30",
                "reason": "暂停接单",
                "expected_revision": worker["revision"],
            },
        )
        assignments = client.get("/api/projects/P-001/crew-assignments")

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert first.json()["status"] == "inactive"
    assert first.json()["inactive_on"] == "2026-08-30"
    assert assignments.status_code == 200
    assert assignments.json()["items"][0]["id"] == assignment["id"]


def test_assignment_create_list_and_update_preserve_pay_rule(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        listed = client.get("/api/projects/p-001/crew-assignments?status=planned")
        updated = client.put(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}",
            json={
                "worker_id": worker["id"],
                "role": "电气施工",
                "scheduled_start_on": "2026-08-30",
                "scheduled_end_on": "2026-09-06",
                "pay_basis": "daily",
                "rate_cents": 65_000,
                "notes": "调整单价",
                "expected_revision": assignment["revision"],
            },
        )

    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["worker_name"] == "张师傅"
    assert updated.status_code == 200
    assert updated.json()["rate_cents"] == 65_000
    assert updated.json()["revision"] == 2


def test_archived_project_rejects_new_assignment_but_keeps_existing_records(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        response = client.post(
            "/api/projects/P-ARCHIVED/crew-assignments",
            headers=_idempotency_headers(),
            json={
                "worker_id": worker["id"],
                "role": "施工员",
                "scheduled_start_on": "2026-08-29",
                "scheduled_end_on": None,
                "pay_basis": "daily",
                "rate_cents": 60_000,
                "notes": None,
            },
        )

    assert response.status_code == 409
    assert response.json()["error_code"] == "PROJECT_ARCHIVED"


def test_archived_project_rejects_regular_assignment_update(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 1",
                (NOW.isoformat(),),
            )
        finally:
            connection.close()
        response = client.put(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}",
            json={
                "worker_id": worker["id"],
                "role": "不应修改",
                "scheduled_start_on": "2026-08-30",
                "scheduled_end_on": "2026-09-06",
                "pay_basis": "daily",
                "rate_cents": 1,
                "notes": None,
                "expected_revision": assignment["revision"],
            },
        )
        stored = client.get(
            "/api/projects/P-001/crew-assignments?status=planned"
        ).json()["items"][0]

    assert response.status_code == 409
    assert response.json()["error_code"] == "PROJECT_ARCHIVED"
    assert stored["role"] == assignment["role"]
    assert stored["rate_cents"] == assignment["rate_cents"]
    assert stored["revision"] == assignment["revision"]


def test_batch_saves_daily_and_hourly_costs_from_assignment_snapshots(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        daily_worker = _create_worker(client, name="日薪工")
        hourly_worker = _create_worker(client, name="时薪工")
        daily = _create_assignment(client, daily_worker["id"], rate_cents=60_001)
        hourly = _create_assignment(
            client,
            hourly_worker["id"],
            pay_basis="hourly",
            rate_cents=3_001,
        )
        saved = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": daily["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "机械安装",
                        "notes": None,
                        "expected_revision": None,
                    },
                    {
                        "assignment_id": hourly["id"],
                        "attendance_status": "present",
                        "day_fraction": None,
                        "work_minutes": 61,
                        "work_summary": "接线",
                        "notes": None,
                        "expected_revision": None,
                    },
                ],
            },
        )

    assert saved.status_code == 200
    items = saved.json()["items"]
    assert [item["cost_cents"] for item in items] == [30_001, 3_051]
    assert items[0]["rate_cents"] == 60_001
    assert items[1]["rate_cents"] == 3_001


def test_batch_updates_same_assignment_and_date_without_duplicate(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        payload = {
            "work_date": "2026-08-29",
            "entries": [
                {
                    "assignment_id": assignment["id"],
                    "attendance_status": "present",
                    "day_fraction": "1.000",
                    "work_minutes": None,
                    "work_summary": "安装",
                    "notes": None,
                    "expected_revision": None,
                }
            ],
        }
        first = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=payload,
        )
        first_item = first.json()["items"][0]
        payload["entries"][0].update(
            {
                "day_fraction": "0.500",
                "work_summary": "半天安装",
                "expected_revision": first_item["revision"],
            }
        )
        second = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=payload,
        )
        listed = client.get("/api/projects/P-001/labor-entries")

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["items"][0]["id"] == first_item["id"]
    assert second.json()["items"][0]["revision"] == 2
    assert second.json()["items"][0]["cost_cents"] == 30_000
    assert listed.json()["total"] == 1


def test_batch_rejects_same_worker_twice_through_different_assignments(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        first_assignment = _create_assignment(client, worker["id"])
        second_assignment = _create_assignment(client, worker["id"])
        response = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                    for assignment in (first_assignment, second_assignment)
                ],
            },
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "DUPLICATE_WORKER_IN_LABOR_BATCH"
    assert response.json()["field_errors"] == {
        "entries.1.assignment_id": "worker already occurs in this batch"
    }
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM labor_entries").fetchone()[0] == 0
        )
    finally:
        connection.close()


def test_batch_conflicts_with_existing_worker_date_under_another_assignment(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        first_assignment = _create_assignment(client, worker["id"])
        second_assignment = _create_assignment(client, worker["id"])
        first = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": first_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                ],
            },
        )
        conflict = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": second_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                ],
            },
        )

    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "WORKER_LABOR_ENTRY_EXISTS"
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            "SELECT assignment_id FROM labor_entries ORDER BY id"
        ).fetchall()
        assert [row[0] for row in rows] == [first_assignment["id"]]
    finally:
        connection.close()


def test_labor_cost_keeps_original_rate_after_assignment_rate_changes(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"], rate_cents=60_000)
        first = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                ],
            },
        ).json()["items"][0]
        changed_assignment = client.put(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}",
            json={
                "worker_id": worker["id"],
                "role": "施工员",
                "scheduled_start_on": "2026-08-29",
                "scheduled_end_on": "2026-09-05",
                "pay_basis": "daily",
                "rate_cents": 100_000,
                "notes": None,
                "expected_revision": assignment["revision"],
            },
        )
        updated = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": first["revision"],
                    }
                ],
            },
        )

    assert changed_assignment.status_code == 200
    assert updated.status_code == 200
    assert updated.json()["items"][0]["rate_cents"] == 60_000
    assert updated.json()["items"][0]["cost_cents"] == 30_000


def test_archiving_project_allows_correction_but_rejects_any_new_labor_fact(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        first_worker = _create_worker(client, name="甲")
        second_worker = _create_worker(client, name="乙")
        first_assignment = _create_assignment(client, first_worker["id"])
        second_assignment = _create_assignment(client, second_worker["id"])
        initial = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": first_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": "原记录",
                        "notes": None,
                        "expected_revision": None,
                    }
                ],
            },
        ).json()["items"][0]

        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?, archive_reason = ?
                WHERE id = 1
                """,
                (NOW.isoformat(), "项目完工"),
            )
        finally:
            connection.close()

        corrected = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": first_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "归档后纠错",
                        "notes": None,
                        "expected_revision": initial["revision"],
                    }
                ],
            },
        )
        correction = corrected.json()["items"][0]
        rejected = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": first_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": "不应提交",
                        "notes": None,
                        "expected_revision": correction["revision"],
                    },
                    {
                        "assignment_id": second_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": "新增事实",
                        "notes": None,
                        "expected_revision": None,
                    },
                ],
            },
        )
        listed = client.get("/api/projects/P-001/labor-entries?page_size=10")

    assert corrected.status_code == 200
    assert rejected.status_code == 409
    assert rejected.json()["error_code"] == "PROJECT_ARCHIVED"
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["day_fraction"] == "0.500"
    assert listed.json()["items"][0]["revision"] == correction["revision"]


def test_batch_is_atomic_when_any_row_is_invalid(harness: WorkforceHarness) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        response = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    },
                    {
                        "assignment_id": 99999,
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    },
                ],
            },
        )

    assert response.status_code == 404
    assert response.json()["error_code"] == "ASSIGNMENT_NOT_FOUND"
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM labor_entries").fetchone()[0] == 0
        )
    finally:
        connection.close()


def test_batch_rejects_calculated_cost_outside_sqlite_integer_range(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(
            client,
            worker["id"],
            pay_basis="hourly",
            rate_cents=2**63 - 1,
        )
        response = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": None,
                        "work_minutes": 1440,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                ],
            },
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_LABOR_BATCH_PAYLOAD"
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM labor_entries").fetchone()[0] == 0
        )
    finally:
        connection.close()


def test_batch_revision_conflict_rolls_back_other_updates(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        first_worker = _create_worker(client, name="甲")
        second_worker = _create_worker(client, name="乙")
        first_assignment = _create_assignment(client, first_worker["id"])
        second_assignment = _create_assignment(client, second_worker["id"])
        initial = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "1.000",
                        "work_minutes": None,
                        "work_summary": None,
                        "notes": None,
                        "expected_revision": None,
                    }
                    for assignment in (first_assignment, second_assignment)
                ],
            },
        ).json()["items"]
        conflict = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json={
                "work_date": "2026-08-29",
                "entries": [
                    {
                        "assignment_id": first_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "不应提交",
                        "notes": None,
                        "expected_revision": initial[0]["revision"],
                    },
                    {
                        "assignment_id": second_assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "冲突",
                        "notes": None,
                        "expected_revision": 99,
                    },
                ],
            },
        )
        listed = client.get("/api/projects/P-001/labor-entries?page_size=10")

    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "REVISION_CONFLICT"
    by_assignment = {item["assignment_id"]: item for item in listed.json()["items"]}
    assert by_assignment[first_assignment["id"]]["day_fraction"] == "1.000"
    assert by_assignment[first_assignment["id"]]["revision"] == 1


def test_batch_idempotency_replays_and_rejects_changed_payload(
    harness: WorkforceHarness,
) -> None:
    key = str(uuid.uuid4())
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        payload = {
            "work_date": "2026-08-29",
            "entries": [
                {
                    "assignment_id": assignment["id"],
                    "attendance_status": "present",
                    "day_fraction": "1.000",
                    "work_minutes": None,
                    "work_summary": None,
                    "notes": None,
                    "expected_revision": None,
                }
            ],
        }
        first = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(key),
            json=payload,
        )
        replay = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(key),
            json=payload,
        )
        payload["entries"][0]["work_summary"] = "改变内容"
        changed = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(key),
            json=payload,
        )

    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "IDEMPOTENCY_CONFLICT"


def test_labor_list_filters_by_date_worker_and_pages(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        for work_date in ("2026-08-28", "2026-08-29"):
            response = client.post(
                "/api/projects/P-001/labor-entries/batch",
                headers=_idempotency_headers(),
                json={
                    "work_date": work_date,
                    "entries": [
                        {
                            "assignment_id": assignment["id"],
                            "attendance_status": "absent",
                            "day_fraction": None,
                            "work_minutes": None,
                            "work_summary": None,
                            "notes": None,
                            "expected_revision": None,
                        }
                    ],
                },
            )
            assert response.status_code == 200
        listed = client.get(
            f"/api/projects/P-001/labor-entries?from=2026-08-29&to=2026-08-29"
            f"&worker_id={worker['id']}&page=1&page_size=1"
        )

    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["work_date"] == "2026-08-29"
    assert listed.json()["items"][0]["cost_cents"] == 0


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("get", "/api/workers", None),
        (
            "post",
            "/api/workers",
            {"name": "张师傅", "phone": None, "notes": None},
        ),
        ("get", "/api/projects/P-001/crew-assignments", None),
        ("get", "/api/projects/P-001/labor-entries", None),
    ],
)
def test_workforce_endpoints_require_authentication(
    harness: WorkforceHarness,
    method: str,
    path: str,
    json_body: dict[str, object] | None,
) -> None:
    headers = _idempotency_headers() if method == "post" else None
    with harness.client(authenticated=False) as client:
        response = client.request(method, path, json=json_body, headers=headers)

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
