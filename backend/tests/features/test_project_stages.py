from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity

NOW = datetime(2026, 8, 29, 9, 30, tzinfo=timezone.utc)
STAGE_CODES = [
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
STAGE_RESPONSE_FIELDS = {
    "stage_code",
    "status",
    "status_reason",
    "planned_start_on",
    "planned_end_on",
    "started_at",
    "blocked_at",
    "completed_at",
    "notes",
    "revision",
}


def _migrations_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations"


@dataclass(frozen=True)
class FixedClock:
    value: datetime = NOW

    def __call__(self) -> datetime:
        return self.value


@dataclass
class StageHarness:
    app: FastAPI
    database_path: Path
    settings: Settings
    request_write_guard: dict[str, bool]

    def client(self, *, authenticated: bool = True) -> TestClient:
        client = TestClient(self.app)
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


def _build_harness(tmp_path: Path) -> StageHarness:
    from backend.app.features.project_stages import create_project_stages_router

    database_path = tmp_path / "iapm.sqlite"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, _migrations_dir())
        connection.execute(
            """
            INSERT INTO companies (id, name, created_at, updated_at)
            VALUES (1, '示例公司', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO projects
                (project_code, project_code_key, company_id, name, description,
                 created_at, updated_at)
            VALUES (?, ?, 1, '自动化改造', NULL, ?, ?)
            """,
            (
                "SY-2026-001",
                project_code_identity("SY-2026-001"),
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()

    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path / "Data",
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="stage-test-secret",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        request_connection = connect_database(database_path)
        if request_write_guard["enabled"]:
            write_actions = {
                sqlite3.SQLITE_DELETE,
                sqlite3.SQLITE_INSERT,
                sqlite3.SQLITE_UPDATE,
            }

            def deny_writes(
                action: int,
                _arg1: str | None,
                _arg2: str | None,
                _database: str | None,
                _trigger: str | None,
            ) -> int:
                if action in write_actions:
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK

            request_connection.set_authorizer(deny_writes)
        try:
            yield request_connection
        finally:
            request_connection.close()

    def get_settings() -> Settings:
        return settings

    request_write_guard = {"enabled": False}
    app = FastAPI()
    app.include_router(
        create_project_stages_router(
            get_connection,
            get_settings,
            clock=FixedClock(),
        )
    )
    return StageHarness(
        app=app,
        database_path=database_path,
        settings=settings,
        request_write_guard=request_write_guard,
    )


def _schedule_payload(
    *,
    revision: int = 1,
    notes: str | None = "客户要求国庆前完成",
) -> dict[str, object]:
    return {
        "planned_start_on": "2026-09-01",
        "planned_end_on": "2026-09-30",
        "notes": notes,
        "expected_revision": revision,
    }


def _transition_payload(
    to_status: str,
    *,
    revision: int,
    reason: object = None,
    occurred_at: str = "2026-08-29T10:00:00+08:00",
) -> dict[str, object]:
    return {
        "to_status": to_status,
        "occurred_at": occurred_at,
        "reason": reason,
        "expected_revision": revision,
    }


def _idempotency_headers(key: str | None = None) -> dict[str, str]:
    return {"Idempotency-Key": key or str(uuid.uuid4())}


def test_migrations_create_continuous_p0_schema(tmp_path: Path) -> None:
    connection = connect_database(tmp_path / "migration.sqlite")
    try:
        applied = apply_migrations(connection, _migrations_dir())
        assert applied[:7] == [
            "001_foundation",
            "002_documents",
            "003_companies_projects",
            "004_project_code_identity",
            "005_project_workflow_documents",
            "006_commercial_finance",
            "007_dashboard_indexes",
        ]
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "project_stages",
            "project_stage_events",
            "idempotency_requests",
            "quotes",
            "contracts",
            "contract_project_allocations",
            "payment_terms",
            "receipts",
        } <= tables
        project_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info('projects')")
        }
        assert {"closure_type", "revision"} <= project_columns
        document_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info('documents')")
        }
        assert {"notes", "archived_at", "revision", "updated_at"} <= document_columns
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()


