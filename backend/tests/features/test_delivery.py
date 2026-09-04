from __future__ import annotations

import importlib
import json
import sqlite3
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.features import files

ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 2, 1, 4, 0, tzinfo=timezone.utc)


class DeliveryTestClient(TestClient):
    def post(self, url: str, **kwargs: Any):  # type: ignore[no-untyped-def]
        if "headers" not in kwargs:
            kwargs["headers"] = {"Idempotency-Key": str(uuid.uuid4())}
        return super().post(url, **kwargs)


@dataclass
class Harness:
    app: FastAPI
    database_path: Path
    settings: Settings

    def client(
        self,
        *,
        authenticated: bool = True,
        raise_server_exceptions: bool = True,
    ) -> TestClient:
        client = DeliveryTestClient(
            self.app, raise_server_exceptions=raise_server_exceptions
        )
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    delivery = importlib.import_module("backend.app.features.delivery")
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    timestamp = NOW.isoformat()
    try:
        apply_migrations(connection, ROOT / "backend" / "migrations")
        connection.execute(
            "INSERT INTO companies (id, name, created_at, updated_at) VALUES (1, '客户', ?, ?)",
            (timestamp, timestamp),
        )
        connection.executemany(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name, status,
                 archived_at, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            [
                (1, "P-001", "p-001", "项目一", "active", None, timestamp, timestamp),
                (2, "P-002", "p-002", "项目二", "active", None, timestamp, timestamp),
                (
                    3,
                    "P-OLD",
                    "p-old",
                    "旧项目",
                    "archived",
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            ],
        )
        for identifier, code in ((1, "P-001"), (2, "P-002")):
            connection.execute(
                """
                INSERT INTO documents
                    (id, project_code, category, logical_name, revision,
                     created_at, updated_at)
                VALUES (?, ?, 'acceptance', ?, 1, ?, ?)
                """,
                (identifier, code, f"附件{identifier}", timestamp, timestamp),
            )
            connection.execute(
                """
                INSERT INTO document_versions
                    (id, document_id, version_number, original_filename,
                     content_type, stored_relative_path, size_bytes, sha256,
                     created_at)
                VALUES (?, ?, 1, 'proof.jpg', 'image/jpeg', ?, 1, ?, ?)
                """,
                (
                    identifier,
                    identifier,
                    f"delivery/{identifier}.jpg",
                    "b" * 64,
                    timestamp,
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
        delivery.create_delivery_router(
            get_connection, lambda: settings, clock=lambda: NOW
        )
    )
    return Harness(app, database_path, settings)


def _commissioning_payload() -> dict[str, object]:
    return {
        "started_at": "2026-01-30T08:00:00+08:00",
        "ended_at": None,
        "status": "in_progress",
        "summary": "联机调试",
        "issues": None,
        "next_action": "继续测试",
        "notes": None,
        "document_version_ids": [1],
    }


def _change_payload() -> dict[str, object]:
    return {
        "source": "site_condition",
        "title": "增加护栏",
        "description": "现场要求增加护栏",
        "reason": "安全要求",
        "contract_delta_cents": 10_000,
        "estimated_cost_delta_cents": 6_000,
        "schedule_delta_days": 2,
        "proposed_on": "2026-01-30",
        "notes": None,
        "document_version_ids": [1],
    }


def _invoice_payload() -> dict[str, object]:
    return {
        "invoice_type": "contract_payment",
        "status": "recorded",
        "requested_on": "2026-01-20",
        "recorded_on": "2026-01-25",
        "invoice_number": "INV-001",
        "amount_cents": 300_000,
        "counterparty_name": "测试客户",
        "notes": None,
        "document_version_ids": [1],
    }


def _after_sales_payload() -> dict[str, object]:
    return {
        "reported_on": "2026-02-01",
        "service_on": None,
        "reason": "传感器误报",
        "contact_name": "王工",
        "contact_phone": "13800000000",
        "coverage_type": "paid",
        "notes": None,
    }


def _client_at(harness: Harness, current: datetime) -> DeliveryTestClient:
    delivery = importlib.import_module("backend.app.features.delivery")

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(harness.database_path)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(
        delivery.create_delivery_router(
            get_connection, lambda: harness.settings, clock=lambda: current
        )
    )
    client = DeliveryTestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_session_token(harness.settings.session_secret),
    )
    return client


def test_authentication_precedes_body_validation(harness: Harness) -> None:
    with harness.client(authenticated=False) as client:
        response = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            content=b"bad-json",
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 401


def test_delivery_migration_adds_immutable_events_and_warranty_fact(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(after_sales_cases)")
        }
        connection.execute(
            """
            INSERT INTO delivery_transition_events
                (project_id, resource_type, resource_id, from_status, to_status,
                 effective_at, reason, resolution, created_at)
            VALUES (1, 'engineering_change', 99, 'proposed', 'approved',
                    '2026-02-01', '通过', NULL, ?)
            """,
            (NOW.isoformat(),),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE delivery_transition_events SET reason = '修改' WHERE resource_id = 99"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "DELETE FROM delivery_transition_events WHERE resource_id = 99"
            )
    finally:
        connection.close()

    assert "is_under_warranty" in columns


def test_delivery_migration_backfills_historical_warranty_fact(
    tmp_path: Path,
) -> None:
    staged_migrations = tmp_path / "migrations"
    staged_migrations.mkdir()
    source_migrations = ROOT / "backend" / "migrations"
    for source in sorted(source_migrations.glob("*.sql")):
        if source.name >= "012_delivery_events.sql":
            continue
        (staged_migrations / source.name).write_bytes(source.read_bytes())

    database_path = tmp_path / "staged.sqlite3"
    connection = connect_database(database_path)
    timestamp = NOW.isoformat()
    try:
        applied = apply_migrations(connection, staged_migrations)
        assert applied[-1] == "011_procurement_audit"
        connection.execute(
            "INSERT INTO companies (id, name, created_at, updated_at) VALUES (1, '客户', ?, ?)",
            (timestamp, timestamp),
        )
        connection.executemany(
            """
            INSERT INTO projects
                (id, project_code, project_code_key, company_id, name, status,
                 created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, 'active', ?, ?)
            """,
            [
                (1, "P-001", "p-001", "项目一", timestamp, timestamp),
                (2, "P-002", "p-002", "项目二", timestamp, timestamp),
            ],
        )
        connection.execute(
            """
            INSERT INTO acceptances
                (id, project_id, acceptance_type, scheduled_on, performed_on,
                 status, created_at, updated_at)
            VALUES (1, 1, 'final', '2026-01-01', '2026-01-01',
                    'passed', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.execute(
            """
            INSERT INTO warranties
                (id, project_id, acceptance_id, starts_on, duration_months,
                 ends_on, created_at, updated_at)
            VALUES (1, 1, 1, '2026-01-01', 1, '2026-02-01', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.executemany(
            """
            INSERT INTO after_sales_cases
                (id, project_id, reported_on, reason, coverage_type,
                 created_at, updated_at)
            VALUES (?, ?, ?, '历史售后', ?, ?, ?)
            """,
            [
                (1, 1, "2026-01-01", "paid", timestamp, timestamp),
                (2, 1, "2026-02-02", "warranty", timestamp, timestamp),
                (3, 2, "2026-01-15", "warranty", timestamp, timestamp),
            ],
        )

        migration = source_migrations / "012_delivery_events.sql"
        (staged_migrations / migration.name).write_bytes(migration.read_bytes())
        assert apply_migrations(connection, staged_migrations) == [
            "012_delivery_events"
        ]
        rows = connection.execute(
            "SELECT id, is_under_warranty FROM after_sales_cases ORDER BY id"
        ).fetchall()
    finally:
        connection.close()

    assert [(row["id"], row["is_under_warranty"]) for row in rows] == [
        (1, 1),
        (2, 0),
        (3, 0),
    ]


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/projects/P-001/commissioning-sessions", _commissioning_payload()),
        ("/api/projects/P-001/engineering-changes", _change_payload()),
        (
            "/api/projects/P-001/engineering-changes/1/transition",
            {
                "to_status": "approved",
                "effective_on": "2026-02-01",
                "reason": "确认",
                "expected_revision": 1,
            },
        ),
        (
            "/api/projects/P-001/acceptances",
            {"acceptance_type": "final", "scheduled_on": "2026-02-01", "notes": None},
        ),
        (
            "/api/projects/P-001/acceptances/1/complete",
            {
                "performed_on": "2026-02-01",
                "result": "failed",
                "notes": None,
                "document_version_ids": [],
                "warranty": None,
                "expected_revision": 1,
            },
        ),
        ("/api/projects/P-001/invoices", _invoice_payload()),
        (
            "/api/projects/P-001/invoices/1/void",
            {"reason": "作废", "expected_revision": 1},
        ),
        ("/api/projects/P-001/after-sales", _after_sales_payload()),
        (
            "/api/projects/P-001/after-sales/1/transition",
            {
                "to_status": "in_progress",
                "effective_at": "2026-02-01T12:00:00+08:00",
                "resolution": None,
                "reason": None,
                "expected_revision": 1,
            },
        ),
    ],
)
def test_all_planning_posts_require_strict_idempotency_key(
    harness: Harness, path: str, payload: dict[str, object]
) -> None:
    with harness.client() as client:
        response = client.post(path, headers={}, json=payload)
    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_IDEMPOTENCY_KEY"


def test_all_planning_posts_replay_conflict_and_survive_archive(
    harness: Harness,
) -> None:
    operations: list[tuple[str, dict[str, object], str, dict[str, object]]] = []

    def perform(
        client: TestClient,
        path: str,
        payload: dict[str, object],
        changed: dict[str, object],
    ) -> dict[str, object]:
        key = str(uuid.uuid4())
        headers = {"Idempotency-Key": key}
        first = client.post(path, headers=headers, json=payload)
        assert first.status_code in {200, 201}, first.text
        replay = client.post(path, headers=headers, json=payload)
        assert replay.status_code == first.status_code
        assert replay.json() == first.json()
        conflict = client.post(path, headers=headers, json=payload | changed)
        assert conflict.status_code == 409
        assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
        body = first.json()
        operations.append((path, payload, key, body))
        return body

    with harness.client() as client:
        commissioning = perform(
            client,
            "/api/projects/P-001/commissioning-sessions",
            _commissioning_payload(),
            {"notes": "不同请求"},
        )
        change = perform(
            client,
            "/api/projects/P-001/engineering-changes",
            _change_payload(),
            {"notes": "不同请求"},
        )
        perform(
            client,
            f"/api/projects/P-001/engineering-changes/{change['id']}/transition",
            {
                "to_status": "approved",
                "effective_on": "2026-02-01",
                "reason": "客户书面确认",
                "expected_revision": change["revision"],
            },
            {"reason": "不同原因"},
        )
        acceptance = perform(
            client,
            "/api/projects/P-001/acceptances",
            {"acceptance_type": "final", "scheduled_on": "2026-01-31", "notes": None},
            {"notes": "不同请求"},
        )
        perform(
            client,
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            {
                "performed_on": "2026-01-31",
                "result": "passed",
                "notes": "通过",
                "document_version_ids": [1],
                "warranty": {
                    "starts_on": "2026-01-31",
                    "duration_months": 1,
                    "renewal_price_cents": None,
                    "notes": None,
                },
                "expected_revision": acceptance["revision"],
            },
            {"notes": "不同请求"},
        )
        invoice = perform(
            client,
            "/api/projects/P-001/invoices",
            _invoice_payload(),
            {"notes": "不同请求"},
        )
        perform(
            client,
            f"/api/projects/P-001/invoices/{invoice['id']}/void",
            {"reason": "冲红重开", "expected_revision": invoice["revision"]},
            {"reason": "不同原因"},
        )
        after_sales = perform(
            client,
            "/api/projects/P-001/after-sales",
            _after_sales_payload() | {"coverage_type": "paid"},
            {"notes": "不同请求"},
        )
        assert after_sales["is_under_warranty"] is True
        perform(
            client,
            f"/api/projects/P-001/after-sales/{after_sales['id']}/transition",
            {
                "to_status": "completed",
                "effective_at": "2026-02-02T10:00:00+08:00",
                "resolution": "更换传感器",
                "reason": "现场修复",
                "expected_revision": after_sales["revision"],
            },
            {"reason": "不同原因"},
        )
        assert commissioning["id"] == 1

        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 1",
                (NOW.isoformat(),),
            )
        finally:
            connection.close()

        for path, payload, key, expected in operations:
            replay = client.post(
                path.replace("P-001", "p-001"),
                headers={"Idempotency-Key": key},
                json=payload,
            )
            assert replay.status_code in {200, 201}
            assert replay.json() == expected

    connection = connect_database(harness.database_path)
    try:
        assert apply_migrations(connection, ROOT / "backend" / "migrations") == []
        events = connection.execute(
            """
            SELECT resource_type, from_status, to_status, effective_at, reason, resolution
            FROM delivery_transition_events ORDER BY id
            """
        ).fetchall()
        idempotency_count = connection.execute(
            "SELECT COUNT(*) FROM idempotency_requests WHERE resource_type IN "
            "('commissioning_session', 'engineering_change', 'acceptance', 'invoice', 'after_sales')"
        ).fetchone()[0]
    finally:
        connection.close()

    assert [tuple(row) for row in events] == [
        (
            "engineering_change",
            "proposed",
            "approved",
            "2026-02-01",
            "客户书面确认",
            None,
        ),
        (
            "after_sales",
            "open",
            "completed",
            "2026-02-02T02:00:00+00:00",
            "现场修复",
            "更换传感器",
        ),
    ]
    assert idempotency_count == 9


