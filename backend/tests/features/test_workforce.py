from __future__ import annotations

import importlib
import shutil
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

    def client(
        self,
        *,
        authenticated: bool = True,
        raise_server_exceptions: bool = True,
    ) -> TestClient:
        client = TestClient(
            self.app, raise_server_exceptions=raise_server_exceptions
        )
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
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 status, created_at, updated_at)
            VALUES (3, 'P-002', 'p-002', 1, '另一在建项目', 'active', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
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


def _insert_legacy_overlapping_assignment(
    harness: WorkforceHarness,
    worker_id: int,
) -> dict[str, Any]:
    """Represent data created before overlapping schedules were rejected."""
    connection = connect_database(harness.database_path)
    try:
        cursor = connection.execute(
            """
            INSERT INTO crew_assignments
                (project_id, worker_id, role, scheduled_start_on, scheduled_end_on,
                 pay_basis, rate_cents, notes, status, created_at, updated_at)
            VALUES (1, ?, '历史重叠排单', '2026-08-29', '2026-09-05',
                    'daily', 60000, NULL, 'active', ?, ?)
            """,
            (worker_id, NOW.isoformat(), NOW.isoformat()),
        )
        connection.commit()
        return {"id": cursor.lastrowid}
    finally:
        connection.close()


def _single_labor_payload(
    assignment_id: int,
    *,
    work_date: str = "2026-08-29",
    attendance_status: str = "present",
    day_fraction: str | None = "1.000",
    work_minutes: int | None = None,
    work_summary: str | None = "设备安装",
    notes: str | None = None,
) -> dict[str, object]:
    return {
        "assignment_id": assignment_id,
        "work_date": work_date,
        "attendance_status": attendance_status,
        "day_fraction": day_fraction,
        "work_minutes": work_minutes,
        "work_summary": work_summary,
        "notes": notes,
    }


def test_assignment_rejects_overlapping_schedule_for_same_worker(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        first = _create_assignment(client, worker["id"])
        overlapping = client.post(
            "/api/projects/P-001/crew-assignments",
            headers=_idempotency_headers(),
            json={
                "worker_id": worker["id"],
                "role": "临时支援",
                "scheduled_start_on": "2026-09-01",
                "scheduled_end_on": "2026-09-10",
                "pay_basis": "daily",
                "rate_cents": 60_000,
                "notes": None,
            },
        )
        listed = client.get("/api/projects/P-001/crew-assignments?page_size=10")

    assert first["status"] == "planned"
    assert overlapping.status_code == 409
    assert overlapping.json()["error_code"] == "CREW_ASSIGNMENT_OVERLAP"
    assert listed.json()["total"] == 1


def test_assignment_rejects_worker_schedule_overlap_across_active_projects(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        _create_assignment(client, worker["id"], project_code="P-001")
        overlapping = client.post(
            "/api/projects/P-002/crew-assignments",
            headers=_idempotency_headers(),
            json={
                "worker_id": worker["id"],
                "role": "另一项目支援",
                "scheduled_start_on": "2026-09-01",
                "scheduled_end_on": "2026-09-10",
                "pay_basis": "daily",
                "rate_cents": 60_000,
                "notes": None,
            },
        )

    assert overlapping.status_code == 409
    assert overlapping.json()["error_code"] == "CREW_ASSIGNMENT_OVERLAP"


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
    assert "013_workforce_events" in applied
    assert "021_workforce_audit_history" in applied
    assert {
        "workers",
        "crew_assignments",
        "crew_assignment_transition_events",
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


def test_workforce_audit_migration_preserves_existing_voided_labor(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "legacy.sqlite3"
    legacy_migrations = tmp_path / "migrations-through-020"
    legacy_migrations.mkdir()
    source_migrations = PROJECT_ROOT / "backend" / "migrations"
    for path in source_migrations.glob("*.sql"):
        if path.name < "021_":
            shutil.copy2(path, legacy_migrations / path.name)

    connection = connect_database(database_path)
    try:
        apply_migrations(connection, legacy_migrations)
        timestamp = NOW.isoformat()
        connection.execute(
            "INSERT INTO companies (id, name, created_at, updated_at) "
            "VALUES (1, '客户', ?, ?)",
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name, status,
                 created_at, updated_at)
            VALUES (1, 'P-001', 'p-001', 1, '项目', 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.execute(
            "INSERT INTO workers (id, name, status, created_at, updated_at) "
            "VALUES (1, '张工', 'active', ?, ?)",
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO crew_assignments
                (id, project_id, worker_id, role, scheduled_start_on,
                 scheduled_end_on, pay_basis, rate_cents, status,
                 created_at, updated_at)
            VALUES (1, 1, 1, '施工员', '2026-08-01', '2026-09-30',
                    'daily', 60000, 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO labor_entries
                (id, project_id, assignment_id, worker_id, work_date,
                 attendance_status, day_fraction_milli, work_minutes,
                 pay_basis, rate_cents, cost_cents, work_summary, notes,
                 status, void_reason, voided_at, revision, created_at, updated_at)
            VALUES (1, 1, 1, 1, '2026-08-29', 'present', 1000, NULL,
                    'daily', 60000, 60000, '原始正文', NULL, 'voided',
                    '工时录错', ?, 2, ?, ?)
            """,
            (timestamp, timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO site_daily_reports
                (id, project_id, work_date, location, weather, work_summary,
                 blockers, next_plan, notes, status, confirmed_at, revision,
                 created_at, updated_at)
            VALUES (1, 1, '2026-08-29', '一号车间', '晴', '已确认正文',
                    NULL, '继续安装', NULL, 'confirmed', ?, 2, ?, ?)
            """,
            (timestamp, timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO site_daily_report_events
                (id, project_id, report_id, from_status, to_status, reason,
                 occurred_at, created_at)
            VALUES (1, 1, 1, 'draft', 'confirmed', NULL, ?, ?)
            """,
            (timestamp, timestamp),
        )

        assert apply_migrations(connection, source_migrations) == [
            "021_workforce_audit_history",
            "022_supplier_invoice_active_number",
        ]
        preserved = connection.execute(
            "SELECT * FROM labor_entries WHERE id = 1"
        ).fetchone()
        assert preserved is not None
        assert preserved["status"] == "voided"
        assert preserved["work_summary"] == "原始正文"
        assert preserved["cost_cents"] == 60_000
        assert preserved["replaces_entry_id"] is None
        version = connection.execute(
            "SELECT * FROM site_daily_report_versions WHERE report_id = 1"
        ).fetchone()
        assert version is not None
        assert version["version_number"] == 1
        assert version["work_summary"] == "已确认正文"
        assert connection.execute(
            "SELECT report_version_id FROM site_daily_report_events WHERE id = 1"
        ).fetchone()[0] == version["id"]

        connection.execute(
            """
            INSERT INTO labor_entries
                (project_id, assignment_id, worker_id, replaces_entry_id,
                 work_date, attendance_status, day_fraction_milli,
                 work_minutes, pay_basis, rate_cents, cost_cents, work_summary,
                 notes, status, created_at, updated_at)
            VALUES (1, 1, 1, 1, '2026-08-29', 'present', 500, NULL,
                    'daily', 60000, 30000, '更正正文', NULL, 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM labor_entries WHERE work_date = '2026-08-29'"
        ).fetchone()[0] == 2
    finally:
        connection.close()


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


def test_inactive_worker_can_be_reactivated_with_revision_and_idempotency(
    harness: WorkforceHarness,
) -> None:
    key = str(uuid.uuid4())
    with harness.client() as client:
        worker = _create_worker(client)
        inactive = client.post(
            f"/api/workers/{worker['id']}/deactivate",
            headers=_idempotency_headers(),
            json={
                "effective_on": "2026-08-30",
                "reason": "暂停接单",
                "expected_revision": worker["revision"],
            },
        ).json()
        stale = client.post(
            f"/api/workers/{worker['id']}/reactivate",
            headers=_idempotency_headers(),
            json={"expected_revision": worker["revision"]},
        )
        active = client.post(
            f"/api/workers/{worker['id']}/reactivate",
            headers=_idempotency_headers(key),
            json={"expected_revision": inactive["revision"]},
        )
        replay = client.post(
            f"/api/workers/{worker['id']}/reactivate",
            headers=_idempotency_headers(key),
            json={"expected_revision": inactive["revision"]},
        )

    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    assert stale.json()["current_revision"] == inactive["revision"]
    assert active.status_code == 200
    assert active.json()["status"] == "active"
    assert active.json()["inactive_on"] is None
    assert active.json()["inactive_reason"] is None
    assert active.json()["revision"] == inactive["revision"] + 1
    assert replay.status_code == 200
    assert replay.json() == active.json()


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


@pytest.mark.parametrize("terminal_status", ["completed", "cancelled"])
def test_terminal_assignment_cannot_be_edited(
    harness: WorkforceHarness,
    terminal_status: str,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        current = assignment
        if terminal_status == "completed":
            current = client.post(
                f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
                headers=_idempotency_headers(),
                json={
                    "to_status": "active",
                    "effective_at": "2026-08-29T08:00:00+08:00",
                    "reason": None,
                    "expected_revision": current["revision"],
                },
            ).json()
        terminal = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": terminal_status,
                "effective_at": "2026-08-29T10:00:00+08:00",
                "reason": "状态已结束",
                "expected_revision": current["revision"],
            },
        )
        edited = client.put(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}",
            json={
                "worker_id": worker["id"],
                "role": "不应被保存",
                "scheduled_start_on": "2026-08-30",
                "scheduled_end_on": "2026-09-06",
                "pay_basis": "daily",
                "rate_cents": 65_000,
                "notes": None,
                "expected_revision": terminal.json()["revision"],
            },
        )
        detail = client.get(
            f"/api/projects/P-001/crew-assignments?status={terminal_status}"
        )

    assert terminal.status_code == 200
    assert edited.status_code == 409
    assert edited.json()["error_code"] == "ASSIGNMENT_TERMINAL"
    assert detail.json()["items"][0]["role"] == "施工员"


def test_assignment_transition_enforces_state_machine_revision_and_idempotency(
    harness: WorkforceHarness,
) -> None:
    start_key = str(uuid.uuid4())
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        started = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(start_key),
            json={
                "to_status": "active",
                "effective_at": "2026-08-29T08:00:00+08:00",
                "reason": None,
                "expected_revision": assignment["revision"],
            },
        )
        assert started.status_code == 200, started.text
        replay = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(start_key),
            json={
                "to_status": "active",
                "effective_at": "2026-08-29T08:00:00+08:00",
                "reason": None,
                "expected_revision": assignment["revision"],
            },
        )
        backwards = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "planned",
                "effective_at": "2026-08-29T09:00:00+08:00",
                "reason": None,
                "expected_revision": started.json()["revision"],
            },
        )
        completed = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "completed",
                "effective_at": "2026-08-29T10:00:00+08:00",
                "reason": "现场工作完成",
                "expected_revision": started.json()["revision"],
            },
        )
        terminal = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "cancelled",
                "effective_at": "2026-08-29T10:15:00+08:00",
                "reason": "不应再变更",
                "expected_revision": completed.json()["revision"],
            },
        )

    connection = connect_database(harness.database_path)
    try:
        events = connection.execute(
            """
            SELECT from_status, to_status, effective_at, reason
            FROM crew_assignment_transition_events
            WHERE assignment_id = ? ORDER BY id
            """,
            (assignment["id"],),
        ).fetchall()
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE crew_assignment_transition_events SET reason = '篡改' WHERE assignment_id = ?",
                (assignment["id"],),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "DELETE FROM crew_assignment_transition_events WHERE assignment_id = ?",
                (assignment["id"],),
            )
    finally:
        connection.close()

    assert started.status_code == 200
    assert started.json()["status"] == "active"
    assert replay.status_code == 200
    assert replay.json() == started.json()
    assert backwards.status_code == 409
    assert backwards.json()["error_code"] == "INVALID_ASSIGNMENT_TRANSITION"
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert terminal.status_code == 409
    assert terminal.json()["error_code"] == "INVALID_ASSIGNMENT_TRANSITION"
    assert [tuple(row) for row in events] == [
        ("planned", "active", "2026-08-29T00:00:00+00:00", None),
        ("active", "completed", "2026-08-29T02:00:00+00:00", "现场工作完成"),
    ]


