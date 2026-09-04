from __future__ import annotations

import importlib
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
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
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 31, 3, 0, tzinfo=timezone.utc)


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
        client = TestClient(self.app, raise_server_exceptions=raise_server_exceptions)
        if authenticated:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
        return client


@pytest.fixture
def harness(tmp_path: Path) -> Harness:
    site_operations = importlib.import_module("backend.app.features.site_operations")
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        timestamp = NOW.isoformat()
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
                    "归档项目",
                    "archived",
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            ],
        )
        connection.execute(
            """
            INSERT INTO workers (id, name, status, created_at, updated_at)
            VALUES (1, '张师傅', 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
        connection.executemany(
            """
            INSERT INTO crew_assignments
                (id, project_id, worker_id, role, scheduled_start_on,
                 scheduled_end_on, pay_basis, rate_cents, status,
                 created_at, updated_at)
            VALUES (?, ?, 1, '施工员', '2026-08-01', '2026-09-30',
                    'daily', 60000, 'active', ?, ?)
            """,
            [(1, 1, timestamp, timestamp), (2, 2, timestamp, timestamp)],
        )
        for identifier, project_code in ((1, "P-001"), (2, "P-002")):
            connection.execute(
                """
                INSERT INTO documents
                    (id, project_code, category, logical_name, revision,
                     created_at, updated_at)
                VALUES (?, ?, 'site_survey', ?, 1, ?, ?)
                """,
                (identifier, project_code, f"票据{identifier}", timestamp, timestamp),
            )
            connection.execute(
                """
                INSERT INTO document_versions
                    (id, document_id, version_number, original_filename,
                     content_type, stored_relative_path, size_bytes, sha256,
                     created_at)
                VALUES (?, ?, 1, 'receipt.jpg', 'image/jpeg', ?, 1, ?, ?)
                """,
                (identifier, identifier, f"test/{identifier}.jpg", "a" * 64, timestamp),
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
        site_operations.create_site_operations_router(
            get_connection, lambda: settings, clock=lambda: NOW
        )
    )
    return Harness(app, database_path, settings)


def _report_payload(expected_revision: int | None = None) -> dict[str, object]:
    return {
        "location": "一号车间",
        "weather": "晴",
        "work_summary": "安装机架",
        "blockers": None,
        "next_plan": "铺设线缆",
        "notes": None,
        "expected_revision": expected_revision,
    }


def _advance_payload(
    *,
    worker_id: int = 1,
    document_version_ids: list[int] | None = None,
) -> dict[str, object]:
    return {
        "worker_id": worker_id,
        "spent_on": "2026-08-30",
        "vendor_name": "五金店",
        "items": [
            {
                "name": "螺栓",
                "specification": "M8",
                "brand": None,
                "quantity": "2.500",
                "unit": "包",
                "unit_price_cents": 1_200,
                "line_amount_cents": 3_000,
            }
        ],
        "notes": "张师傅垫付",
        "document_version_ids": document_version_ids or [1],
    }


def _create_advance(client: TestClient, **changes: object) -> dict[str, Any]:
    payload = _advance_payload()
    payload.update(changes)
    response = client.post(
        "/api/projects/P-001/material-advances",
        headers={"Idempotency-Key": str(uuid.uuid4())},
        json=payload,
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


def test_authentication_precedes_json_validation(harness: Harness) -> None:
    with harness.client(authenticated=False) as client:
        response = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            content=b"not-json",
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 401


def test_daily_report_upsert_list_filter_confirm_reopen_and_revision(
    harness: Harness,
) -> None:
    with harness.client() as client:
        created = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=_report_payload(),
        )
        stale_create = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=_report_payload(None),
        )
        report = created.json()
        confirmed = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/confirm",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "confirmed_at": "2026-08-31T09:00:00+08:00",
                "expected_revision": report["revision"],
            },
        )
        confirmed_body = confirmed.json()
        reopen = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/reopen",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "reason": "现场情况变化",
                "expected_revision": confirmed_body["revision"],
            },
        )
        listing = client.get(
            "/api/projects/P-001/site-daily-reports?page=1&page_size=1"
            "&from=2026-08-30&to=2026-08-30"
        )

    assert created.status_code == 200
    assert report == {
        "id": report["id"],
        "project_code": "P-001",
        "work_date": "2026-08-30",
        "location": "一号车间",
        "weather": "晴",
        "work_summary": "安装机架",
        "blockers": None,
        "next_plan": "铺设线缆",
        "notes": None,
        "status": "draft",
        "confirmed_at": None,
        "revision": 1,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
        "versions": [],
        "events": [],
    }
    assert stale_create.status_code == 409
    assert stale_create.json()["error_code"] == "REVISION_CONFLICT"
    assert confirmed.status_code == 200
    assert confirmed_body["confirmed_at"] == "2026-08-31T01:00:00+00:00"
    assert reopen.status_code == 200
    assert reopen.json()["status"] == "draft"
    assert listing.json() == {
        "items": [reopen.json()],
        "total": 1,
        "page": 1,
        "page_size": 1,
    }


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "put",
            "/api/projects/P-OLD/site-daily-reports/2026-08-30",
            _report_payload(),
        ),
        (
            "post",
            "/api/projects/P-OLD/material-advances",
            _advance_payload(),
        ),
    ],
)
def test_archived_project_rejects_writes(
    harness: Harness, method: str, path: str, payload: dict[str, object]
) -> None:
    with harness.client() as client:
        response = client.request(
            method,
            path,
            headers={"Idempotency-Key": str(uuid.uuid4())}
            if method == "post"
            else None,
            json=payload,
        )
    assert response.status_code == 409
    assert response.json()["error_code"] == "PROJECT_ARCHIVED"


def test_report_payload_and_filters_are_strict(harness: Harness) -> None:
    with harness.client() as client:
        extra = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json={**_report_payload(), "extra": True},
        )
        invalid_range = client.get(
            "/api/projects/P-001/site-daily-reports?from=2026-09-01&to=2026-08-30"
        )
    assert extra.status_code == 422
    assert invalid_range.status_code == 422


def test_pagination_rejects_offset_that_exceeds_sqlite_integer(
    harness: Harness,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
        response = client.get(
            "/api/projects/P-001/site-daily-reports"
            "?page=9223372036854775807&page_size=200"
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_PAGINATION"


def test_material_advance_create_detail_update_and_filtered_pagination(
    harness: Harness,
) -> None:
    with harness.client() as client:
        created = _create_advance(client)
        detail = client.get(f"/api/projects/P-001/material-advances/{created['id']}")
        payload = _advance_payload()
        payload["vendor_name"] = "新五金店"
        payload["expected_revision"] = created["revision"]
        updated = client.put(
            f"/api/projects/P-001/material-advances/{created['id']}", json=payload
        )
        listing = client.get(
            "/api/projects/P-001/material-advances?page=1&page_size=1"
            "&status=unreimbursed&worker_id=1"
        )

    assert created["total_amount_cents"] == 3_000
    assert created["status"] == "unreimbursed"
    assert created["document_version_ids"] == [1]
    assert created["items"][0]["quantity"] == "2.500"
    assert detail.json()["reimbursements"] == []
    assert updated.status_code == 200
    assert updated.json()["vendor_name"] == "新五金店"
    assert updated.json()["revision"] == 2
    assert listing.json()["total"] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"items": []},
        {
            "items": [
                {
                    "name": "螺栓",
                    "specification": None,
                    "brand": None,
                    "quantity": "2.500",
                    "unit": "包",
                    "unit_price_cents": 1_200,
                    "line_amount_cents": 2_999,
                }
            ]
        },
        {"document_version_ids": [2]},
        {"worker_id": 999},
    ],
)
def test_advance_rejects_invalid_items_documents_and_worker(
    harness: Harness, change: dict[str, object]
) -> None:
    payload = _advance_payload()
    payload.update(change)
    with harness.client() as client:
        response = client.post("/api/projects/P-001/material-advances", json=payload)
    assert response.status_code == 422


def test_advance_worker_requires_current_project_assignment_covering_spent_date(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        timestamp = NOW.isoformat()
        connection.execute(
            """
            INSERT INTO workers (id, name, status, created_at, updated_at)
            VALUES (2, '无排班人员', 'active', ?, ?)
            """,
            (timestamp, timestamp),
        )
    finally:
        connection.close()

    without_assignment = _advance_payload()
    without_assignment["worker_id"] = 2
    outside_schedule = _advance_payload()
    outside_schedule["spent_on"] = "2026-10-01"
    with harness.client() as client:
        missing = client.post(
            "/api/projects/P-001/material-advances",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json=without_assignment,
        )
        outside = client.post(
            "/api/projects/P-001/material-advances",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json=outside_schedule,
        )

    assert missing.status_code == 422
    assert missing.json()["error_code"] == "INVALID_ADVANCE_PAYLOAD"
    assert missing.json()["field_errors"] == {
        "worker_id": "must have an active assignment for spent_on"
    }
    assert outside.status_code == 422
    assert outside.json()["field_errors"] == {
        "worker_id": "must have an active assignment for spent_on"
    }


def test_advance_total_overflow_is_a_structured_validation_error(
    harness: Harness,
) -> None:
    payload = _advance_payload()
    payload["items"] = [
        {
            "name": "高价值材料",
            "specification": None,
            "brand": None,
            "quantity": "9223372036854775.807",
            "unit": "件",
            "unit_price_cents": 9223372036854775807,
            "line_amount_cents": 9223372036854775807,
        }
    ]
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects/P-001/material-advances",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json=payload,
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "INVALID_ADVANCE_PAYLOAD"


def test_database_failure_response_keeps_standard_error_shape(
    harness: Harness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute("DROP TABLE site_daily_reports")
    finally:
        connection.close()

    with harness.client(raise_server_exceptions=False) as client:
        response = client.get("/api/projects/P-001/site-daily-reports")

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Site operation failed",
        "error_code": "SITE_OPERATION_FAILED",
        "field_errors": {},
        "current_revision": None,
    }


def test_reimbursement_is_idempotent_and_status_is_derived(harness: Harness) -> None:
    key = str(uuid.uuid4())
    payload = {
        "amount_cents": 1_000,
        "reimbursed_on": "2026-08-31",
        "payment_method": "bank_transfer",
        "notes": None,
    }
    with harness.client() as client:
        advance = _create_advance(client)
        path = f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements"
        first = client.post(path, headers={"Idempotency-Key": key}, json=payload)
        replay = client.post(path, headers={"Idempotency-Key": key}, json=payload)
        second = client.post(
            path,
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={**payload, "amount_cents": 2_000},
        )
        detail = client.get(f"/api/projects/P-001/material-advances/{advance['id']}")

    assert first.status_code == 201
    assert replay.json() == first.json()
    assert first.json()["advance_status"] == "partial"
    assert second.status_code == 201
    assert second.json()["advance_status"] == "reimbursed"
    assert len(detail.json()["reimbursements"]) == 2
    assert detail.json()["status"] == "reimbursed"


def test_reimbursement_replay_survives_project_archive_after_unknown_result(
    harness: Harness,
) -> None:
    key = str(uuid.uuid4())
    payload = {
        "amount_cents": 1_000,
        "reimbursed_on": "2026-08-31",
        "payment_method": "cash",
        "notes": None,
    }
    with harness.client() as client:
        advance = _create_advance(client)
        path = f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements"
        first = client.post(path, headers={"Idempotency-Key": key}, json=payload)
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 1",
                (NOW.isoformat(),),
            )
        finally:
            connection.close()
        replay = client.post(
            path.replace("P-001", "p-001"),
            headers={"Idempotency-Key": key},
            json=payload,
        )

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json() == first.json()


def test_reimbursement_cannot_exceed_total_or_reuse_key_with_new_body(
    harness: Harness,
) -> None:
    key = str(uuid.uuid4())
    payload = {
        "amount_cents": 3_001,
        "reimbursed_on": "2026-08-31",
        "payment_method": "cash",
        "notes": None,
    }
    with harness.client() as client:
        advance = _create_advance(client)
        path = f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements"
        excessive = client.post(path, headers={"Idempotency-Key": key}, json=payload)
        ok = client.post(
            path,
            headers={"Idempotency-Key": key},
            json={**payload, "amount_cents": 1_000},
        )
        conflict = client.post(
            path,
            headers={"Idempotency-Key": key},
            json={**payload, "amount_cents": 2_000},
        )
    assert excessive.status_code == 409
    assert ok.status_code == 201
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_CONFLICT"


def test_void_reimbursement_preserves_audit_and_restores_advance_balance(
    harness: Harness,
) -> None:
    void_key = str(uuid.uuid4())
    reimbursement_payload = {
        "amount_cents": 1_000,
        "reimbursed_on": "2026-08-31",
        "payment_method": "cash",
        "notes": "现金报销",
    }
    with harness.client() as client:
        advance = _create_advance(client)
        reimbursement = client.post(
            f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json=reimbursement_payload,
        ).json()
        path = (
            f"/api/projects/P-001/material-advances/{advance['id']}"
            f"/reimbursements/{reimbursement['id']}/void"
        )
        void_payload = {
            "reason": "付款方式登记错误",
            "expected_revision": reimbursement["revision"],
        }
        voided = client.post(
            path,
            headers={"Idempotency-Key": void_key},
            json=void_payload,
        )
        detail = client.get(f"/api/projects/P-001/material-advances/{advance['id']}")
        edit_payload = _advance_payload()
        edit_payload["vendor_name"] = "冲销后更正的商户"
        edit_payload["expected_revision"] = voided.json()["advance_revision"]
        edited = client.put(
            f"/api/projects/P-001/material-advances/{advance['id']}",
            json=edit_payload,
        )
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 1",
                (NOW.isoformat(),),
            )
        finally:
            connection.close()
        replay = client.post(
            path.replace("P-001", "p-001"),
            headers={"Idempotency-Key": void_key},
            json=void_payload,
        )

    assert voided.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == voided.json()
    assert voided.json() == {
        **reimbursement_payload,
        "id": reimbursement["id"],
        "advance_id": advance["id"],
        "status": "voided",
        "void_reason": "付款方式登记错误",
        "voided_at": NOW.isoformat(),
        "revision": 2,
        "advance_status": "unreimbursed",
        "advance_reimbursed_amount_cents": 0,
        "advance_outstanding_amount_cents": 3_000,
        "advance_revision": reimbursement["advance_revision"] + 1,
        "created_at": reimbursement["created_at"],
        "updated_at": NOW.isoformat(),
    }
    assert detail.status_code == 200
    assert detail.json()["status"] == "unreimbursed"
    assert detail.json()["reimbursed_amount_cents"] == 0
    assert detail.json()["outstanding_amount_cents"] == 3_000
    assert detail.json()["reimbursements"] == [{
        "id": reimbursement["id"],
        "advance_id": advance["id"],
        **reimbursement_payload,
        "status": "voided",
        "void_reason": "付款方式登记错误",
        "voided_at": NOW.isoformat(),
        "revision": 2,
        "created_at": reimbursement["created_at"],
        "updated_at": NOW.isoformat(),
    }]
    assert edited.status_code == 200
    assert edited.json()["vendor_name"] == "冲销后更正的商户"


def test_void_reimbursement_checks_ownership_revision_and_idempotency_body(
    harness: Harness,
) -> None:
    with harness.client() as client:
        first_advance = _create_advance(client)
        second_advance = _create_advance(client)
        reimbursement = client.post(
            f"/api/projects/P-001/material-advances/{first_advance['id']}/reimbursements",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "amount_cents": 1_000,
                "reimbursed_on": "2026-08-31",
                "payment_method": "bank_transfer",
                "notes": None,
            },
        ).json()
        wrong_parent = client.post(
            f"/api/projects/P-001/material-advances/{second_advance['id']}"
            f"/reimbursements/{reimbursement['id']}/void",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={"reason": "录错", "expected_revision": reimbursement["revision"]},
        )
        stale = client.post(
            f"/api/projects/P-001/material-advances/{first_advance['id']}"
            f"/reimbursements/{reimbursement['id']}/void",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={"reason": "录错", "expected_revision": reimbursement["revision"] + 1},
        )
        key = str(uuid.uuid4())
        path = (
            f"/api/projects/P-001/material-advances/{first_advance['id']}"
            f"/reimbursements/{reimbursement['id']}/void"
        )
        ok = client.post(
            path,
            headers={"Idempotency-Key": key},
            json={"reason": "录错", "expected_revision": reimbursement["revision"]},
        )
        mismatch = client.post(
            path,
            headers={"Idempotency-Key": key},
            json={"reason": "另一个原因", "expected_revision": reimbursement["revision"]},
        )

    assert wrong_parent.status_code == 404
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    assert ok.status_code == 200
    assert mismatch.status_code == 409
    assert mismatch.json()["error_code"] == "IDEMPOTENCY_CONFLICT"


def test_advance_cannot_edit_or_void_after_reimbursement(harness: Harness) -> None:
    with harness.client() as client:
        advance = _create_advance(client)
        client.post(
            f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "amount_cents": 1_000,
                "reimbursed_on": "2026-08-31",
                "payment_method": "cash",
                "notes": None,
            },
        )
        edit_payload = _advance_payload()
        edit_payload["expected_revision"] = advance["revision"]
        edited = client.put(
            f"/api/projects/P-001/material-advances/{advance['id']}",
            json=edit_payload,
        )
        voided = client.post(
            f"/api/projects/P-001/material-advances/{advance['id']}/void",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={"reason": "录入错误", "expected_revision": advance["revision"]},
        )
    assert edited.status_code == 409
    assert voided.status_code == 409


def test_void_unreimbursed_advance_and_block_later_writes(harness: Harness) -> None:
    with harness.client() as client:
        advance = _create_advance(client)
        voided = client.post(
            f"/api/projects/P-001/material-advances/{advance['id']}/void",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={"reason": "重复录入", "expected_revision": advance["revision"]},
        )
        reimbursement = client.post(
            f"/api/projects/P-001/material-advances/{advance['id']}/reimbursements",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "amount_cents": 1,
                "reimbursed_on": "2026-08-31",
                "payment_method": "other",
                "notes": None,
            },
        )
    assert voided.status_code == 200
    assert voided.json()["status"] == "voided"
    assert reimbursement.status_code == 409


def test_advance_create_and_void_are_idempotent_across_project_archive(
    harness: Harness,
) -> None:
    create_key = str(uuid.uuid4())
    void_key = str(uuid.uuid4())
    payload = _advance_payload()
    with harness.client() as client:
        first = client.post(
            "/api/projects/P-001/material-advances",
            headers={"Idempotency-Key": create_key},
            json=payload,
        )
        create_replay = client.post(
            "/api/projects/p-001/material-advances",
            headers={"Idempotency-Key": create_key},
            json=payload,
        )
        path = f"/api/projects/P-001/material-advances/{first.json()['id']}/void"
        void_payload = {
            "reason": "重复录入",
            "expected_revision": first.json()["revision"],
        }
        voided = client.post(
            path,
            headers={"Idempotency-Key": void_key},
            json=void_payload,
        )
        connection = connect_database(harness.database_path)
        try:
            connection.execute(
                "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 1",
                (NOW.isoformat(),),
            )
        finally:
            connection.close()
        void_replay = client.post(
            path.replace("P-001", "p-001"),
            headers={"Idempotency-Key": void_key},
            json=void_payload,
        )

    assert first.status_code == 201
    assert create_replay.status_code == 201
    assert create_replay.json() == first.json()
    assert voided.status_code == 200
    assert void_replay.status_code == 200
    assert void_replay.json() == voided.json()

    connection = connect_database(harness.database_path)
    try:
        assert connection.execute(
            "SELECT COUNT(*) FROM material_advances WHERE project_id = 1"
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_report_transitions_are_idempotent_and_reopen_reason_is_audited(
    harness: Harness,
) -> None:
    confirm_key = str(uuid.uuid4())
    reopen_key = str(uuid.uuid4())
    with harness.client() as client:
        report = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=_report_payload(),
        ).json()
        confirm_payload = {
            "confirmed_at": "2026-08-31T09:00:00+08:00",
            "expected_revision": report["revision"],
        }
        confirmed = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/confirm",
            headers={"Idempotency-Key": confirm_key},
            json=confirm_payload,
        )
        confirm_replay = client.post(
            "/api/projects/p-001/site-daily-reports/2026-08-30/confirm",
            headers={"Idempotency-Key": confirm_key},
            json=confirm_payload,
        )
        reopen_payload = {
            "reason": "现场实际情况变化",
            "expected_revision": confirmed.json()["revision"],
        }
        reopened = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/reopen",
            headers={"Idempotency-Key": reopen_key},
            json=reopen_payload,
        )
        reopen_replay = client.post(
            "/api/projects/p-001/site-daily-reports/2026-08-30/reopen",
            headers={"Idempotency-Key": reopen_key},
            json=reopen_payload,
        )

    assert confirmed.status_code == 200
    assert confirm_replay.json() == confirmed.json()
    assert reopened.status_code == 200
    assert reopen_replay.json() == reopened.json()

    connection = connect_database(harness.database_path)
    try:
        events = connection.execute(
            """
            SELECT from_status, to_status, reason
            FROM site_daily_report_events ORDER BY id
            """
        ).fetchall()
    finally:
        connection.close()
    assert [tuple(row) for row in events] == [
        ("draft", "confirmed", None),
        ("confirmed", "draft", "现场实际情况变化"),
    ]


def test_report_confirmation_keeps_immutable_snapshot_across_reopen_and_edit(
    harness: Harness,
) -> None:
    with harness.client() as client:
        report = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=_report_payload(),
        ).json()
        confirmed = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/confirm",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "confirmed_at": "2026-08-31T09:00:00+08:00",
                "expected_revision": report["revision"],
            },
        ).json()
        reopened = client.post(
            "/api/projects/P-001/site-daily-reports/2026-08-30/reopen",
            headers={"Idempotency-Key": str(uuid.uuid4())},
            json={
                "reason": "补录次日信息",
                "expected_revision": confirmed["revision"],
            },
        ).json()
        edited_payload = _report_payload(reopened["revision"])
        edited_payload["work_summary"] = "B：次日补录后的施工内容"
        edited = client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=edited_payload,
        )

    assert edited.status_code == 200
    body = edited.json()
    assert body["work_summary"] == "B：次日补录后的施工内容"
    assert body["versions"] == [
        {
            "id": body["versions"][0]["id"],
            "version_number": 1,
            "work_date": "2026-08-30",
            "location": "一号车间",
            "weather": "晴",
            "work_summary": "安装机架",
            "blockers": None,
            "next_plan": "铺设线缆",
            "notes": None,
            "confirmed_at": "2026-08-31T01:00:00+00:00",
            "created_at": NOW.isoformat(),
        }
    ]
    assert [event["report_version_id"] for event in body["events"]] == [
        body["versions"][0]["id"],
        body["versions"][0]["id"],
    ]

    connection = connect_database(harness.database_path)
    try:
        version_id = body["versions"][0]["id"]
        event_id = body["events"][0]["id"]
        with pytest.raises(sqlite3.IntegrityError, match="report version is immutable"):
            connection.execute(
                "UPDATE site_daily_report_versions SET work_summary = '篡改' WHERE id = ?",
                (version_id,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="report version is immutable"):
            connection.execute(
                "DELETE FROM site_daily_report_versions WHERE id = ?", (version_id,)
            )
        with pytest.raises(sqlite3.IntegrityError, match="report event is immutable"):
            connection.execute(
                "UPDATE site_daily_report_events SET reason = '篡改' WHERE id = ?",
                (event_id,),
            )
        with pytest.raises(sqlite3.IntegrityError, match="report event is immutable"):
            connection.execute(
                "DELETE FROM site_daily_report_events WHERE id = ?", (event_id,)
            )
    finally:
        connection.close()


def test_report_and_advance_responses_are_built_inside_one_database_snapshot(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with harness.client() as client:
        client.put(
            "/api/projects/P-001/site-daily-reports/2026-08-30",
            json=_report_payload(),
        )

    site_operations = importlib.import_module("backend.app.features.site_operations")
    original_detail = site_operations._advance_detail
    original_summary = site_operations._advance_summary
    original_report = site_operations._report_response
    detail_transaction_states: list[bool] = []
    summary_transaction_states: list[bool] = []
    report_transaction_states: list[bool] = []
    read_transaction_active = False

    def tracked_detail(connection: sqlite3.Connection, *args: object):
        detail_transaction_states.append(connection.in_transaction)
        return original_detail(connection, *args)

    def tracked_summary(connection: sqlite3.Connection, *args: object):
        summary_transaction_states.append(connection.in_transaction)
        return original_summary(connection, *args)

    def tracked_report(
        connection: sqlite3.Connection, row: sqlite3.Row, project_code: str
    ):
        report_transaction_states.append(read_transaction_active)
        return original_report(connection, row, project_code)

    original_transaction = site_operations.transaction

    @contextmanager
    def tracked_transaction(connection: sqlite3.Connection):
        nonlocal read_transaction_active
        with original_transaction(connection):
            read_transaction_active = True
            try:
                yield connection
            finally:
                read_transaction_active = False

    monkeypatch.setattr(site_operations, "_advance_detail", tracked_detail)
    monkeypatch.setattr(site_operations, "_advance_summary", tracked_summary)
    monkeypatch.setattr(site_operations, "_report_response", tracked_report)
    monkeypatch.setattr(site_operations, "transaction", tracked_transaction)

    with harness.client() as client:
        client.get("/api/projects/P-001/site-daily-reports")
        created = _create_advance(client)
        client.get(f"/api/projects/P-001/material-advances/{created['id']}")
        client.get("/api/projects/P-001/material-advances")

    assert detail_transaction_states
    assert summary_transaction_states
    assert report_transaction_states
    assert all(detail_transaction_states)
    assert all(summary_transaction_states)
    assert all(report_transaction_states)