def test_drawing_signoffs_return_fixed_pair_and_support_strict_upsert(
    harness: Harness,
) -> None:
    with harness.client() as client:
        initial = client.get("/api/projects/P-001/drawing-signoffs")
        saved = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            json={
                "status": "confirmed",
                "confirmed_on": "2026-01-31",
                "not_required_reason": None,
                "notes": "已会签",
                "document_version_ids": [1],
                "expected_revision": None,
            },
        )
        stale = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            json={
                "status": "not_required",
                "confirmed_on": None,
                "not_required_reason": "无需机械图",
                "notes": None,
                "document_version_ids": [],
                "expected_revision": 99,
            },
        )
        cross_project = client.put(
            "/api/projects/P-001/drawing-signoffs/electrical",
            json={
                "status": "confirmed",
                "confirmed_on": "2026-01-31",
                "not_required_reason": None,
                "notes": None,
                "document_version_ids": [2],
                "expected_revision": None,
            },
        )

    assert [item["discipline"] for item in initial.json()] == [
        "mechanical",
        "electrical",
    ]
    assert initial.json()[0]["status"] == "pending"
    assert saved.status_code == 200
    assert saved.json()["document_version_ids"] == [1]
    assert stale.status_code == 409
    assert stale.json()["current_revision"] == 1
    assert cross_project.status_code == 422