def test_assignment_transition_rejects_future_time_and_cancel_without_reason(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        future = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "active",
                "effective_at": "2026-08-30T08:00:00+08:00",
                "reason": None,
                "expected_revision": assignment["revision"],
            },
        )
        missing_reason = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "cancelled",
                "effective_at": "2026-08-29T08:00:00+08:00",
                "reason": None,
                "expected_revision": assignment["revision"],
            },
        )
        listed = client.get("/api/projects/P-001/crew-assignments")

    assert future.status_code == 422
    assert future.json()["error_code"] == "INVALID_ASSIGNMENT_TRANSITION"
    assert future.json()["field_errors"] == {
        "effective_at": "must not be in the future"
    }
    assert missing_reason.status_code == 422
    assert missing_reason.json()["field_errors"] == {
        "reason": "is required when cancelling an assignment"
    }
    assert listed.json()["items"][0]["status"] == "planned"


def test_assignment_transition_rejects_revision_conflict(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        response = client.post(
            f"/api/projects/P-001/crew-assignments/{assignment['id']}/transition",
            headers=_idempotency_headers(),
            json={
                "to_status": "cancelled",
                "effective_at": "2026-08-29T08:00:00+08:00",
                "reason": "项目取消",
                "expected_revision": 99,
            },
        )

    assert response.status_code == 409
    assert response.json()["error_code"] == "REVISION_CONFLICT"
    assert response.json()["current_revision"] == assignment["revision"]


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


def test_batch_without_revision_matching_active_entry_is_noop(
    harness: WorkforceHarness,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
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
        created = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=payload,
        )
        retried = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=payload,
        )
        listed = client.get("/api/projects/P-001/labor-entries")

    assert created.status_code == 200
    assert retried.status_code == 200
    assert retried.json() == created.json()
    assert listed.json()["total"] == 1
    assert (
        listed.json()["items"][0]["revision"]
        == created.json()["items"][0]["revision"]
    )


