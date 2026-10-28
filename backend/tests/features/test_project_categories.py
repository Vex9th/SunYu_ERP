from __future__ import annotations

import shutil
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features.dashboards import create_dashboards_router
from backend.app.features.project_stages import create_project_stages_router
from backend.tests.features.test_projects import (
    NOW,
    PROJECT_ROOT,
    ProjectsHarness,
    _build_harness,
    _insert_company,
    _insert_signed_contract_allocation,
    _project_payload,
)

TRADE_STAGES = [
    "contract",
    "advance_payment",
    "procurement",
    "acceptance",
    "final_payment",
]
STANDARD_STAGES = [
    "planning",
    "site_survey",
    "quotation",
    "technical_agreement",
    "contract",
    "advance_payment",
    "mechanical_design",
    "electrical_design",
    "procurement",
    "staffing",
    "mechanical_signoff",
    "electrical_signoff",
    "construction",
    "progress_payment",
    "commissioning",
    "acceptance",
    "final_payment",
    "closeout",
]


@pytest.fixture
def harness(tmp_path: Path) -> ProjectsHarness:
    result = _build_harness(tmp_path)

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(result.database_path)
        try:
            yield connection
        finally:
            connection.close()

    for create_router in (create_project_stages_router, create_dashboards_router):
        result.app.include_router(
            create_router(get_connection, lambda: result.settings, clock=lambda: NOW)
        )
    _insert_company(result)
    return result


def _create_trade(harness: ProjectsHarness) -> int:
    with harness.client() as client:
        response = client.post(
            "/api/projects",
            json={**_project_payload(), "project_category": "trade"},
        )
    assert response.status_code == 201
    return int(response.json()["id"])