def test_receipt_allocation_must_belong_to_same_project(tmp_path: Path) -> None:
    connection = connect_database(tmp_path / "commercial.sqlite")
    try:
        apply_migrations(connection, _migrations_dir())
        connection.execute(
            "INSERT INTO companies (id, name, created_at, updated_at) VALUES (1, '客户', ?, ?)",
            (NOW.isoformat(), NOW.isoformat()),
        )
        for project_id in (1, 2):
            project_code = f"SY-2026-{project_id:03d}"
            connection.execute(
                """
                INSERT INTO projects
                    (id, project_code, project_code_key, company_id, name,
                     created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    project_id,
                    project_code,
                    project_code_identity(project_code),
                    f"项目 {project_id}",
                    NOW.isoformat(),
                    NOW.isoformat(),
                ),
            )
        connection.execute(
            """
            INSERT INTO contracts
                (id, contract_no, title, customer_company_id, total_amount_cents,
                 created_at, updated_at)
            VALUES (1, 'HT-001', '测试合同', 1, 10000, ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO contract_project_allocations
                (id, contract_id, project_id, amount_cents)
            VALUES (1, 1, 1, 10000)
            """
        )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO receipts
                    (project_id, contract_allocation_id, milestone, received_on,
                     amount_cents, payment_method, created_at, updated_at)
                VALUES (2, 1, 'advance', '2026-08-29', 1000, 'bank_transfer', ?, ?)
                """,
                (NOW.isoformat(), NOW.isoformat()),
            )
    finally:
        connection.close()


def test_document_schema_preserves_safe_defaults_for_existing_writes(
    tmp_path: Path,
) -> None:
    connection = connect_database(tmp_path / "documents.sqlite")
    try:
        apply_migrations(connection, _migrations_dir())
        document_id = connection.execute(
            """
            INSERT INTO documents
                (project_code, category, logical_name, created_at)
            VALUES ('SY-2026-001', 'planning_minutes', '首次纪要', ?)
            """,
            (NOW.isoformat(),),
        ).lastrowid
        connection.execute(
            """
            INSERT INTO document_versions
                (document_id, version_number, original_filename,
                 stored_relative_path, size_bytes, sha256, created_at)
            VALUES (?, 1, 'minutes.docx', 'Projects/SY-2026-001/minutes.docx',
                    8, ?, ?)
            """,
            (document_id, "a" * 64, NOW.isoformat()),
        )

        document = connection.execute(
            "SELECT revision, updated_at FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        version = connection.execute(
            "SELECT content_type FROM document_versions WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        assert document["revision"] == 1
        assert document["updated_at"]
        assert version["content_type"] == "application/octet-stream"
    finally:
        connection.close()


def test_stage_event_schema_enforces_reason_and_one_event_per_revision(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")

    connection = connect_database(harness.database_path)
    try:
        stage_id = connection.execute(
            "SELECT id FROM project_stages WHERE stage_code = 'planning'"
        ).fetchone()["id"]
        event_values = (
            stage_id,
            "pending",
            "skipped",
            NOW.isoformat(),
            2,
            NOW.isoformat(),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO project_stage_events
                    (project_stage_id, from_status, to_status, occurred_at,
                     resulting_revision, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                event_values,
            )
        connection.execute(
            """
            INSERT INTO project_stage_events
                (project_stage_id, from_status, to_status, reason, occurred_at,
                 resulting_revision, created_at)
            VALUES (?, 'pending', 'skipped', '无需此阶段', ?, 2, ?)
            """,
            (stage_id, NOW.isoformat(), NOW.isoformat()),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO project_stage_events
                    (project_stage_id, from_status, to_status, reason, occurred_at,
                     resulting_revision, created_at)
                VALUES (?, 'pending', 'skipped', '重复事件', ?, 2, ?)
                """,
                (stage_id, NOW.isoformat(), NOW.isoformat()),
            )
        for missing_reason in (None, "   "):
            with pytest.raises(
                sqlite3.IntegrityError,
                match="blocked stage reopen reason is required",
            ):
                connection.execute(
                    """
                    INSERT INTO project_stage_events
                        (project_stage_id, from_status, to_status, reason,
                         occurred_at, resulting_revision, created_at)
                    VALUES (?, 'blocked', 'in_progress', ?, ?, 3, ?)
                    """,
                    (stage_id, missing_reason, NOW.isoformat(), NOW.isoformat()),
                )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                """
                UPDATE project_stage_events
                SET reason = '篡改原因'
                WHERE project_stage_id = ? AND resulting_revision = 2
                """,
                (stage_id,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                """
                DELETE FROM project_stage_events
                WHERE project_stage_id = ? AND resulting_revision = 2
                """,
                (stage_id,),
            )
    finally:
        connection.close()


def test_get_requires_authentication_without_altering_stages(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)

    with harness.client(authenticated=False) as client:
        response = client.get("/api/projects/SY-2026-001/stages")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stages").fetchone()[0]
            == 18
        )
    finally:
        connection.close()


def test_authentication_precedes_path_and_body_validation(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)

    with harness.client(authenticated=False) as client:
        response = client.put(
            "/api/projects/%20/stages/not-a-stage",
            json={"unexpected": True},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}

    with harness.client(authenticated=False) as client:
        transition = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            json=_transition_payload("in_progress", revision=1),
        )

    assert transition.status_code == 401
    assert transition.json() == {"detail": "Authentication required"}


def test_project_insert_initializes_exact_stage_catalog_before_first_get(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    connection = connect_database(harness.database_path)
    try:
        before_get = connection.execute(
            "SELECT stage_code, sequence FROM project_stages ORDER BY sequence"
        ).fetchall()
    finally:
        connection.close()

    with harness.client() as client:
        first = client.get("/api/projects/sy-2026-001/stages")
        second = client.get("/api/projects/SY-2026-001/stages")

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    assert [stage["stage_code"] for stage in first.json()] == STAGE_CODES
    assert all(set(stage) == STAGE_RESPONSE_FIELDS for stage in first.json())
    assert all(stage["status"] == "pending" for stage in first.json())
    assert all(stage["revision"] == 1 for stage in first.json())
    assert [(row["stage_code"], row["sequence"]) for row in before_get] == [
        (code, sequence) for sequence, code in enumerate(STAGE_CODES, start=1)
    ]

    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            "SELECT stage_code, sequence FROM project_stages ORDER BY sequence"
        ).fetchall()
        assert [(row["stage_code"], row["sequence"]) for row in rows] == [
            (code, sequence) for sequence, code in enumerate(STAGE_CODES, start=1)
        ]
    finally:
        connection.close()


def test_missing_project_returns_fixed_404_without_creating_stages(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)

    with harness.client() as client:
        response = client.get("/api/projects/MISSING/stages")

    assert response.status_code == 404
    assert response.json()["detail"] == "Project not found"
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stages").fetchone()[0]
            == 18
        )
    finally:
        connection.close()


def test_put_schedule_normalizes_fields_and_increments_revision(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        assert client.get("/api/projects/SY-2026-001/stages").status_code == 200
        response = client.put(
            "/api/projects/SY-2026-001/stages/planning",
            json={**_schedule_payload(), "notes": "  客户要求国庆前完成  "},
        )

    assert response.status_code == 200
    assert response.json() == {
        "stage_code": "planning",
        "status": "pending",
        "status_reason": None,
        "planned_start_on": "2026-09-01",
        "planned_end_on": "2026-09-30",
        "started_at": None,
        "blocked_at": None,
        "completed_at": None,
        "notes": "客户要求国庆前完成",
        "revision": 2,
    }


def test_put_rejects_invalid_date_range_without_writing(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")
        response = client.put(
            "/api/projects/SY-2026-001/stages/planning",
            json={
                **_schedule_payload(),
                "planned_start_on": "2026-10-01",
                "planned_end_on": "2026-09-30",
            },
        )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid stage payload",
        "error_code": "INVALID_STAGE_PAYLOAD",
        "field_errors": {},
        "current_revision": None,
    }
    connection = connect_database(harness.database_path)
    try:
        row = connection.execute(
            "SELECT revision, planned_start_on FROM project_stages WHERE stage_code = 'planning'"
        ).fetchone()
        assert (row["revision"], row["planned_start_on"]) == (1, None)
    finally:
        connection.close()


def test_transition_flow_persists_timestamps_reason_and_events(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")
        started = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=1),
        )
        blocked = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("blocked", revision=2, reason="等待客户资料"),
        )
        resumed = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload(
                "in_progress",
                revision=3,
                reason="客户资料已经补齐",
            ),
        )
        completed = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("completed", revision=4),
        )
        reopened = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=5, reason="补录遗漏纪要"),
        )

    assert [
        response.status_code
        for response in (started, blocked, resumed, completed, reopened)
    ] == [
        200,
        200,
        200,
        200,
        200,
    ]
    assert started.json()["started_at"] == "2026-08-29T02:00:00+00:00"
    assert blocked.json()["blocked_at"] == "2026-08-29T02:00:00+00:00"
    assert blocked.json()["status_reason"] == "等待客户资料"
    assert resumed.json()["blocked_at"] is None
    assert completed.json()["completed_at"] == "2026-08-29T02:00:00+00:00"
    assert reopened.json()["completed_at"] is None
    assert reopened.json()["status_reason"] == "补录遗漏纪要"
    assert reopened.json()["revision"] == 6

    connection = connect_database(harness.database_path)
    try:
        events = connection.execute(
            """
            SELECT from_status, to_status, reason, resulting_revision
            FROM project_stage_events
            ORDER BY id
            """
        ).fetchall()
        assert [tuple(event) for event in events] == [
            ("pending", "in_progress", None, 2),
            ("in_progress", "blocked", "等待客户资料", 3),
            ("blocked", "in_progress", "客户资料已经补齐", 4),
            ("in_progress", "completed", None, 5),
            ("completed", "in_progress", "补录遗漏纪要", 6),
        ]
    finally:
        connection.close()


def test_block_skip_and_terminal_correction_require_reason(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")
        no_skip_reason = client.post(
            "/api/projects/SY-2026-001/stages/site_survey/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("skipped", revision=1),
        )
        skipped = client.post(
            "/api/projects/SY-2026-001/stages/site_survey/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("skipped", revision=1, reason="客户已有测绘图"),
        )
        no_reopen_reason = client.post(
            "/api/projects/SY-2026-001/stages/site_survey/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=2),
        )
        client.post(
            "/api/projects/SY-2026-001/stages/quotation/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=1),
        )
        no_block_reason = client.post(
            "/api/projects/SY-2026-001/stages/quotation/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("blocked", revision=2),
        )
        blocked = client.post(
            "/api/projects/SY-2026-001/stages/quotation/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("blocked", revision=2, reason="等待客户确认"),
        )
        no_resolve_reason = client.post(
            "/api/projects/SY-2026-001/stages/quotation/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=3),
        )

    for response in (
        no_skip_reason,
        no_reopen_reason,
        no_block_reason,
        no_resolve_reason,
    ):
        assert response.status_code == 422
        assert response.json()["detail"] == "Invalid stage transition"
    assert skipped.status_code == 200
    assert skipped.json()["status"] == "skipped"
    assert skipped.json()["completed_at"] == "2026-08-29T02:00:00+00:00"
    assert blocked.status_code == 200
    assert blocked.json()["status"] == "blocked"


def test_invalid_transition_is_409_and_does_not_add_event(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")
        response = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("completed", revision=1),
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Invalid stage transition"
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stage_events").fetchone()[
                0
            ]
            == 0
        )
    finally:
        connection.close()


def test_transition_payload_errors_keep_transition_contract(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        invalid_reason = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=1, reason=42),
        )
        invalid_revision = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(),
            json=_transition_payload("in_progress", revision=0),
        )

    for response in (invalid_reason, invalid_revision):
        assert response.status_code == 422
        assert response.json() == {
            "detail": "Invalid stage transition",
            "error_code": "INVALID_STAGE_TRANSITION",
            "field_errors": {},
            "current_revision": None,
        }


def test_transition_requires_one_uuid_idempotency_key(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    payload = _transition_payload("in_progress", revision=1)
    with harness.client() as client:
        missing = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            json=payload,
        )
        invalid = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers={"Idempotency-Key": "not-a-uuid"},
            json=payload,
        )

    assert missing.status_code == 422
    assert missing.json() == {
        "detail": "Invalid Idempotency-Key",
        "error_code": "INVALID_IDEMPOTENCY_KEY",
        "field_errors": {"Idempotency-Key": ["must occur once"]},
        "current_revision": None,
    }
    assert invalid.status_code == 422
    assert invalid.json() == {
        "detail": "Invalid Idempotency-Key",
        "error_code": "INVALID_IDEMPOTENCY_KEY",
        "field_errors": {"Idempotency-Key": ["must be a UUID"]},
        "current_revision": None,
    }


def test_transition_idempotency_replays_and_rejects_changed_payload(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    key = str(uuid.uuid4())
    payload = _transition_payload("in_progress", revision=1)
    with harness.client() as client:
        first = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(key),
            json=payload,
        )
        replay = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(key),
            json=payload,
        )
        changed = client.post(
            "/api/projects/SY-2026-001/stages/planning/transition",
            headers=_idempotency_headers(key),
            json={**payload, "reason": "相同 key 的不同内容"},
        )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert changed.status_code == 409
    assert changed.json() == {
        "detail": "Idempotency key was already used with different content",
        "error_code": "IDEMPOTENCY_CONFLICT",
        "field_errors": {},
        "current_revision": None,
    }
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute(
                "SELECT revision FROM project_stages WHERE stage_code = 'planning'"
            ).fetchone()["revision"]
            == 2
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stage_events").fetchone()[
                0
            ]
            == 1
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM idempotency_requests").fetchone()[
                0
            ]
            == 1
        )
    finally:
        connection.close()


def test_concurrent_transition_retries_with_same_key_create_one_event(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    key = str(uuid.uuid4())
    payload = _transition_payload("in_progress", revision=1)

    def transition(_attempt: int) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.post(
                "/api/projects/SY-2026-001/stages/planning/transition",
                headers=_idempotency_headers(key),
                json=payload,
            )
            return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(transition, range(2)))

    assert [status_code for status_code, _ in results] == [200, 200]
    assert results[0][1] == results[1][1]
    connection = connect_database(harness.database_path)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM project_stage_events").fetchone()[
                0
            ]
            == 1
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM idempotency_requests").fetchone()[
                0
            ]
            == 1
        )
    finally:
        connection.close()


def test_revision_conflict_returns_current_revision_without_writing(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")
        assert (
            client.put(
                "/api/projects/SY-2026-001/stages/planning",
                json=_schedule_payload(),
            ).status_code
            == 200
        )
        response = client.put(
            "/api/projects/SY-2026-001/stages/planning",
            json=_schedule_payload(revision=1, notes="陈旧更新"),
        )

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Resource was modified",
        "error_code": "REVISION_CONFLICT",
        "field_errors": {},
        "current_revision": 2,
    }


def test_concurrent_updates_with_same_revision_have_one_winner(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        client.get("/api/projects/SY-2026-001/stages")

    def update(notes: str) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.put(
                "/api/projects/SY-2026-001/stages/planning",
                json=_schedule_payload(notes=notes),
            )
            return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(update, ("方案甲", "方案乙")))

    assert sorted(status for status, _ in results) == [200, 409]
    conflict = next(body for status, body in results if status == 409)
    assert conflict["current_revision"] == 2


def test_newly_archived_project_first_get_is_read_only_and_returns_catalog(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            UPDATE projects
            SET status = 'archived', archive_reason = '已完工', archived_at = ?,
                updated_at = ?
            WHERE project_code_key = ?
            """,
            (NOW.isoformat(), NOW.isoformat(), project_code_identity("SY-2026-001")),
        )
    finally:
        connection.close()

    harness.request_write_guard["enabled"] = True
    with harness.client() as client:
        listed = client.get("/api/projects/SY-2026-001/stages")
        updated = client.put(
            "/api/projects/SY-2026-001/stages/planning",
            json=_schedule_payload(),
        )

    assert listed.status_code == 200
    assert [stage["stage_code"] for stage in listed.json()] == STAGE_CODES
    assert len(listed.json()) == 18
    assert updated.status_code == 409
    assert updated.json()["detail"] == "Project is archived"