def test_batch_without_revision_does_not_reactivate_matching_voided_entry(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        batch_payload = {
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
        created = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=batch_payload,
        )
        entry = created.json()["items"][0]
        voided = client.post(
            f"/api/projects/P-001/labor-entries/{entry['id']}/void",
            headers=_idempotency_headers(),
            json={
                "reason": "重复登记",
                "expected_revision": entry["revision"],
            },
        )
        conflict = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(),
            json=batch_payload,
        )
        listed = client.get("/api/projects/P-001/labor-entries")

    assert created.status_code == 200
    assert voided.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "REVISION_CONFLICT"
    assert conflict.json()["current_revision"] == voided.json()["revision"]
    stored = listed.json()["items"][0]
    assert stored["status"] == "voided"
    assert stored["void_reason"] == "重复登记"
    assert stored["revision"] == voided.json()["revision"]


def test_batch_rejects_same_worker_twice_through_different_assignments(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        first_assignment = _create_assignment(client, worker["id"])
        second_assignment = _insert_legacy_overlapping_assignment(
            harness, worker["id"]
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
        second_assignment = _insert_legacy_overlapping_assignment(
            harness, worker["id"]
        )
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


def test_single_labor_create_update_void_preserves_cost_and_void_state(
    harness: WorkforceHarness,
) -> None:
    create_key = str(uuid.uuid4())
    void_key = str(uuid.uuid4())
    reenter_key = str(uuid.uuid4())
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"], rate_cents=60_001)
        payload = _single_labor_payload(
            assignment["id"], day_fraction="0.500", work_summary="初次记录"
        )
        created = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(create_key),
            json=payload,
        )
        assert created.status_code == 201, created.text
        replay = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(create_key),
            json=payload,
        )
        updated = client.put(
            f"/api/projects/P-001/labor-entries/{created.json()['id']}",
            json={
                **payload,
                "day_fraction": "1.000",
                "work_summary": "改为全天",
                "expected_revision": created.json()["revision"],
            },
        )
        voided = client.post(
            f"/api/projects/P-001/labor-entries/{created.json()['id']}/void",
            headers=_idempotency_headers(void_key),
            json={
                "reason": "重复登记",
                "expected_revision": updated.json()["revision"],
            },
        )
        void_replay = client.post(
            f"/api/projects/P-001/labor-entries/{created.json()['id']}/void",
            headers=_idempotency_headers(void_key),
            json={
                "reason": "重复登记",
                "expected_revision": updated.json()["revision"],
            },
        )
        edit_voided = client.put(
            f"/api/projects/P-001/labor-entries/{created.json()['id']}",
            json={
                **payload,
                "expected_revision": voided.json()["revision"],
            },
        )
        batch_reenter_voided = client.post(
            "/api/projects/P-001/labor-entries/batch",
            headers=_idempotency_headers(reenter_key),
            json={
                "work_date": payload["work_date"],
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "作废后重新录入",
                        "notes": None,
                        "expected_revision": voided.json()["revision"],
                    }
                ],
            },
        )
        reenter_replay = client.post(
            "/api/projects/p-001/labor-entries/batch",
            headers=_idempotency_headers(reenter_key),
            json={
                "work_date": payload["work_date"],
                "entries": [
                    {
                        "assignment_id": assignment["id"],
                        "attendance_status": "present",
                        "day_fraction": "0.500",
                        "work_minutes": None,
                        "work_summary": "作废后重新录入",
                        "notes": None,
                        "expected_revision": voided.json()["revision"],
                    }
                ],
            },
        )
        listed = client.get("/api/projects/P-001/labor-entries")

    assert created.status_code == 201
    assert created.json()["cost_cents"] == 30_001
    assert created.json()["pay_basis"] == "daily"
    assert created.json()["rate_cents"] == 60_001
    assert replay.status_code == 201
    assert replay.json() == created.json()
    assert updated.status_code == 200
    assert updated.json()["cost_cents"] == 60_001
    assert updated.json()["revision"] == created.json()["revision"] + 1
    assert voided.status_code == 200
    assert voided.json()["status"] == "voided"
    assert voided.json()["void_reason"] == "重复登记"
    assert voided.json()["cost_cents"] == 60_001
    assert void_replay.status_code == 200
    assert void_replay.json() == voided.json()
    assert edit_voided.status_code == 409
    assert edit_voided.json()["error_code"] == "LABOR_ENTRY_VOIDED"
    assert batch_reenter_voided.status_code == 200
    assert reenter_replay.status_code == 200
    assert reenter_replay.json() == batch_reenter_voided.json()
    replacement = batch_reenter_voided.json()["items"][0]
    assert replacement["id"] != voided.json()["id"]
    assert replacement["status"] == "active"
    assert replacement["void_reason"] is None
    assert replacement["work_summary"] == "作废后重新录入"
    assert replacement["revision"] == 1
    assert replacement["replaces_entry_id"] == voided.json()["id"]
    entries = listed.json()["items"]
    assert len(entries) == 2
    assert entries[0]["id"] == replacement["id"]
    assert entries[1]["id"] == voided.json()["id"]
    assert entries[1]["status"] == "voided"
    assert entries[1]["void_reason"] == "重复登记"

    connection = connect_database(harness.database_path)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="voided labor entry is immutable"):
            connection.execute(
                "UPDATE labor_entries SET status = 'active', void_reason = NULL, "
                "voided_at = NULL WHERE id = ?",
                (voided.json()["id"],),
            )
        with pytest.raises(sqlite3.IntegrityError, match="voided labor entry is immutable"):
            connection.execute(
                "DELETE FROM labor_entries WHERE id = ?", (voided.json()["id"],)
            )
    finally:
        connection.close()