def _finish_trade_stages(harness: ProjectsHarness, acceptance_status: str) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            UPDATE project_stages
            SET status = 'skipped', status_reason = '该步骤无需执行',
                completed_at = ?
            WHERE stage_code <> 'acceptance'
            """,
            (NOW.isoformat(),),
        )
        if acceptance_status == "completed":
            connection.execute(
                """
                UPDATE project_stages SET status = 'completed',
                    started_at = ?, completed_at = ?
                WHERE stage_code = 'acceptance'
                """,
                (NOW.isoformat(), NOW.isoformat()),
            )
        elif acceptance_status == "skipped":
            connection.execute(
                """
                UPDATE project_stages SET status = 'skipped',
                    status_reason = '签收无需重复执行', completed_at = ?
                WHERE stage_code = 'acceptance'
                """,
                (NOW.isoformat(),),
            )
    finally:
        connection.close()


@pytest.mark.parametrize("category", [None, "standard", "trade"])
def test_creation_selects_template_and_returns_category_everywhere(
    harness: ProjectsHarness,
    category: str | None,
) -> None:
    payload = _project_payload()
    if category is not None:
        payload["project_category"] = category
    expected_category = category or "standard"
    expected_stages = TRADE_STAGES if category == "trade" else STANDARD_STAGES
    with harness.client() as client:
        created = client.post("/api/projects", json=payload)
        assert created.status_code == 201
        assert created.json()["project_category"] == expected_category
        listed = client.get("/api/projects")
        detail = client.get("/api/projects/P-2026-001")
        stages = client.get("/api/projects/P-2026-001/stages")
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        global_dashboard = client.get("/api/dashboard")
    for response in (listed, detail, stages, dashboard, global_dashboard):
        assert response.status_code == 200
    assert listed.json()[0]["project_category"] == expected_category
    assert detail.json()["project_category"] == expected_category
    assert dashboard.json()["project"]["project_category"] == expected_category
    assert (
        global_dashboard.json()["projects"][0]["project"]["project_category"]
        == expected_category
    )
    assert [stage["stage_code"] for stage in stages.json()] == expected_stages
    assert [
        stage["stage_code"] for stage in dashboard.json()["stages"]
    ] == expected_stages
    assert all(stage["status"] == "pending" for stage in stages.json())


@pytest.mark.parametrize("category", [None, "", "工程", "Trade", 0, True, [], {}])
def test_invalid_category_does_not_create_project(
    harness: ProjectsHarness,
    category: object,
) -> None:
    with harness.client() as client:
        response = client.post(
            "/api/projects",
            json={**_project_payload(), "project_category": category},
        )
        assert response.status_code == 422
        assert client.get("/api/projects").json() == []


def test_project_category_cannot_be_changed_through_update(
    harness: ProjectsHarness,
) -> None:
    _create_trade(harness)
    with harness.client() as client:
        response = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": 1,
                "name": "设备贸易",
                "description": None,
                "expected_revision": 1,
                "project_category": "standard",
            },
        )
        assert response.status_code == 422
        assert (
            client.get("/api/projects/P-2026-001").json()["project_category"] == "trade"
        )
        assert len(client.get("/api/projects/P-2026-001/stages").json()) == 5


def test_trade_acceptance_stage_uses_existing_transition_and_workbench(
    harness: ProjectsHarness,
) -> None:
    _create_trade(harness)
    with harness.client() as client:
        for revision, target in ((1, "in_progress"), (2, "completed")):
            response = client.post(
                "/api/projects/P-2026-001/stages/acceptance/transition",
                headers={"Idempotency-Key": str(uuid4())},
                json={
                    "to_status": target,
                    "occurred_at": NOW.isoformat(),
                    "reason": None,
                    "expected_revision": revision,
                },
            )
            assert response.status_code == 200
            assert response.json()["revision"] == revision + 1
            if target == "in_progress":
                global_dashboard = client.get("/api/dashboard")
                row = global_dashboard.json()["projects"][0]
                assert row["project"]["project_category"] == "trade"
                assert row["current_stage"]["stage_code"] == "acceptance"
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
    assert dashboard.json()["completion_check"]["final_acceptance_ready"] is True
    assert dashboard.json()["completion_check"]["stages_ready"] is False
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stage_events").fetchone()[
                0
            ]
            == 2
        )
        assert connection.execute("SELECT COUNT(*) FROM acceptances").fetchone()[0] == 0
    finally:
        connection.close()


@pytest.mark.parametrize("method", ["schedule", "transition"])
def test_trade_cannot_access_stage_outside_its_template(
    harness: ProjectsHarness,
    method: str,
) -> None:
    _create_trade(harness)
    with harness.client() as client:
        path = "/api/projects/P-2026-001/stages/planning"
        if method == "schedule":
            response = client.put(
                path,
                json={
                    "planned_start_on": None,
                    "planned_end_on": None,
                    "notes": None,
                    "expected_revision": 1,
                },
            )
        else:
            response = client.post(
                path + "/transition",
                headers={"Idempotency-Key": str(uuid4())},
                json={
                    "to_status": "in_progress",
                    "occurred_at": NOW.isoformat(),
                    "reason": None,
                    "expected_revision": 1,
                },
            )
    assert response.status_code == 404
    assert response.json()["error_code"] == "STAGE_NOT_FOUND"
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stage_events").fetchone()[
                0
            ]
            == 0
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM idempotency_requests").fetchone()[
                0
            ]
            == 0
        )
    finally:
        connection.close()


@pytest.mark.parametrize("acceptance_status", ["pending", "completed", "skipped"])
def test_trade_completion_uses_receipt_stage_without_engineering_acceptance(
    harness: ProjectsHarness,
    acceptance_status: str,
) -> None:
    _create_trade(harness)
    _finish_trade_stages(harness, acceptance_status)
    expected_ready = acceptance_status != "pending"
    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        check = dashboard.json()["completion_check"]
        assert check["final_acceptance_ready"] is expected_ready
        assert check["stages_ready"] is expected_ready
        assert check["ready"] is expected_ready
        closed = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "closure_type": "completed",
                "reason": "贸易业务完结",
                "expected_revision": 1,
            },
        )
    assert closed.status_code == (200 if expected_ready else 409)
    if expected_ready:
        assert closed.json()["project_category"] == "trade"
        assert closed.json()["status"] == "archived"


def test_trade_completion_still_blocks_uncollected_contract(
    harness: ProjectsHarness,
) -> None:
    _create_trade(harness)
    _finish_trade_stages(harness, "completed")
    _insert_signed_contract_allocation(harness, company_id=1)
    with harness.client() as client:
        response = client.get("/api/projects/P-2026-001/dashboard")
        check = response.json()["completion_check"]
        assert check["final_acceptance_ready"] is True
        assert check["stages_ready"] is True
        assert check["blockers"] == ["RECEIVABLES_OUTSTANDING"]
        closed = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": str(uuid4())},
            json={
                "closure_type": "completed",
                "reason": "贸易业务完结",
                "expected_revision": 1,
            },
        )
    assert closed.status_code == 409


def test_category_migration_preserves_old_stage_history(tmp_path: Path) -> None:
    migrations_dir = PROJECT_ROOT / "backend" / "migrations"
    legacy_dir = tmp_path / "legacy_migrations"
    legacy_dir.mkdir()
    for path in sorted(migrations_dir.glob("*.sql")):
        if path.name < "025":
            shutil.copyfile(path, legacy_dir / path.name)
    connection = connect_database(tmp_path / "legacy.sqlite")
    try:
        apply_migrations(connection, legacy_dir)
        timestamp = NOW.isoformat()
        connection.execute(
            """
            INSERT INTO companies (id, name, created_at, updated_at)
            VALUES (1, '老客户', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 created_at, updated_at)
            VALUES (1, 'OLD', 'old', 1, '历史工程', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 status, archived_at, archive_reason, created_at, updated_at)
            VALUES (2, 'CLOSED', 'closed', 1, '历史归档项目',
                    'archived', ?, '已取消', ?, ?)
            """,
            (timestamp, timestamp, timestamp),
        )
        connection.execute(
            """
            UPDATE project_stages SET status = 'in_progress', started_at = ?,
                revision = 2
            WHERE project_id = 1 AND stage_code = 'planning'
            """,
            (timestamp,),
        )
        stage_id = connection.execute(
            "SELECT id FROM project_stages WHERE project_id = 1 AND stage_code = 'planning'"
        ).fetchone()[0]
        connection.execute(
            """
            INSERT INTO project_stage_events
                (project_stage_id, from_status, to_status, occurred_at,
                 resulting_revision, created_at)
            VALUES (?, 'pending', 'in_progress', ?, 2, ?)
            """,
            (stage_id, timestamp, timestamp),
        )
        before_stages = [
            tuple(row)
            for row in connection.execute("SELECT * FROM project_stages ORDER BY id")
        ]
        before_events = [
            tuple(row)
            for row in connection.execute(
                "SELECT * FROM project_stage_events ORDER BY id"
            )
        ]
        applied = apply_migrations(connection, migrations_dir)
        assert applied == ["025_project_categories"]
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT status, project_category FROM projects ORDER BY id"
            )
        ] == [("active", "standard"), ("archived", "standard")]
        assert [
            tuple(row)
            for row in connection.execute("SELECT * FROM project_stages ORDER BY id")
        ] == before_stages
        assert [
            tuple(row)
            for row in connection.execute(
                "SELECT * FROM project_stage_events ORDER BY id"
            )
        ] == before_events
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert apply_migrations(connection, migrations_dir) == []
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("DELETE FROM project_stage_events")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE projects SET project_category = 'invalid'")
        connection.execute(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name,
                 project_category, created_at, updated_at)
            VALUES (3, 'TRADE', 'trade', 1, '升级后贸易项目', 'trade', ?, ?)
            """,
            (timestamp, timestamp),
        )
        assert [
            (row["stage_code"], row["sequence"])
            for row in connection.execute(
                "SELECT stage_code, sequence FROM project_stages WHERE project_id = 3 ORDER BY sequence"
            )
        ] == [
            ("contract", 1),
            ("advance_payment", 2),
            ("procurement", 3),
            ("acceptance", 4),
            ("final_payment", 5),
        ]
    finally:
        connection.close()