def test_drawing_signoff_multipart_creates_managed_documents_and_replays(
    harness: Harness,
) -> None:
    key = "71000000-0000-4000-8000-000000000001"
    payload = {
        "status": "confirmed",
        "confirmed_on": "2026-01-31",
        "not_required_reason": None,
        "notes": "最终版会签图",
        "document_version_ids": [1],
        "expected_revision": None,
    }
    uploads = [
        ("files", ("机械最终版.dwg", b"cad-one", "application/acad")),
        ("files", ("会签扫描.pdf", b"signed-pdf", "application/pdf")),
    ]
    with harness.client() as client:
        created = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        replay = client.put(
            "/api/projects/p-001/drawing-signoffs/mechanical",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        conflict = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files={"files": ("机械最终版.dwg", b"different", "application/acad")},
        )

    assert created.status_code == replay.status_code == 200, created.text
    assert replay.json() == created.json()
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    uploaded_ids = created.json()["document_version_ids"][1:]
    assert len(uploaded_ids) == 2
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT versions.original_filename, versions.managed_filename,
                   versions.stored_relative_path, documents.category
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id IN (?, ?)
            ORDER BY versions.id
            """,
            uploaded_ids,
        ).fetchall()
        assert connection.execute(
            "SELECT COUNT(*) FROM drawing_signoffs WHERE project_id = 1"
        ).fetchone()[0] == 1
    finally:
        connection.close()
    assert [row["managed_filename"] for row in rows] == [
        "P-001_机械会签_20260131_01.dwg",
        "P-001_机械会签_20260131_02.pdf",
    ]
    assert [row["original_filename"] for row in rows] == [
        "机械最终版.dwg",
        "会签扫描.pdf",
    ]
    assert all(row["category"] == "mechanical_signoff" for row in rows)
    for row in rows:
        stored = harness.settings.data_dir / row["stored_relative_path"]
        assert stored.is_file()
        assert stored.name == row["managed_filename"]


def test_drawing_signoff_multipart_database_failure_rolls_back_and_cleans_files(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_signoff_attachment_version
            BEFORE INSERT ON document_versions
            BEGIN
                SELECT RAISE(ABORT, 'injected signoff attachment failure');
            END
            """
        )
    finally:
        connection.close()
    payload = {
        "status": "confirmed",
        "confirmed_on": "2026-01-31",
        "not_required_reason": None,
        "notes": None,
        "document_version_ids": [],
        "expected_revision": None,
    }
    with harness.client(raise_server_exceptions=False) as client:
        response = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            data={"payload": json.dumps(payload)},
            files={"files": ("final.dwg", b"drawing", "application/acad")},
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM drawing_signoffs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM workforce_document_links").fetchone()[0] == 0
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


@pytest.mark.parametrize(
    ("path", "payload", "filename", "expected_category", "expected_managed_name"),
    [
        (
            "/api/projects/P-001/commissioning-sessions",
            _commissioning_payload() | {"document_version_ids": []},
            "现场调试记录.pdf",
            "commissioning",
            "P-001_调试_20260130_01.pdf",
        ),
        (
            "/api/projects/P-001/engineering-changes",
            _change_payload() | {"document_version_ids": []},
            "增补确认单.docx",
            "technical_agreement",
            "P-001_工程变更_20260130_01.docx",
        ),
    ],
)
def test_commissioning_and_change_create_accept_direct_attachments(
    harness: Harness,
    path: str,
    payload: dict[str, object],
    filename: str,
    expected_category: str,
    expected_managed_name: str,
) -> None:
    key = str(uuid.uuid4())
    uploads = {"files": (filename, b"business-proof", "application/octet-stream")}
    with harness.client() as client:
        created = client.post(
            path,
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        replay = client.post(
            path.replace("P-001", "p-001"),
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )

    assert created.status_code == replay.status_code == 201, created.text
    assert replay.json() == created.json()
    version_ids = created.json()["document_version_ids"]
    assert len(version_ids) == 1
    connection = connect_database(harness.database_path)
    try:
        row = connection.execute(
            """
            SELECT versions.original_filename, versions.managed_filename,
                   versions.stored_relative_path, documents.category
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id = ?
            """,
            (version_ids[0],),
        ).fetchone()
    finally:
        connection.close()
    assert row is not None
    assert row["original_filename"] == filename
    assert row["managed_filename"] == expected_managed_name
    assert row["category"] == expected_category
    stored = harness.settings.data_dir / row["stored_relative_path"]
    assert stored.is_file()
    assert stored.name == expected_managed_name


def test_legacy_acceptance_put_cannot_bypass_reason_and_idempotency(
    harness: Harness,
) -> None:
    with harness.client() as client:
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-02-10",
                "notes": None,
            },
        ).json()
        response = client.put(
            f"/api/projects/P-001/acceptances/{acceptance['id']}",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-02-12",
                "notes": "绕过原因",
                "expected_revision": acceptance["revision"],
            },
        )
        listed = client.get("/api/projects/P-001/acceptances").json()

    assert response.status_code == 404
    assert listed["items"][0]["scheduled_on"] == "2026-02-10"


def test_commissioning_create_update_list_filter_revision_and_isolation(
    harness: Harness,
) -> None:
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/commissioning-sessions",
            json=_commissioning_payload(),
        )
        body = created.json()
        update_payload = _commissioning_payload() | {
            "status": "completed",
            "ended_at": "2026-01-31T18:00:00+08:00",
            "expected_revision": body["revision"],
        }
        updated = client.put(
            f"/api/projects/P-001/commissioning-sessions/{body['id']}",
            json=update_payload,
        )
        listing = client.get(
            "/api/projects/P-001/commissioning-sessions?page=1&page_size=1&status=completed"
        )
        isolated = client.put(
            f"/api/projects/P-002/commissioning-sessions/{body['id']}",
            json=update_payload,
        )

    assert created.status_code == 201
    assert body["started_at"] == "2026-01-30T00:00:00+00:00"
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert listing.json()["total"] == 1
    assert isolated.status_code == 404


def test_engineering_change_crud_numbering_and_legal_transitions(
    harness: Harness,
) -> None:
    with harness.client() as client:
        first = client.post(
            "/api/projects/P-001/engineering-changes", json=_change_payload()
        )
        second = client.post(
            "/api/projects/P-001/engineering-changes", json=_change_payload()
        )
        first_body = first.json()
        updated = client.put(
            f"/api/projects/P-001/engineering-changes/{first_body['id']}",
            json=_change_payload()
            | {"title": "增加安全护栏", "expected_revision": first_body["revision"]},
        )
        approved = client.post(
            f"/api/projects/P-001/engineering-changes/{first_body['id']}/transition",
            json={
                "to_status": "approved",
                "effective_on": "2026-01-31",
                "reason": "客户确认",
                "expected_revision": updated.json()["revision"],
            },
        )
        illegal = client.post(
            f"/api/projects/P-001/engineering-changes/{first_body['id']}/transition",
            json={
                "to_status": "rejected",
                "effective_on": "2026-02-01",
                "reason": "错误流转",
                "expected_revision": approved.json()["revision"],
            },
        )
        listing = client.get(
            "/api/projects/P-001/engineering-changes?status=approved&page=1&page_size=20"
        )

    assert first.status_code == second.status_code == 201
    assert (first.json()["change_number"], second.json()["change_number"]) == (1, 2)
    assert updated.json()["title"] == "增加安全护栏"
    assert approved.json()["status"] == "approved"
    assert illegal.status_code == 409
    assert listing.json()["total"] == 1


def test_final_acceptance_and_warranty_are_atomic_and_use_calendar_months(
    harness: Harness,
) -> None:
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        )
        acceptance = created.json()
        completed = client.post(
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            json={
                "performed_on": "2026-01-31",
                "result": "passed",
                "notes": "验收通过",
                "document_version_ids": [1],
                "warranty": {
                    "starts_on": "2026-01-31",
                    "duration_months": 1,
                    "renewal_price_cents": 50_000,
                    "notes": None,
                },
                "expected_revision": acceptance["revision"],
            },
        )
        warranty = client.get("/api/projects/P-001/warranty")

    assert created.status_code == 201
    assert completed.status_code == 200
    assert completed.json()["acceptance"]["status"] == "passed"
    assert completed.json()["warranty"]["ends_on"] == "2026-02-28"
    assert warranty.json()["status"] == "expiring"
    assert warranty.json()["days_remaining"] == 27