def test_replacement_labor_identity_is_immutable_but_content_remains_editable(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        other_worker = _create_worker(client, name="李师傅")
        other_assignment = _create_assignment(client, other_worker["id"])
        payload = _single_labor_payload(assignment["id"], work_summary="错误记录")
        original = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json=payload,
        ).json()
        voided = client.post(
            f"/api/projects/P-001/labor-entries/{original['id']}/void",
            headers=_idempotency_headers(),
            json={"reason": "身份录错", "expected_revision": original["revision"]},
        ).json()
        replacement = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json={**payload, "work_summary": "更正记录"},
        ).json()

        moved_date = client.put(
            f"/api/projects/P-001/labor-entries/{replacement['id']}",
            json={
                **payload,
                "work_date": "2026-08-30",
                "expected_revision": replacement["revision"],
            },
        )
        moved_worker = client.put(
            f"/api/projects/P-001/labor-entries/{replacement['id']}",
            json={
                **_single_labor_payload(other_assignment["id"]),
                "expected_revision": replacement["revision"],
            },
        )
        edited = client.put(
            f"/api/projects/P-001/labor-entries/{replacement['id']}",
            json={
                **payload,
                "work_summary": "只修改工作内容",
                "expected_revision": replacement["revision"],
            },
        )

    assert replacement["replaces_entry_id"] == voided["id"]
    for response in (moved_date, moved_worker):
        assert response.status_code == 409
        assert response.json()["error_code"] == (
            "LABOR_REPLACEMENT_IDENTITY_IMMUTABLE"
        )
    assert edited.status_code == 200
    assert edited.json()["work_summary"] == "只修改工作内容"

    connection = connect_database(harness.database_path)
    try:
        with pytest.raises(
            sqlite3.IntegrityError,
            match="replacement labor identity is immutable",
        ):
            connection.execute(
                "UPDATE labor_entries SET work_date = '2026-08-30' WHERE id = ?",
                (replacement["id"],),
            )
    finally:
        connection.close()


def test_workforce_audit_migration_preserves_legacy_report_cycles_without_fake_snapshots(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "legacy-report-history.sqlite3"
    legacy_migrations = tmp_path / "migrations-through-020"
    legacy_migrations.mkdir()
    source_migrations = PROJECT_ROOT / "backend" / "migrations"
    for path in source_migrations.glob("*.sql"):
        if path.name < "021_":
            shutil.copy2(path, legacy_migrations / path.name)

    timestamp = NOW.isoformat()
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, legacy_migrations)
        connection.execute(
            "INSERT INTO companies (id, name, created_at, updated_at) "
            "VALUES (1, '客户', ?, ?)",
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name, status,
                 created_at, updated_at)
            VALUES (1, 'P-001', 'p-001', 1, '项目', 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.executemany(
            """
            INSERT INTO site_daily_reports
                (id, project_id, work_date, location, weather, work_summary,
                 blockers, next_plan, notes, status, confirmed_at, revision,
                 created_at, updated_at)
            VALUES (?, 1, ?, '一号车间', '晴', ?, NULL, '继续安装', NULL,
                    ?, ?, ?, ?, ?)
            """,
            [
                (
                    1,
                    "2026-08-28",
                    "第二轮确认后的正文",
                    "confirmed",
                    timestamp,
                    5,
                    timestamp,
                    timestamp,
                ),
                (
                    2,
                    "2026-08-29",
                    "第二次重开后的草稿",
                    "draft",
                    None,
                    5,
                    timestamp,
                    timestamp,
                ),
            ],
        )
        connection.executemany(
            """
            INSERT INTO site_daily_report_events
                (id, project_id, report_id, from_status, to_status, reason,
                 occurred_at, created_at)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?)
            """,
            [
                (1, 1, "draft", "confirmed", None, timestamp, timestamp),
                (2, 1, "confirmed", "draft", "第一轮补录", timestamp, timestamp),
                (3, 1, "draft", "confirmed", None, timestamp, timestamp),
                (4, 2, "draft", "confirmed", None, timestamp, timestamp),
                (5, 2, "confirmed", "draft", "第一轮补录", timestamp, timestamp),
                (6, 2, "draft", "confirmed", None, timestamp, timestamp),
                (7, 2, "confirmed", "draft", "第二轮补录", timestamp, timestamp),
            ],
        )

        assert apply_migrations(connection, source_migrations) == [
            "021_workforce_audit_history",
            "022_supplier_invoice_active_number",
        ]
        confirmed_versions = connection.execute(
            "SELECT * FROM site_daily_report_versions WHERE report_id = 1"
        ).fetchall()
        draft_versions = connection.execute(
            "SELECT * FROM site_daily_report_versions WHERE report_id = 2"
        ).fetchall()
        confirmed_event_links = connection.execute(
            "SELECT report_version_id FROM site_daily_report_events "
            "WHERE report_id = 1 ORDER BY id"
        ).fetchall()
        draft_event_links = connection.execute(
            "SELECT report_version_id FROM site_daily_report_events "
            "WHERE report_id = 2 ORDER BY id"
        ).fetchall()
    finally:
        connection.close()

    assert len(confirmed_versions) == 1
    assert confirmed_versions[0]["version_number"] == 2
    assert confirmed_versions[0]["work_summary"] == "第二轮确认后的正文"
    assert [row[0] for row in confirmed_event_links] == [
        None,
        None,
        confirmed_versions[0]["id"],
    ]
    assert draft_versions == []
    assert [row[0] for row in draft_event_links] == [None, None, None, None]

    site_operations = importlib.import_module("backend.app.features.site_operations")
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
        current = connect_database(database_path)
        try:
            yield current
        finally:
            current.close()

    app = FastAPI()
    app.include_router(
        site_operations.create_site_operations_router(
            get_connection,
            lambda: settings,
            clock=lambda: NOW,
        )
    )
    with TestClient(app) as client:
        client.cookies.set(
            SESSION_COOKIE_NAME,
            create_session_token(settings.session_secret),
        )
        listed = client.get("/api/projects/P-001/site-daily-reports?page_size=20")
        confirmed_again = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-29/confirm",
            headers=_idempotency_headers(),
            json={"confirmed_at": timestamp, "expected_revision": 5},
        )

    assert listed.status_code == 200
    reports = {item["id"]: item for item in listed.json()["items"]}
    assert [event["report_version_id"] for event in reports[1]["events"]] == [
        None,
        None,
        reports[1]["versions"][0]["id"],
    ]
    assert reports[2]["versions"] == []
    assert [event["report_version_id"] for event in reports[2]["events"]] == [
        None,
        None,
        None,
        None,
    ]
    assert confirmed_again.status_code == 200
    assert confirmed_again.json()["versions"][0]["version_number"] == 3
    assert confirmed_again.json()["versions"][0]["work_summary"] == (
        "第二次重开后的草稿"
    )