def test_scheduled_acceptance_reschedule_is_idempotent_and_audited(
    harness: Harness,
) -> None:
    key = "71100000-0000-4000-8000-000000000098"
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "pre_acceptance",
                "scheduled_on": "2026-02-10",
                "notes": "原计划",
            },
        ).json()
        payload = {
            "acceptance_type": "final",
            "scheduled_on": "2026-02-15",
            "notes": "客户改期",
            "reason": "客户要求延后验收",
            "expected_revision": created["revision"],
        }
        updated = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/reschedule",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/reschedule",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        stale = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/reschedule",
            json={
                **payload,
                "scheduled_on": "2026-02-20",
                "expected_revision": created["revision"],
            },
        )

    assert updated.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == updated.json()
    assert updated.json()["acceptance_type"] == "final"
    assert updated.json()["scheduled_on"] == "2026-02-15"
    assert updated.json()["notes"] == "客户改期"
    assert updated.json()["revision"] == created["revision"] + 1
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    connection = connect_database(harness.database_path)
    try:
        event = connection.execute(
            "SELECT * FROM acceptance_reschedule_events WHERE acceptance_id = ?",
            (created["id"],),
        ).fetchone()
        assert event["previous_scheduled_on"] == "2026-02-10"
        assert event["scheduled_on"] == "2026-02-15"
        assert event["previous_acceptance_type"] == "pre_acceptance"
        assert event["acceptance_type"] == "final"
        assert event["reason"] == "客户要求延后验收"
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE acceptance_reschedule_events SET reason = 'tampered' WHERE id = ?",
                (event["id"],),
            )
    finally:
        connection.close()


def test_acceptance_cancel_is_idempotent_audited_and_cannot_be_completed(
    harness: Harness,
) -> None:
    key = "71100000-0000-4000-8000-000000000099"
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "pre_acceptance",
                "scheduled_on": "2026-02-10",
                "notes": None,
            },
        ).json()
        payload = {
            "cancelled_on": "2026-02-08",
            "reason": "客户延期，原验收计划作废",
            "expected_revision": created["revision"],
        }
        cancelled = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/cancel",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/cancel",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        reschedule_cancelled = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/reschedule",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "acceptance_type": "pre_acceptance",
                "scheduled_on": "2026-02-20",
                "notes": None,
                "reason": "取消后误操作改期",
                "expected_revision": cancelled.json()["revision"],
            },
        )
        complete = client.post(
            f"/api/projects/P-001/acceptances/{created['id']}/complete",
            json={
                "performed_on": "2026-02-10",
                "result": "failed",
                "notes": None,
                "document_version_ids": [],
                "warranty": None,
                "expected_revision": cancelled.json()["revision"],
            },
        )

    connection = connect_database(harness.database_path)
    try:
        event = connection.execute(
            "SELECT * FROM acceptance_transition_events WHERE acceptance_id = ?",
            (created["id"],),
        ).fetchone()
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE acceptance_transition_events SET reason = 'tampered' WHERE id = ?",
                (event["id"],),
            )
    finally:
        connection.close()

    assert cancelled.status_code == replay.status_code == 200
    assert cancelled.json() == replay.json()
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["cancelled_at"] == "2026-02-08"
    assert cancelled.json()["cancel_reason"] == "客户延期，原验收计划作废"
    assert event["from_status"] == "scheduled"
    assert event["to_status"] == "cancelled"
    assert event["reason"] == "客户延期，原验收计划作废"
    assert reschedule_cancelled.status_code == 409
    assert reschedule_cancelled.json()["error_code"] == "ACCEPTANCE_LOCKED"
    assert complete.status_code == 409


def test_acceptance_completion_multipart_creates_managed_documents_and_replays(
    harness: Harness,
) -> None:
    key = "71100000-0000-4000-8000-000000000001"
    with harness.client() as client:
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        ).json()
        payload = {
            "performed_on": "2026-01-31",
            "result": "passed",
            "notes": "验收通过",
            "document_version_ids": [1],
            "warranty": {
                "starts_on": "2026-01-31",
                "duration_months": 12,
                "renewal_price_cents": 50_000,
                "notes": None,
            },
            "expected_revision": acceptance["revision"],
        }
        uploads = [
            ("files", ("验收单.pdf", b"acceptance-pdf", "application/pdf")),
            ("files", ("现场照片.jpg", b"acceptance-photo", "image/jpeg")),
        ]
        path = f"/api/projects/P-001/acceptances/{acceptance['id']}/complete"
        created = client.post(
            path,
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        replay = client.post(
            path.replace("P-001", "p-001"),
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        conflict = client.post(
            path,
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files={"files": ("验收单.pdf", b"different", "application/pdf")},
        )

    assert created.status_code == replay.status_code == 200, created.text
    assert replay.json() == created.json()
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    uploaded_ids = created.json()["acceptance"]["document_version_ids"][1:]
    assert len(uploaded_ids) == 2
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT versions.managed_filename, versions.stored_relative_path,
                   documents.category
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id IN (?, ?)
            ORDER BY versions.id
            """,
            uploaded_ids,
        ).fetchall()
    finally:
        connection.close()
    assert [row["managed_filename"] for row in rows] == [
        "P-001_验收_20260131_01.pdf",
        "P-001_验收_20260131_02.jpg",
    ]
    assert all(row["category"] == "acceptance" for row in rows)
    for row in rows:
        stored = harness.settings.data_dir / row["stored_relative_path"]
        assert stored.is_file()
        assert stored.name == row["managed_filename"]


def test_acceptance_completion_multipart_failure_is_atomic_and_cleans_files(
    harness: Harness,
) -> None:
    with harness.client() as client:
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        ).json()
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_acceptance_attachment_version
            BEFORE INSERT ON document_versions
            BEGIN
                SELECT RAISE(ABORT, 'injected acceptance attachment failure');
            END
            """
        )
    finally:
        connection.close()
    payload = {
        "performed_on": "2026-01-31",
        "result": "passed",
        "notes": None,
        "document_version_ids": [],
        "warranty": {
            "starts_on": "2026-01-31",
            "duration_months": 12,
            "renewal_price_cents": None,
            "notes": None,
        },
        "expected_revision": acceptance["revision"],
    }
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            data={"payload": json.dumps(payload)},
            files={"files": ("验收单.pdf", b"proof", "application/pdf")},
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        row = connection.execute(
            "SELECT status, performed_on, revision FROM acceptances WHERE id = ?",
            (acceptance["id"],),
        ).fetchone()
        assert tuple(row) == ("scheduled", None, 1)
        assert connection.execute("SELECT COUNT(*) FROM warranties").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM workforce_document_links").fetchone()[0] == 0
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_delivery_direct_upload_validation_failure_discards_staged_files(
    harness: Harness,
) -> None:
    with harness.client() as client:
        signoff = client.put(
            "/api/projects/P-001/drawing-signoffs/mechanical",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            data={
                "payload": json.dumps(
                    {
                        "status": "confirmed",
                        "confirmed_on": "not-a-date",
                        "not_required_reason": None,
                        "notes": None,
                        "document_version_ids": [],
                        "expected_revision": None,
                    }
                )
            },
            files={"files": ("final.dwg", b"drawing", "application/acad")},
        )
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "pre_acceptance",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        ).json()
        completion = client.post(
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            data={
                "payload": json.dumps(
                    {
                        "performed_on": "not-a-date",
                        "result": "passed",
                        "notes": None,
                        "document_version_ids": [],
                        "warranty": None,
                        "expected_revision": acceptance["revision"],
                    }
                )
            },
            files={"files": ("验收单.pdf", b"proof", "application/pdf")},
        )

    assert signoff.status_code == completion.status_code == 422
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]


def test_acceptance_document_failure_rolls_back_completion_and_warranty(
    harness: Harness,
) -> None:
    with harness.client() as client:
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        ).json()
        failed = client.post(
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            json={
                "performed_on": "2026-01-31",
                "result": "passed",
                "notes": None,
                "document_version_ids": [2],
                "warranty": {
                    "starts_on": "2026-01-31",
                    "duration_months": 12,
                    "renewal_price_cents": None,
                    "notes": None,
                },
                "expected_revision": acceptance["revision"],
            },
        )
        listing = client.get("/api/projects/P-001/acceptances")
        warranty = client.get("/api/projects/P-001/warranty")

    assert failed.status_code == 422
    assert listing.json()["items"][0]["status"] == "scheduled"
    assert warranty.status_code == 200 and warranty.json() is None


def test_warranty_put_updates_term_and_computes_not_started_status(
    harness: Harness,
) -> None:
    with harness.client() as client:
        acceptance = client.post(
            "/api/projects/P-001/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-01-31",
                "notes": None,
            },
        ).json()
        completed = client.post(
            f"/api/projects/P-001/acceptances/{acceptance['id']}/complete",
            json={
                "performed_on": "2026-01-31",
                "result": "passed_with_punch",
                "notes": None,
                "document_version_ids": [],
                "warranty": {
                    "starts_on": "2026-02-10",
                    "duration_months": 12,
                    "renewal_price_cents": None,
                    "notes": None,
                },
                "expected_revision": 1,
            },
        ).json()
        updated = client.put(
            "/api/projects/P-001/warranty",
            json={
                "starts_on": "2026-03-31",
                "duration_months": 1,
                "renewal_price_cents": 60_000,
                "notes": "续保参考",
                "expected_revision": completed["warranty"]["revision"],
            },
        )

    assert updated.status_code == 200
    assert updated.json()["ends_on"] == "2026-04-30"
    assert updated.json()["status"] == "not_started"