def test_single_hourly_labor_uses_assignment_snapshot_and_revision_conflicts(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(
            client, worker["id"], pay_basis="hourly", rate_cents=3_001
        )
        payload = _single_labor_payload(
            assignment["id"],
            day_fraction=None,
            work_minutes=61,
            work_summary=None,
        )
        created = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json=payload,
        )
        assert created.status_code == 201, created.text
        conflict = client.put(
            f"/api/projects/P-001/labor-entries/{created.json()['id']}",
            json={**payload, "work_minutes": 120, "expected_revision": 99},
        )

    assert created.status_code == 201
    assert created.json()["cost_cents"] == 3_051
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "REVISION_CONFLICT"
    assert conflict.json()["current_revision"] == created.json()["revision"]


@pytest.mark.parametrize(
    ("payload", "expected_code"),
    [
        (
            {
                "work_date": "2026/08/29",
                "attendance_status": "present",
                "day_fraction": "1.000",
                "work_minutes": None,
            },
            "INVALID_LABOR_PAYLOAD",
        ),
        (
            {
                "work_date": "2026-08-29",
                "attendance_status": "present",
                "day_fraction": None,
                "work_minutes": 60,
            },
            "INVALID_LABOR_PAYLOAD",
        ),
    ],
)
def test_single_daily_labor_rejects_invalid_date_or_paid_quantity(
    harness: WorkforceHarness,
    payload: dict[str, object],
    expected_code: str,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"], pay_basis="daily")
        response = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json={
                **_single_labor_payload(assignment["id"]),
                **payload,
            },
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == expected_code


def test_single_labor_rejects_wrong_assignment_inactive_worker_and_archived_project(
    harness: WorkforceHarness,
) -> None:
    with harness.client() as client:
        worker = _create_worker(client)
        assignment = _create_assignment(client, worker["id"])
        client.post(
            f"/api/workers/{worker['id']}/deactivate",
            headers=_idempotency_headers(),
            json={
                "effective_on": "2026-08-29",
                "reason": "离场",
                "expected_revision": worker["revision"],
            },
        )
        inactive = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json=_single_labor_payload(assignment["id"]),
        )
        missing_assignment = client.post(
            "/api/projects/P-001/labor-entries",
            headers=_idempotency_headers(),
            json=_single_labor_payload(999),
        )
        archived = client.post(
            "/api/projects/P-ARCHIVED/labor-entries",
            headers=_idempotency_headers(),
            json=_single_labor_payload(assignment["id"]),
        )

    assert inactive.status_code == 409
    assert inactive.json()["error_code"] == "WORKER_INACTIVE"
    assert missing_assignment.status_code == 404
    assert missing_assignment.json()["error_code"] == "ASSIGNMENT_NOT_FOUND"
    assert archived.status_code == 409
    assert archived.json()["error_code"] == "PROJECT_ARCHIVED"


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