@pytest.mark.parametrize(
    ("current", "expected_status", "expected_days"),
    [
        (datetime(2025, 12, 31, 15, 59, tzinfo=timezone.utc), "not_started", 60),
        (datetime(2025, 12, 31, 16, 0, tzinfo=timezone.utc), "active", 59),
        (datetime(2026, 1, 28, 16, 0, tzinfo=timezone.utc), "active", 31),
        (datetime(2026, 1, 29, 16, 0, tzinfo=timezone.utc), "expiring", 30),
        (datetime(2026, 2, 28, 16, 0, tzinfo=timezone.utc), "expiring", 0),
        (datetime(2026, 3, 1, 16, 0, tzinfo=timezone.utc), "expired", -1),
    ],
)
def test_warranty_status_uses_shanghai_business_date_and_boundaries(
    harness: Harness,
    current: datetime,
    expected_status: str,
    expected_days: int,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            INSERT INTO acceptances
                (id, project_id, acceptance_type, scheduled_on, performed_on,
                 status, created_at, updated_at)
            VALUES (10, 1, 'final', '2026-01-01', '2026-01-01',
                    'passed', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO warranties
                (project_id, acceptance_id, starts_on, duration_months, ends_on,
                 created_at, updated_at)
            VALUES (1, 10, '2026-01-01', 2, '2026-03-01', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with _client_at(harness, current) as client:
        response = client.get("/api/projects/P-001/warranty")

    assert response.status_code == 200
    assert response.json()["status"] == expected_status
    assert response.json()["days_remaining"] == expected_days


def test_after_sales_warranty_fact_is_derived_and_recomputed_on_edit(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            INSERT INTO acceptances
                (id, project_id, acceptance_type, scheduled_on, performed_on,
                 status, created_at, updated_at)
            VALUES (10, 1, 'final', '2026-01-01', '2026-01-01',
                    'passed', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO warranties
                (project_id, acceptance_id, starts_on, duration_months, ends_on,
                 created_at, updated_at)
            VALUES (1, 10, '2026-01-01', 1, '2026-02-01', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        mismatch_on_create = client.post(
            "/api/projects/P-001/after-sales",
            json=_after_sales_payload()
            | {"reported_on": "2026-02-02", "coverage_type": "warranty"},
        )
        created = client.post(
            "/api/projects/P-001/after-sales",
            json=_after_sales_payload() | {"reported_on": "2026-02-02"},
        )
        mismatch_on_update = client.put(
            f"/api/projects/P-001/after-sales/{created.json()['id']}",
            json=_after_sales_payload()
            | {
                "reported_on": "2026-02-02",
                "coverage_type": "warranty",
                "expected_revision": created.json()["revision"],
            },
        )
        updated = client.put(
            f"/api/projects/P-001/after-sales/{created.json()['id']}",
            json=_after_sales_payload()
            | {
                "reported_on": "2026-02-01",
                "coverage_type": "warranty",
                "expected_revision": created.json()["revision"],
            },
        )

    assert mismatch_on_create.status_code == 409
    assert mismatch_on_create.json()["error_code"] == "WARRANTY_COVERAGE_MISMATCH"
    assert "coverage_type" in mismatch_on_create.json()["field_errors"]
    assert created.status_code == 201
    assert created.json()["is_under_warranty"] is False
    assert mismatch_on_update.status_code == 409
    assert mismatch_on_update.json()["error_code"] == "WARRANTY_COVERAGE_MISMATCH"
    assert "coverage_type" in mismatch_on_update.json()["field_errors"]
    assert updated.status_code == 200
    assert updated.json()["coverage_type"] == "warranty"
    assert updated.json()["is_under_warranty"] is True


def test_invoice_crud_filter_void_and_document_validation(harness: Harness) -> None:
    with harness.client() as client:
        created = client.post("/api/projects/P-001/invoices", json=_invoice_payload())
        invoice = created.json()
        updated = client.put(
            f"/api/projects/P-001/invoices/{invoice['id']}",
            json=_invoice_payload()
            | {
                "counterparty_name": "客户财务",
                "expected_revision": invoice["revision"],
            },
        )
        listing = client.get(
            "/api/projects/P-001/invoices?invoice_type=contract_payment&status=recorded"
        )
        voided = client.post(
            f"/api/projects/P-001/invoices/{invoice['id']}/void",
            json={
                "reason": "发票作废",
                "expected_revision": updated.json()["revision"],
            },
        )
        invalid = client.post(
            "/api/projects/P-001/invoices",
            json=_invoice_payload() | {"document_version_ids": [2]},
        )
        invalid_date_order = client.post(
            "/api/projects/P-001/invoices",
            json=_invoice_payload()
            | {"requested_on": "2026-01-30", "recorded_on": "2026-01-20"},
        )

    assert created.status_code == 201
    assert updated.json()["counterparty_name"] == "客户财务"
    assert listing.json()["total"] == 1
    assert voided.json()["status"] == "void"
    assert voided.json()["void_reason"] == "发票作废"
    assert invalid.status_code == 422
    assert invalid_date_order.status_code == 422


def test_requested_invoice_can_be_recorded_through_update(harness: Harness) -> None:
    requested_payload = _invoice_payload() | {
        "status": "requested",
        "recorded_on": None,
        "invoice_number": None,
        "amount_cents": None,
    }
    with harness.client() as client:
        created = client.post("/api/projects/P-001/invoices", json=requested_payload)
        recorded = client.put(
            f"/api/projects/P-001/invoices/{created.json()['id']}",
            json=_invoice_payload() | {"expected_revision": created.json()["revision"]},
        )

    assert created.status_code == 201
    assert created.json()["status"] == "requested"
    assert recorded.status_code == 200
    assert recorded.json()["status"] == "recorded"
    assert recorded.json()["recorded_on"] == "2026-01-25"
    assert recorded.json()["invoice_number"] == "INV-001"
    assert recorded.json()["amount_cents"] == 300_000


def test_duplicate_invoice_number_is_normalized_and_does_not_double_count(
    harness: Harness,
) -> None:
    with harness.client() as client:
        first = client.post("/api/projects/P-001/invoices", json=_invoice_payload())
        duplicate = client.post(
            "/api/projects/P-002/invoices",
            json=_invoice_payload()
            | {
                "invoice_number": "  inv-001  ",
                "amount_cents": 900_000,
                "document_version_ids": [2],
            },
        )
        summary = client.get("/api/projects/P-001/delivery-summary")

    assert first.status_code == 201
    assert duplicate.status_code == 409
    assert duplicate.json()["error_code"] == "INVOICE_NUMBER_CONFLICT"
    assert "invoice_number" in duplicate.json()["field_errors"]
    assert summary.json()["invoices"]["recorded_amount_cents"] == 300_000


@pytest.mark.parametrize("target_status", ["planned", "recorded"])
def test_invoice_update_rejects_duplicate_number_for_draft_and_registration(
    harness: Harness,
    target_status: str,
) -> None:
    draft = _invoice_payload() | {
        "status": "planned",
        "requested_on": None,
        "recorded_on": None,
        "invoice_number": None,
        "amount_cents": None,
        "document_version_ids": [],
    }
    with harness.client() as client:
        existing = client.post("/api/projects/P-001/invoices", json=_invoice_payload())
        created = client.post("/api/projects/P-002/invoices", json=draft)
        update_payload = draft | {
            "status": target_status,
            "invoice_number": "Inv-001",
            "expected_revision": created.json()["revision"],
        }
        if target_status == "recorded":
            update_payload |= {
                "requested_on": "2026-01-20",
                "recorded_on": "2026-01-25",
                "amount_cents": 600_000,
            }
        duplicate = client.put(
            f"/api/projects/P-002/invoices/{created.json()['id']}",
            json=update_payload,
        )
        listing = client.get("/api/projects/P-002/invoices")

    assert existing.status_code == 201
    assert duplicate.status_code == 409
    assert duplicate.json()["error_code"] == "INVOICE_NUMBER_CONFLICT"
    assert "invoice_number" in duplicate.json()["field_errors"]
    assert listing.json()["items"][0]["status"] == "planned"
    assert listing.json()["items"][0]["invoice_number"] is None


def test_voided_invoice_number_can_be_reused_without_double_counting(
    harness: Harness,
) -> None:
    with harness.client() as client:
        original = client.post("/api/projects/P-001/invoices", json=_invoice_payload()).json()
        voided = client.post(
            f"/api/projects/P-001/invoices/{original['id']}/void",
            json={"reason": "原票作废", "expected_revision": original["revision"]},
        )
        replacement = client.post(
            "/api/projects/P-001/invoices",
            json=_invoice_payload()
            | {"invoice_number": " inv-001 ", "amount_cents": 450_000},
        )
        summary = client.get("/api/projects/P-001/delivery-summary")

    assert voided.status_code == 200
    assert replacement.status_code == 201
    assert replacement.json()["invoice_number"] == "inv-001"
    assert summary.json()["invoices"] == {
        "count": 1,
        "recorded_amount_cents": 450_000,
    }


def test_concurrent_duplicate_invoice_creation_has_one_winner(
    harness: Harness,
) -> None:
    barrier = Barrier(2)

    def create(project_code: str) -> tuple[int, dict[str, object]]:
        payload = _invoice_payload() | {
            "invoice_number": "Concurrent-001" if project_code == "P-001" else " concurrent-001 ",
            "document_version_ids": [],
        }
        with harness.client() as client:
            barrier.wait(timeout=5)
            response = client.post(f"/api/projects/{project_code}/invoices", json=payload)
            return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, ("P-001", "P-002")))

    assert sorted(status for status, _ in results) == [201, 409]
    conflict = next(body for status, body in results if status == 409)
    assert conflict["error_code"] == "INVOICE_NUMBER_CONFLICT"
    assert "invoice_number" in conflict["field_errors"]
    connection = connect_database(harness.database_path)
    try:
        count = connection.execute(
            "SELECT COUNT(*) FROM project_invoices WHERE status <> 'void'"
        ).fetchone()[0]
    finally:
        connection.close()
    assert count == 1


def test_recorded_invoice_update_rejects_downgrade_and_formal_field_rewrite(
    harness: Harness,
) -> None:
    with harness.client() as client:
        created = client.post("/api/projects/P-001/invoices", json=_invoice_payload())
        invoice = created.json()
        downgraded = client.put(
            f"/api/projects/P-001/invoices/{invoice['id']}",
            json=_invoice_payload()
            | {
                "status": "requested",
                "recorded_on": None,
                "invoice_number": None,
                "amount_cents": None,
                "expected_revision": invoice["revision"],
            },
        )
        rewritten = client.put(
            f"/api/projects/P-001/invoices/{invoice['id']}",
            json=_invoice_payload()
            | {
                "recorded_on": "2026-01-26",
                "invoice_number": "INV-REWRITTEN",
                "amount_cents": 1,
                "expected_revision": invoice["revision"],
            },
        )
        listed = client.get("/api/projects/P-001/invoices")

    assert created.status_code == 201
    assert downgraded.status_code == 409
    assert downgraded.json()["error_code"] == "INVOICE_RECORDED"
    assert rewritten.status_code == 409
    assert rewritten.json()["error_code"] == "INVOICE_RECORDED"
    stored = listed.json()["items"][0]
    assert stored["status"] == "recorded"
    assert stored["recorded_on"] == "2026-01-25"
    assert stored["invoice_number"] == "INV-001"
    assert stored["amount_cents"] == 300_000
    assert stored["revision"] == invoice["revision"]


@pytest.mark.parametrize(
    "cleared_field", ("recorded_on", "invoice_number", "amount_cents")
)
def test_recorded_invoice_update_rejects_each_cleared_formal_field_as_conflict(
    harness: Harness,
    cleared_field: str,
) -> None:
    requested_payload = _invoice_payload() | {
        "status": "requested",
        "recorded_on": None,
        "invoice_number": None,
        "amount_cents": None,
    }
    with harness.client() as client:
        recorded = client.post(
            "/api/projects/P-001/invoices", json=_invoice_payload()
        ).json()
        requested = client.post(
            "/api/projects/P-001/invoices", json=requested_payload
        ).json()
        conflict = client.put(
            f"/api/projects/P-001/invoices/{recorded['id']}",
            json=_invoice_payload()
            | {
                cleared_field: None,
                "expected_revision": recorded["revision"],
            },
        )
        invalid_registration = client.put(
            f"/api/projects/P-001/invoices/{requested['id']}",
            json=_invoice_payload()
            | {
                cleared_field: None,
                "expected_revision": requested["revision"],
            },
        )

    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "INVOICE_RECORDED"
    assert invalid_registration.status_code == 422
    assert invalid_registration.json()["error_code"] == "INVALID_INVOICE_PAYLOAD"


def test_project_invoice_multipart_creates_managed_documents_and_replays(
    harness: Harness,
) -> None:
    key = "72000000-0000-4000-8000-000000000001"
    payload = _invoice_payload() | {
        "status": "requested",
        "recorded_on": None,
        "invoice_number": None,
    }
    uploads = [
        ("files", ("客户发票扫描.pdf", b"invoice-pdf", "application/pdf")),
        ("files", ("发票现场图.jpg", b"invoice-photo", "image/jpeg")),
    ]
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/invoices",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )
        replay = client.post(
            "/api/projects/p-001/invoices",
            headers={"Idempotency-Key": key},
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files=uploads,
        )

    assert created.status_code == replay.status_code == 201, created.text
    assert replay.json() == created.json()
    new_version_ids = created.json()["document_version_ids"][1:]
    assert len(new_version_ids) == 2
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute(
            """
            SELECT versions.original_filename, versions.managed_filename,
                   versions.stored_relative_path, documents.category,
                   documents.logical_name
            FROM document_versions AS versions
            JOIN documents ON documents.id = versions.document_id
            WHERE versions.id IN (?, ?)
            ORDER BY versions.id
            """,
            new_version_ids,
        ).fetchall()
        counts = (
            connection.execute("SELECT COUNT(*) FROM project_invoices").fetchone()[0],
            connection.execute(
                "SELECT COUNT(*) FROM documents WHERE category = 'invoice'"
            ).fetchone()[0],
        )
    finally:
        connection.close()
    assert counts == (1, 2)
    assert [row["managed_filename"] for row in rows] == [
        "P-001_销项发票_20260120_01.pdf",
        "P-001_销项发票_20260120_02.jpg",
    ]
    assert [row["original_filename"] for row in rows] == [
        "客户发票扫描.pdf",
        "发票现场图.jpg",
    ]
    assert all(row["category"] == "invoice" for row in rows)
    assert len({row["logical_name"] for row in rows}) == 2
    for row in rows:
        stored = harness.settings.data_dir / row["stored_relative_path"]
        assert stored.is_file()
        assert stored.name == row["managed_filename"]


def test_project_invoice_image_only_creates_planned_record_for_later_completion(
    harness: Harness,
) -> None:
    payload = _invoice_payload() | {
        "status": "planned",
        "requested_on": None,
        "recorded_on": None,
        "invoice_number": None,
        "amount_cents": None,
        "counterparty_name": None,
        "document_version_ids": [],
    }
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/invoices",
            data={"payload": json.dumps(payload, ensure_ascii=False)},
            files={"files": ("销项发票.jpg", b"invoice-photo", "image/jpeg")},
        )

    assert created.status_code == 201, created.text
    assert created.json()["status"] == "planned"
    assert created.json()["requested_on"] is None
    assert created.json()["recorded_on"] is None
    assert created.json()["invoice_number"] is None
    assert created.json()["amount_cents"] is None
    assert len(created.json()["document_version_ids"]) == 1


def test_project_invoice_multipart_invalid_payload_cleans_staged_file(
    harness: Harness,
) -> None:
    with harness.client() as client:
        response = client.post(
            "/api/projects/P-001/invoices",
            data={
                "payload": json.dumps(_invoice_payload() | {"amount_cents": -1})
            },
            files={"files": ("valid.pdf", b"valid", "application/pdf")},
        )

    assert response.status_code == 422
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_project_invoice_json_and_zero_file_multipart_replay_same_response(
    harness: Harness,
) -> None:
    key = "72100000-0000-4000-8000-000000000001"
    payload = _invoice_payload() | {"document_version_ids": []}
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/invoices",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            "/api/projects/p-001/invoices",
            headers={"Idempotency-Key": key},
            files={
                "payload": (
                    None,
                    json.dumps(payload, ensure_ascii=False),
                    "application/json",
                )
            },
        )

    assert created.status_code == replay.status_code == 201, replay.text
    assert replay.json() == created.json()
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute(
            "SELECT COUNT(*) FROM project_invoices"
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_project_invoice_multipart_database_failure_rolls_back_everything(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_delivery_attachment_version
            BEFORE INSERT ON document_versions
            BEGIN
                SELECT RAISE(ABORT, 'injected attachment database failure');
            END
            """
        )
    finally:
        connection.close()
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects/P-001/invoices",
            data={
                "payload": json.dumps(
                    _invoice_payload() | {"document_version_ids": []}
                )
            },
            files={"files": ("invoice.pdf", b"invoice", "application/pdf")},
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute(
            "SELECT COUNT(*) FROM project_invoices"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM document_versions"
        ).fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM workforce_document_links"
        ).fetchone()[0] == 0
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_project_invoice_second_publish_failure_rolls_back_everything(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_publish = files.publish_staged_version
    calls = 0

    def fail_second_publish(*args: object, **kwargs: object):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected publish failure")
        return original_publish(*args, **kwargs)

    monkeypatch.setattr(files, "publish_staged_version", fail_second_publish)
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects/P-001/invoices",
            data={
                "payload": json.dumps(
                    _invoice_payload() | {"document_version_ids": []}
                )
            },
            files=[
                ("files", ("first.pdf", b"first", "application/pdf")),
                ("files", ("second.pdf", b"second", "application/pdf")),
            ],
        )

    assert response.status_code == 500
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute(
            "SELECT COUNT(*) FROM project_invoices"
        ).fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM document_versions"
        ).fetchone()[0] == 2
        assert connection.execute(
            "SELECT COUNT(*) FROM workforce_document_links"
        ).fetchone()[0] == 0
    finally:
        connection.close()
    assert not [
        path
        for path in (harness.settings.data_dir / "Projects").rglob("*")
        if path.is_file()
    ]
    assert not list((harness.settings.data_dir / "Temp").glob(".upload-*.tmp"))


def test_after_sales_crud_transition_rules_and_filters(harness: Harness) -> None:
    with harness.client() as client:
        created = client.post(
            "/api/projects/P-001/after-sales", json=_after_sales_payload()
        )
        case = created.json()
        updated = client.put(
            f"/api/projects/P-001/after-sales/{case['id']}",
            json=_after_sales_payload()
            | {"service_on": "2026-02-02", "expected_revision": case["revision"]},
        )
        invalid_complete = client.post(
            f"/api/projects/P-001/after-sales/{case['id']}/transition",
            json={
                "to_status": "completed",
                "effective_at": "2026-02-02T10:00:00+08:00",
                "resolution": None,
                "reason": None,
                "expected_revision": updated.json()["revision"],
            },
        )
        completed = client.post(
            f"/api/projects/P-001/after-sales/{case['id']}/transition",
            json={
                "to_status": "completed",
                "effective_at": "2026-02-02T10:00:00+08:00",
                "resolution": "更换传感器后恢复",
                "reason": None,
                "expected_revision": updated.json()["revision"],
            },
        )
        listing = client.get("/api/projects/P-001/after-sales?status=completed")
        invalid_date_order = client.post(
            "/api/projects/P-001/after-sales",
            json=_after_sales_payload()
            | {"reported_on": "2026-02-02", "service_on": "2026-02-01"},
        )

    assert created.status_code == 201
    assert invalid_complete.status_code == 422
    assert completed.status_code == 200
    assert completed.json()["completed_at"] == "2026-02-02T02:00:00+00:00"
    assert listing.json()["total"] == 1
    assert invalid_date_order.status_code == 422


def test_active_project_write_protection_and_pagination_overflow(
    harness: Harness,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
        archived = client.post(
            "/api/projects/P-OLD/acceptances",
            json={
                "acceptance_type": "final",
                "scheduled_on": "2026-02-01",
                "notes": None,
            },
        )
        overflow = client.get(
            "/api/projects/P-001/invoices?page=9223372036854775807&page_size=200"
        )
    assert archived.status_code == 409
    assert archived.json()["error_code"] == "PROJECT_ARCHIVED"
    assert overflow.status_code == 422


def test_count_and_rows_use_one_snapshot_while_second_connection_writes(
    harness: Harness,
) -> None:
    timestamp = NOW.isoformat()
    seed = connect_database(harness.database_path)
    try:
        seed.execute(
            """
            INSERT INTO project_invoices
                (project_id, invoice_type, status, amount_cents,
                 created_at, updated_at)
            VALUES (1, 'other', 'planned', 100, ?, ?)
            """,
            (timestamp, timestamp),
        )
    finally:
        seed.close()

    events: list[str] = []

    class SnapshotConnection(sqlite3.Connection):
        database_path: Path
        injected: bool

        def execute(self, sql: str, parameters: object = (), /):  # type: ignore[override]
            cursor = super().execute(sql, parameters)
            normalized = " ".join(sql.split()).upper()
            if normalized == "BEGIN":
                events.append("BEGIN")
            if (
                not self.injected
                and "SELECT COUNT(*) FROM PROJECT_INVOICES" in normalized
            ):
                self.injected = True
                writer = connect_database(self.database_path)
                try:
                    writer.execute(
                        """
                        INSERT INTO project_invoices
                            (project_id, invoice_type, status, amount_cents,
                             created_at, updated_at)
                        VALUES (1, 'other', 'planned', 200, ?, ?)
                        """,
                        (timestamp, timestamp),
                    )
                finally:
                    writer.close()
                events.append("WRITE_COMMITTED")
            return cursor

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            harness.database_path,
            timeout=5.0,
            isolation_level=None,
            check_same_thread=False,
            factory=SnapshotConnection,
        )
        connection.row_factory = sqlite3.Row
        connection.database_path = harness.database_path
        connection.injected = False
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    delivery = importlib.import_module("backend.app.features.delivery")
    app = FastAPI()
    app.include_router(
        delivery.create_delivery_router(
            get_connection, lambda: harness.settings, clock=lambda: NOW
        )
    )
    client = DeliveryTestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_session_token(harness.settings.session_secret),
    )
    with client:
        response = client.get("/api/projects/P-001/invoices?page=1&page_size=20")

    check = connect_database(harness.database_path)
    try:
        persisted = check.execute(
            "SELECT COUNT(*) FROM project_invoices WHERE project_id = 1"
        ).fetchone()[0]
    finally:
        check.close()

    assert events == ["BEGIN", "WRITE_COMMITTED"]
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert len(response.json()["items"]) == 1
    assert persisted == 2


@pytest.mark.parametrize(
    ("resource_type", "path"),
    [
        (
            "drawing_signoff",
            "/api/projects/P-001/drawing-signoffs/mechanical",
        ),
        (
            "commissioning_session",
            "/api/projects/P-001/commissioning-sessions/1",
        ),
        (
            "engineering_change",
            "/api/projects/P-001/engineering-changes/1",
        ),
        ("invoice", "/api/projects/P-001/invoices/1"),
        ("after_sales", "/api/projects/P-001/after-sales/1"),
    ],
)
def test_put_response_uses_pre_commit_attachment_snapshot(
    harness: Harness,
    resource_type: str,
    path: str,
) -> None:
    timestamp = NOW.isoformat()
    seed = connect_database(harness.database_path)
    try:
        seed.execute(
            """
            INSERT INTO documents
                (id, project_code, category, logical_name, revision,
                 created_at, updated_at)
            VALUES (3, 'P-001', 'acceptance', '并发附件', 1, ?, ?)
            """,
            (timestamp, timestamp),
        )
        seed.execute(
            """
            INSERT INTO document_versions
                (id, document_id, version_number, original_filename,
                 content_type, stored_relative_path, size_bytes, sha256, created_at)
            VALUES (3, 3, 1, 'concurrent.jpg', 'image/jpeg',
                    'delivery/concurrent.jpg', 1, ?, ?)
            """,
            ("c" * 64, timestamp),
        )
    finally:
        seed.close()

    if resource_type == "drawing_signoff":
        payload: dict[str, object] = {
            "status": "confirmed",
            "confirmed_on": "2026-02-01",
            "not_required_reason": None,
            "notes": None,
            "document_version_ids": [1],
            "expected_revision": None,
        }
    else:
        with harness.client() as setup_client:
            if resource_type == "commissioning_session":
                created = setup_client.post(
                    "/api/projects/P-001/commissioning-sessions",
                    json=_commissioning_payload(),
                )
                payload = _commissioning_payload() | {"expected_revision": 1}
            elif resource_type == "engineering_change":
                created = setup_client.post(
                    "/api/projects/P-001/engineering-changes",
                    json=_change_payload(),
                )
                payload = _change_payload() | {"expected_revision": 1}
            elif resource_type == "invoice":
                created = setup_client.post(
                    "/api/projects/P-001/invoices", json=_invoice_payload()
                )
                payload = _invoice_payload() | {"expected_revision": 1}
            else:
                created = setup_client.post(
                    "/api/projects/P-001/after-sales",
                    json=_after_sales_payload(),
                )
                payload = _after_sales_payload() | {"expected_revision": 1}
        assert created.status_code == 201, created.text

    if resource_type == "after_sales":
        seed = connect_database(harness.database_path)
        try:
            seed.execute(
                """
                INSERT INTO workforce_document_links
                    (project_id, resource_type, resource_id,
                     document_version_id, created_at)
                VALUES (1, 'after_sales', 1, 1, ?)
                """,
                (timestamp,),
            )
        finally:
            seed.close()

    events: list[str] = []

    class CommitHookConnection(sqlite3.Connection):
        database_path: Path
        injected: bool

        def commit(self) -> None:
            super().commit()
            if self.injected:
                return
            self.injected = True
            events.append("PRIMARY_COMMITTED")
            writer = connect_database(self.database_path)
            try:
                writer.execute(
                    """
                    DELETE FROM workforce_document_links
                    WHERE resource_type = ? AND resource_id = 1
                    """,
                    (resource_type,),
                )
                writer.execute(
                    """
                    INSERT INTO workforce_document_links
                        (project_id, resource_type, resource_id,
                         document_version_id, created_at)
                    VALUES (1, ?, 1, 3, ?)
                    """,
                    (resource_type, timestamp),
                )
            finally:
                writer.close()
            events.append("SECOND_CONNECTION_COMMITTED")

    def get_connection() -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            harness.database_path,
            timeout=5.0,
            isolation_level=None,
            check_same_thread=False,
            factory=CommitHookConnection,
        )
        connection.row_factory = sqlite3.Row
        connection.database_path = harness.database_path
        connection.injected = False
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    delivery = importlib.import_module("backend.app.features.delivery")
    app = FastAPI()
    app.include_router(
        delivery.create_delivery_router(
            get_connection, lambda: harness.settings, clock=lambda: NOW
        )
    )
    client = DeliveryTestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_session_token(harness.settings.session_secret),
    )
    with client:
        response = client.put(path, json=payload)

    check = connect_database(harness.database_path)
    try:
        persisted_links = [
            row[0]
            for row in check.execute(
                """
                SELECT document_version_id FROM workforce_document_links
                WHERE resource_type = ? AND resource_id = 1
                ORDER BY document_version_id
                """,
                (resource_type,),
            ).fetchall()
        ]
    finally:
        check.close()

    assert events == ["PRIMARY_COMMITTED", "SECOND_CONNECTION_COMMITTED"]
    assert response.status_code == 200
    assert response.json()["document_version_ids"] == [1]
    assert persisted_links == [3]


def test_delivery_summary_aggregates_final_payment_invoices_and_todos(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            INSERT INTO payment_terms
                (project_id, milestone, due_on, planned_amount_cents,
                 created_at, updated_at)
            VALUES (1, 'final', '2026-02-10', 500000, ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
        connection.execute(
            """
            INSERT INTO receipts
                (project_id, milestone, received_on, amount_cents,
                 payment_method, created_at, updated_at)
            VALUES (1, 'final', '2026-02-01', 200000, 'bank_transfer', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        client.post("/api/projects/P-001/invoices", json=_invoice_payload())
        client.post("/api/projects/P-001/after-sales", json=_after_sales_payload())
        summary = client.get("/api/projects/P-001/delivery-summary")

    body = summary.json()
    assert summary.status_code == 200
    assert body["final_payment"] == {
        "due_on": "2026-02-10",
        "planned_amount_cents": 500_000,
        "received_amount_cents": 200_000,
        "outstanding_amount_cents": 300_000,
    }
    assert body["invoices"]["recorded_amount_cents"] == 300_000
    assert body["after_sales"]["open_count"] == 1
    assert body["construction"] == {
        "labor_entry_count": 0,
        "labor_cost_cents": 0,
        "daily_report_count": 0,
        "confirmed_daily_report_count": 0,
        "latest_work_date": None,
        "material_cost_cents": 0,
    }
    assert "final_payment_outstanding" in body["todos"]
