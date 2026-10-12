from __future__ import annotations

import inspect
import json
import logging
import sqlite3
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.features import projects as projects_module
from backend.app.features.projects import create_projects_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 28, 10, 30, tzinfo=timezone.utc)
PROJECT_KEYS = {
    "id",
    "project_code",
    "company_id",
    "name",
    "description",
    "status",
    "archive_reason",
    "archived_at",
    "created_at",
    "updated_at",
}
COMPANY_KEYS = {
    "id",
    "name",
    "taxpayer_id",
    "registered_address",
    "registered_phone",
    "bank_name",
    "bank_account",
    "notes",
    "created_at",
    "updated_at",
}
CONTACT_KEYS = {
    "id",
    "company_id",
    "name",
    "phone",
    "email",
    "position",
    "notes",
    "created_at",
    "updated_at",
}


def test_router_accepts_an_injectable_clock() -> None:
    assert "clock" in inspect.signature(create_projects_router).parameters


@dataclass
class MutableClock:
    value: datetime = NOW

    def __call__(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta = timedelta(minutes=5)) -> None:
        self.value += delta


@dataclass
class ProjectsHarness:
    app: FastAPI
    database_path: Path
    settings: Settings
    clock: MutableClock

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


def _project_payload(
    project_code: str = "P-2026-001",
    *,
    company_id: int = 1,
    name: str = "自动化改造项目",
) -> dict[str, object]:
    return {
        "project_code": project_code,
        "company_id": company_id,
        "name": name,
        "description": "产线升级",
    }


def _build_harness(
    tmp_path: Path,
    *,
    commit_failure: sqlite3.Error | None = None,
    execute_failure: tuple[str, sqlite3.Error] | None = None,
    dml_barrier: tuple[str, threading.Barrier] | None = None,
    inject_document_before_categories: bool = False,
) -> ProjectsHarness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
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
    clock = MutableClock()

    def get_connection() -> Iterator[sqlite3.Connection]:
        owned = connect_database(database_path)
        if commit_failure is not None:
            exposed = cast(
                sqlite3.Connection,
                _CommitFailingConnection(owned, commit_failure),
            )
        elif execute_failure is not None:
            exposed = cast(
                sqlite3.Connection,
                _ExecuteFailingConnection(owned, *execute_failure),
            )
        elif dml_barrier is not None:
            exposed = cast(
                sqlite3.Connection,
                _DmlBarrierConnection(owned, *dml_barrier),
            )
        elif inject_document_before_categories:
            exposed = cast(
                sqlite3.Connection,
                _DocumentRaceConnection(owned, database_path),
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
        create_projects_router(
            get_connection,
            get_settings,
            clock=clock,
        )
    )
    return ProjectsHarness(app, database_path, settings, clock)


@pytest.fixture
def harness(tmp_path: Path) -> ProjectsHarness:
    return _build_harness(tmp_path)


def _insert_company(
    harness: ProjectsHarness,
    *,
    name: str = "示例公司",
) -> int:
    connection = connect_database(harness.database_path)
    try:
        cursor = connection.execute(
            """
            INSERT INTO companies
                (name, taxpayer_id, registered_address, registered_phone,
                 bank_name, bank_account, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                "91310000TEST000001",
                "上海市测试路 1 号",
                "021-12345678",
                "测试银行",
                "6222000000000000",
                "重点客户",
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
        assert cursor.lastrowid is not None
        return cursor.lastrowid
    finally:
        connection.close()


def _create_project(
    client: TestClient,
    project_code: str = "P-2026-001",
    *,
    company_id: int = 1,
    name: str = "自动化改造项目",
) -> dict[str, Any]:
    response = client.post(
        "/api/projects",
        json=_project_payload(
            project_code,
            company_id=company_id,
            name=name,
        ),
    )
    assert response.status_code == 201
    return cast(dict[str, Any], response.json())


def _make_project_completion_ready(
    harness: ProjectsHarness,
    project_code: str = "P-2026-001",
) -> None:
    connection = connect_database(harness.database_path)
    try:
        project = connection.execute(
            "SELECT id FROM projects WHERE project_code = ? COLLATE NOCASE",
            (project_code,),
        ).fetchone()
        assert project is not None
        connection.execute(
            """
            UPDATE project_stages
            SET status = 'skipped', status_reason = '测试确认无需执行',
                completed_at = ?, updated_at = ?
            WHERE project_id = ?
            """,
            (NOW.isoformat(), NOW.isoformat(), project["id"]),
        )
        connection.execute(
            """
            INSERT INTO acceptances
                (project_id, acceptance_type, scheduled_on, performed_on,
                 status, created_at, updated_at)
            VALUES (?, 'final', '2026-08-28', '2026-08-28',
                    'passed', ?, ?)
            """,
            (project["id"], NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()


def _insert_signed_contract_allocation(
    harness: ProjectsHarness,
    *,
    company_id: int,
    amount_cents: int = 1000000,
    contract_no: str = "HT-NO-TERMS",
) -> int:
    connection = connect_database(harness.database_path)
    try:
        project_id = connection.execute("SELECT id FROM projects").fetchone()["id"]
        contract = connection.execute(
            """
            INSERT INTO contracts
                (contract_no, title, customer_company_id, status, signed_on,
                 total_amount_cents, final_delivery_on, created_at, updated_at)
            VALUES (?, '无收款计划合同', ?, 'signed', '2026-08-20',
                    ?, '2026-09-30', ?, ?)
            """,
            (
                contract_no,
                company_id,
                amount_cents,
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
        assert contract.lastrowid is not None
        allocation = connection.execute(
            """
            INSERT INTO contract_project_allocations
                (contract_id, project_id, amount_cents)
            VALUES (?, ?, ?)
            """,
            (contract.lastrowid, project_id, amount_cents),
        )
        assert allocation.lastrowid is not None
        return allocation.lastrowid
    finally:
        connection.close()


def test_create_normalizes_and_returns_exact_project_fields(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    payload = _project_payload("  P-2026-001  ", company_id=company_id)
    payload.update({"name": "  自动化改造项目  ", "description": "  "})

    with harness.client() as client:
        response = client.post("/api/projects", json=payload)

    assert response.status_code == 201
    assert response.json() == {
        "id": 1,
        "project_code": "P-2026-001",
        "company_id": company_id,
        "name": "自动化改造项目",
        "description": None,
        "status": "active",
        "archive_reason": None,
        "archived_at": None,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }
    assert set(response.json()) == PROJECT_KEYS


def test_create_accepts_null_description(harness: ProjectsHarness) -> None:
    company_id = _insert_company(harness)
    payload = _project_payload(company_id=company_id)
    payload["description"] = None

    with harness.client() as client:
        response = client.post("/api/projects", json=payload)

    assert response.status_code == 201
    assert response.json()["description"] is None


def test_create_rejects_unknown_company_without_partial_project(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        response = client.post(
            "/api/projects",
            json=_project_payload(company_id=999),
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Company not found"}
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0
    finally:
        connection.close()


def test_duplicate_project_code_is_case_insensitive_and_unchanged(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        original = _create_project(client, "Project-A", company_id=company_id)
        duplicate = client.post(
            "/api/projects",
            json=_project_payload("pRoJeCt-A", company_id=company_id),
        )
        listed = client.get("/api/projects")

    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "Project code already exists"}
    assert listed.json() == [{**original, "company_name": "示例公司"}]


@pytest.mark.parametrize(
    ("stored_code", "equivalent_code"),
    [
        ("PRJ-Ä", "prj-ä"),
        ("Å", "A\u030a"),
    ],
)
def test_unicode_equivalent_project_codes_conflict_and_resolve_same_project(
    harness: ProjectsHarness,
    stored_code: str,
    equivalent_code: str,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        original = _create_project(
            client,
            stored_code,
            company_id=company_id,
        )
        duplicate = client.post(
            "/api/projects",
            json=_project_payload(equivalent_code, company_id=company_id),
        )
        dashboard = client.get(f"/api/projects/{equivalent_code}/dashboard")
        archived = client.post(
            f"/api/projects/{equivalent_code}/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000010"},
            json={
                "closure_type": "cancelled",
                "reason": "等价编号取消",
                "expected_revision": 1,
            },
        )

    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "Project code already exists"}
    assert dashboard.status_code == 200
    dashboard_project = dashboard.json()["project"]
    assert {key: dashboard_project[key] for key in original} == original
    assert dashboard_project["company_name"] == "示例公司"
    assert dashboard_project["closure_type"] is None
    assert dashboard_project["revision"] == 1
    assert archived.status_code == 200
    assert archived.json()["project_code"] == stored_code
    assert archived.json()["archive_reason"] == "等价编号取消"
    assert "project_code_key" not in duplicate.text + dashboard.text + archived.text


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {**_project_payload(), "unknown": "private"},
        {key: value for key, value in _project_payload().items() if key != "name"},
        {**_project_payload(), "project_code": 123},
        {**_project_payload(), "project_code": "CON"},
        {**_project_payload(), "company_id": True},
        {**_project_payload(), "company_id": 0},
        {**_project_payload(), "company_id": 2**63},
        {**_project_payload(), "company_id": "1"},
        {**_project_payload(), "name": " \t\n "},
        {**_project_payload(), "name": None},
        {**_project_payload(), "description": []},
        [*list(_project_payload().values())],
        None,
    ],
)
def test_create_rejects_invalid_payload_with_fixed_detail(
    harness: ProjectsHarness,
    payload: Any,
) -> None:
    _insert_company(harness)
    with harness.client() as client:
        response = client.post("/api/projects", json=payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid project payload"}
    assert "private" not in response.text


@pytest.mark.parametrize("field", ["project_code", "name", "description"])
@pytest.mark.parametrize("invalid_text", ["\ud800", "\x00"])
def test_create_rejects_text_sqlite_cannot_store_safely(
    harness: ProjectsHarness,
    field: str,
    invalid_text: str,
) -> None:
    _insert_company(harness)
    payload = _project_payload()
    payload[field] = invalid_text

    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects",
            content=json.dumps(payload, ensure_ascii=True).encode("ascii"),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid project payload"}
    assert "ud800" not in response.text


def test_create_rejects_deep_json_with_fixed_detail(
    harness: ProjectsHarness,
) -> None:
    nested = "[" * 10_000 + "0" + "]" * 10_000

    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects",
            content=(f'{{"project_code":{nested}}}').encode(),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid project payload"}


@pytest.mark.parametrize(
    ("path", "content", "detail"),
    [
        ("/api/projects", b'{"private":', "Invalid project payload"),
    ],
)
def test_authenticated_malformed_or_deep_json_has_fixed_422(
    harness: ProjectsHarness,
    path: str,
    content: bytes,
    detail: str,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            path,
            content=content,
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert "private" not in response.text


def test_list_defaults_to_active_and_supports_all_three_filters(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        first = _create_project(client, "P-1", company_id=company_id)
        second = _create_project(client, "P-2", company_id=company_id)
        archived = client.post(
            "/api/projects/P-1/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000011"},
            json={
                "closure_type": "cancelled",
                "reason": "报价未接受",
                "expected_revision": 1,
            },
        ).json()
        harness.clock.advance()
        newest = _create_project(client, "P-3", company_id=company_id)

        default = client.get("/api/projects")
        active = client.get("/api/projects?status=active")
        archived_rows = client.get("/api/projects?status=archived")
        all_rows = client.get("/api/projects?status=all")

    assert default.json() == active.json()
    assert [row["project_code"] for row in active.json()] == ["P-3", "P-2"]
    assert [row["project_code"] for row in archived_rows.json()] == ["P-1"]
    assert [row["project_code"] for row in all_rows.json()] == [
        "P-3",
        "P-2",
        "P-1",
    ]
    assert active.json()[0] == {**newest, "company_name": "示例公司"}
    assert archived_rows.json()[0] == {
        **{key: archived[key] for key in PROJECT_KEYS},
        "company_name": "示例公司",
    }
    assert second["created_at"] == first["created_at"]


@pytest.mark.parametrize("query", ["status=", "status=ACTIVE", "status=private"])
def test_list_rejects_invalid_status_with_fixed_detail(
    harness: ProjectsHarness,
    query: str,
) -> None:
    with harness.client() as client:
        response = client.get(f"/api/projects?{query}")

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid project status"}
    assert "private" not in response.text


def test_list_rejects_repeated_status_query(harness: ProjectsHarness) -> None:
    with harness.client() as client:
        response = client.get(
            "/api/projects",
            params=[("status", "active"), ("status", "all")],
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid project status"}


@pytest.mark.parametrize("project_code", ["P-2026-001", "MISSING"])
def test_archive_route_is_retired_and_never_changes_project(
    harness: ProjectsHarness,
    project_code: str,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        original = _create_project(client, company_id=company_id)
        response = client.post(
            f"/api/projects/{project_code}/archive",
            content=b'{"private":',
            headers={"content-type": "application/json"},
        )
        detail = client.get("/api/projects/P-2026-001")

    assert response.status_code == 410
    assert response.headers["x-error-code"] == "PROJECT_ARCHIVE_RETIRED"
    assert response.json() == {
        "detail": "Project archive endpoint is retired; use project close",
        "error_code": "PROJECT_ARCHIVE_RETIRED",
        "field_errors": {},
        "current_revision": None,
    }
    assert "private" not in response.text
    assert detail.status_code == 200
    assert detail.json() == {
        **original,
        "company_name": "示例公司",
        "closure_type": None,
        "revision": 1,
    }


def test_retired_archive_ignores_invalid_project_code_while_dashboard_rejects_it(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        archived = client.post("/api/projects/CON/archive", json={"reason": None})
        dashboard = client.get("/api/projects/COM1/dashboard")

    assert archived.status_code == 410
    assert archived.json() == {
        "detail": "Project archive endpoint is retired; use project close",
        "error_code": "PROJECT_ARCHIVE_RETIRED",
        "field_errors": {},
        "current_revision": None,
    }
    assert dashboard.status_code == 422
    assert dashboard.json() == {
        "detail": "Invalid project code",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }
    assert "CON" not in archived.text
    assert "COM1" not in dashboard.text


def test_missing_project_dashboard_is_fixed_404(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        dashboard = client.get("/api/projects/MISSING/dashboard")

    assert dashboard.status_code == 404
    assert dashboard.json() == {
        "detail": "Project not found",
        "error_code": "RESOURCE_NOT_FOUND",
        "field_errors": {},
        "current_revision": None,
    }


def test_dashboard_returns_real_company_contacts_and_document_counts(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    connection = connect_database(harness.database_path)
    try:
        for name in ("张三", "李四"):
            connection.execute(
                """
                INSERT INTO contacts
                    (company_id, name, phone, email, position, notes,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    company_id,
                    name,
                    None,
                    None,
                    "项目经理",
                    None,
                    NOW.isoformat(),
                    NOW.isoformat(),
                ),
            )
    finally:
        connection.close()
    with harness.client() as client:
        project = _create_project(client, "Dashboard-A", company_id=company_id)

    connection = connect_database(harness.database_path)
    try:
        documents = []
        for category, logical_name in (
            ("beta", "采购清单"),
            ("Alpha", "机械图纸"),
            ("alpha", "电气图纸"),
        ):
            cursor = connection.execute(
                """
                INSERT INTO documents
                    (project_code, category, logical_name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                ("dashboard-a", category, logical_name, NOW.isoformat()),
            )
            assert cursor.lastrowid is not None
            documents.append((cursor.lastrowid, category))
        version_rows = (
            (documents[0][0], 1, "private-cost.xlsx", "Projects/private-a"),
            (documents[1][0], 1, "private-cad.dwg", "Projects/private-b"),
            (documents[1][0], 2, "private-cad-v2.dwg", "Projects/private-c"),
        )
        for document_id, version, original_name, stored_path in version_rows:
            connection.execute(
                """
                INSERT INTO document_versions
                    (document_id, version_number, original_filename,
                     stored_relative_path, size_bytes, sha256, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    version,
                    original_name,
                    stored_path,
                    10,
                    "a" * 64,
                    NOW.isoformat(),
                ),
            )
    finally:
        connection.close()

    with harness.client() as client:
        response = client.get("/api/projects/DASHBOARD-A/dashboard")

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
    assert {key: body["project"][key] for key in project} == project
    assert set(body["company"]) == COMPANY_KEYS
    assert body["company"]["name"] == "示例公司"
    assert [contact["name"] for contact in body["contacts"]] == ["张三", "李四"]
    assert all(set(contact) == CONTACT_KEYS for contact in body["contacts"])
    assert body["documents"] == {
        "document_count": 3,
        "version_count": 3,
        "categories": [
            {"category": "Alpha", "document_count": 1, "version_count": 2},
            {"category": "alpha", "document_count": 1, "version_count": 0},
            {"category": "beta", "document_count": 1, "version_count": 1},
        ],
    }
    serialized = response.text
    for private_value in (
        "private-cost.xlsx",
        "private-cad.dwg",
        "Projects/private-a",
        "a" * 64,
        str(harness.database_path),
        harness.settings.session_secret,
    ):
        assert private_value not in serialized
    assert body["costs"]["total_cents"] == 0
    assert body["profit"]["actual_profit_cents"] == 0


def test_dashboard_without_documents_returns_zero_counts(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        response = client.get("/api/projects/P-2026-001/dashboard")

    assert response.status_code == 200
    assert response.json()["documents"] == {
        "document_count": 0,
        "version_count": 0,
        "categories": [],
    }


def test_project_detail_update_and_revision_conflict(
    harness: ProjectsHarness,
) -> None:
    first_company_id = _insert_company(harness, name="原客户")
    second_company_id = _insert_company(harness, name="新客户")
    with harness.client() as client:
        _create_project(client, company_id=first_company_id)
        detail = client.get("/api/projects/p-2026-001")
        missing_company = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": 999,
                "name": "不应保存",
                "description": None,
                "expected_revision": 1,
            },
        )
        updated = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": second_company_id,
                "name": "  新项目名称  ",
                "description": "  新说明  ",
                "expected_revision": 1,
            },
        )
        stale = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": first_company_id,
                "name": "过期修改",
                "description": None,
                "expected_revision": 1,
            },
        )

    assert detail.status_code == 200
    assert missing_company.status_code == 404
    assert missing_company.json()["error_code"] == "RESOURCE_NOT_FOUND"
    assert detail.json() == {
        "id": 1,
        "project_code": "P-2026-001",
        "company_id": first_company_id,
        "company_name": "原客户",
        "name": "自动化改造项目",
        "description": "产线升级",
        "status": "active",
        "closure_type": None,
        "archive_reason": None,
        "archived_at": None,
        "revision": 1,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }
    assert updated.status_code == 200
    assert updated.json() == {
        **detail.json(),
        "company_id": second_company_id,
        "company_name": "新客户",
        "name": "新项目名称",
        "description": "新说明",
        "revision": 2,
    }
    assert stale.status_code == 409
    assert stale.json() == {
        "detail": "Resource was modified",
        "error_code": "REVISION_CONFLICT",
        "field_errors": {},
        "current_revision": 2,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {
            "company_id": 1,
            "name": "项目",
            "description": None,
            "expected_revision": 1,
            "unknown": "private",
        },
        {"company_id": 1, "name": "项目", "description": None},
        {
            "company_id": "1",
            "name": "项目",
            "description": None,
            "expected_revision": 1,
        },
        {
            "company_id": 1,
            "name": "  ",
            "description": None,
            "expected_revision": 1,
        },
    ],
)
def test_update_project_rejects_non_strict_payload(
    harness: ProjectsHarness,
    payload: object,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        response = client.put("/api/projects/P-2026-001", json=payload)

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid project payload",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }
    assert "private" not in response.text


def test_close_project_is_idempotent_and_rejects_key_reuse(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    headers = {"Idempotency-Key": "70000000-0000-4000-8000-000000000001"}
    payload = {
        "closure_type": "cancelled",
        "reason": "客户未接受报价",
        "expected_revision": 1,
    }
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        closed = client.post(
            "/api/projects/P-2026-001/close",
            headers=headers,
            json=payload,
        )
        replay = client.post(
            "/api/projects/p-2026-001/close",
            headers=headers,
            json=payload,
        )
        reused = client.post(
            "/api/projects/P-2026-001/close",
            headers=headers,
            json={**payload, "reason": "不同原因"},
        )
        second_close = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000002"},
            json={**payload, "expected_revision": 2},
        )
        archived_update = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": company_id,
                "name": "不应修改",
                "description": None,
                "expected_revision": 2,
            },
        )

    assert closed.status_code == replay.status_code == 200
    assert replay.json() == closed.json()
    assert closed.json() == {
        "id": 1,
        "project_code": "P-2026-001",
        "company_id": company_id,
        "company_name": "示例公司",
        "name": "自动化改造项目",
        "description": "产线升级",
        "status": "archived",
        "closure_type": "cancelled",
        "archive_reason": "客户未接受报价",
        "archived_at": NOW.isoformat(),
        "revision": 2,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }
    assert reused.status_code == 409
    assert reused.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    assert second_close.status_code == 409
    assert second_close.json()["error_code"] == "PROJECT_ALREADY_CLOSED"
    assert archived_update.status_code == 409
    assert archived_update.json()["error_code"] == "PROJECT_ARCHIVED"


def test_completed_close_blocks_empty_project_without_changing_it(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000012"},
            json={
                "closure_type": "completed",
                "reason": "尝试正常完结",
                "expected_revision": 1,
            },
        )
        detail = client.get("/api/projects/P-2026-001")

    assert dashboard.status_code == 200
    assert dashboard.json()["completion_check"] == {
        "stages_ready": False,
        "final_acceptance_ready": False,
        "receivables_ready": True,
        "ready": False,
        "blockers": [
            "PROJECT_STAGES_INCOMPLETE",
            "FINAL_ACCEPTANCE_NOT_PASSED",
        ],
    }
    assert blocked.status_code == 409
    assert blocked.headers["x-error-code"] == "PROJECT_COMPLETION_BLOCKED"
    assert blocked.json() == {
        "detail": "Project completion requirements are not met",
        "error_code": "PROJECT_COMPLETION_BLOCKED",
        "field_errors": {
            "stages": "所有项目阶段必须为已完成或已跳过",
            "final_acceptance": "必须存在结果为通过或带整改通过的最终验收",
        },
        "current_revision": None,
    }
    assert detail.json()["status"] == "active"
    assert detail.json()["closure_type"] is None
    assert detail.json()["archive_reason"] is None
    assert detail.json()["archived_at"] is None
    assert detail.json()["revision"] == 1
    connection = connect_database(harness.database_path)
    try:
        request_count = connection.execute(
            """
            SELECT COUNT(*) FROM idempotency_requests
            WHERE scope = ? AND idempotency_key = ?
            """,
            (
                "POST:/api/projects/p-2026-001/close",
                "70000000-0000-4000-8000-000000000012",
            ),
        ).fetchone()[0]
        assert request_count == 0
    finally:
        connection.close()


def test_completed_close_succeeds_only_when_all_requirements_are_ready(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        closed = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000013"},
            json={
                "closure_type": "completed",
                "reason": "阶段、验收及收款均已完成",
                "expected_revision": 1,
            },
        )

    assert dashboard.status_code == 200
    assert dashboard.json()["completion_check"] == {
        "stages_ready": True,
        "final_acceptance_ready": True,
        "receivables_ready": True,
        "ready": True,
        "blockers": [],
    }
    assert closed.status_code == 200
    assert closed.json()["status"] == "archived"
    assert closed.json()["closure_type"] == "completed"
    assert closed.json()["revision"] == 2


def test_completed_close_blocks_outstanding_receivables(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)
    connection = connect_database(harness.database_path)
    try:
        project_id = connection.execute("SELECT id FROM projects").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO payment_terms
                (project_id, milestone, due_on, planned_amount_cents,
                 created_at, updated_at)
            VALUES (?, 'final', '2026-08-28', 100, ?, ?)
            """,
            (project_id, NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000014"},
            json={
                "closure_type": "completed",
                "reason": "仍有未收款",
                "expected_revision": 1,
            },
        )

    assert dashboard.json()["completion_check"] == {
        "stages_ready": True,
        "final_acceptance_ready": True,
        "receivables_ready": False,
        "ready": False,
        "blockers": ["RECEIVABLES_OUTSTANDING"],
    }
    assert blocked.status_code == 409
    assert blocked.json()["field_errors"] == {
        "receivables": "项目未收款必须为 0",
    }
    connection = connect_database(harness.database_path)
    try:
        project = connection.execute(
            "SELECT status, closure_type, revision FROM projects"
        ).fetchone()
        assert tuple(project) == ("active", None, 1)
    finally:
        connection.close()


def test_completed_close_blocks_uncollected_signed_contract_without_payment_terms(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)
    _insert_signed_contract_allocation(harness, company_id=company_id)

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000019"},
            json={
                "closure_type": "completed",
                "reason": "合同款尚未收齐",
                "expected_revision": 1,
            },
        )

    assert dashboard.json()["receivables"]["contracted_amount_cents"] == 1000000
    assert dashboard.json()["receivables"]["allocated_received_amount_cents"] == 0
    assert dashboard.json()["receivables"]["outstanding_receivable_cents"] == 0
    assert dashboard.json()["completion_check"] == {
        "stages_ready": True,
        "final_acceptance_ready": True,
        "receivables_ready": False,
        "ready": False,
        "blockers": ["RECEIVABLES_OUTSTANDING"],
    }
    assert blocked.status_code == 409
    assert blocked.json()["field_errors"] == {
        "receivables": "项目未收款必须为 0",
    }


def test_completed_close_allows_fully_collected_contract_without_payment_terms(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)
    allocation_id = _insert_signed_contract_allocation(
        harness,
        company_id=company_id,
    )
    connection = connect_database(harness.database_path)
    try:
        project_id = connection.execute("SELECT id FROM projects").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO receipts
                (project_id, contract_allocation_id, milestone, received_on,
                 amount_cents, payment_method, status, created_at, updated_at)
            VALUES (?, ?, 'final', '2026-08-28', 1000000, 'bank_transfer',
                    'active', ?, ?)
            """,
            (project_id, allocation_id, NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        closed = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000020"},
            json={
                "closure_type": "completed",
                "reason": "合同款已收齐",
                "expected_revision": 1,
            },
        )

    assert dashboard.json()["completion_check"]["receivables_ready"] is True
    assert closed.status_code == 200
    assert closed.json()["closure_type"] == "completed"


def test_completed_close_does_not_offset_one_contract_debt_with_another_overpayment(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)
    paid_allocation_id = _insert_signed_contract_allocation(
        harness,
        company_id=company_id,
        amount_cents=100,
        contract_no="HT-OVERPAID",
    )
    _insert_signed_contract_allocation(
        harness,
        company_id=company_id,
        amount_cents=100,
        contract_no="HT-UNPAID",
    )
    connection = connect_database(harness.database_path)
    try:
        project_id = connection.execute("SELECT id FROM projects").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO receipts
                (project_id, contract_allocation_id, milestone, received_on,
                 amount_cents, payment_method, status, created_at, updated_at)
            VALUES (?, ?, 'final', '2026-08-28', 200, 'bank_transfer',
                    'active', ?, ?)
            """,
            (
                project_id,
                paid_allocation_id,
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000021"},
            json={
                "closure_type": "completed",
                "reason": "另一份合同仍未收款",
                "expected_revision": 1,
            },
        )

    assert dashboard.json()["completion_check"]["receivables_ready"] is False
    assert blocked.status_code == 409
    assert blocked.json()["error_code"] == "PROJECT_COMPLETION_BLOCKED"


def test_completed_close_uses_latest_final_acceptance_result(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
    _make_project_completion_ready(harness)
    connection = connect_database(harness.database_path)
    try:
        project_id = connection.execute("SELECT id FROM projects").fetchone()["id"]
        connection.execute(
            """
            INSERT INTO acceptances
                (project_id, acceptance_type, scheduled_on, performed_on,
                 status, created_at, updated_at)
            VALUES (?, 'final', '2026-08-29', '2026-08-29',
                    'failed', ?, ?)
            """,
            (project_id, NOW.isoformat(), NOW.isoformat()),
        )
    finally:
        connection.close()

    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000022"},
            json={
                "closure_type": "completed",
                "reason": "最新验收未通过",
                "expected_revision": 1,
            },
        )

    assert dashboard.json()["completion_check"]["final_acceptance_ready"] is False
    assert blocked.status_code == 409
    assert blocked.json()["error_code"] == "PROJECT_COMPLETION_BLOCKED"


def test_dashboard_and_completed_close_call_the_same_completion_helper(
    harness: ProjectsHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)

    original = projects_module._project_completion_check
    calls: list[str] = []

    def tracked_completion_check(
        connection: sqlite3.Connection,
        project: sqlite3.Row | dict[str, object],
        operating: dict[str, object],
    ) -> dict[str, object]:
        calls.append(str(project["project_code"]))
        return original(connection, project, operating)

    monkeypatch.setattr(
        projects_module,
        "_project_completion_check",
        tracked_completion_check,
    )
    with harness.client() as client:
        dashboard = client.get("/api/projects/P-2026-001/dashboard")
        blocked = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000015"},
            json={
                "closure_type": "completed",
                "reason": "验证同源规则",
                "expected_revision": 1,
            },
        )

    assert dashboard.status_code == 200
    assert blocked.status_code == 409
    assert calls == ["P-2026-001", "P-2026-001"]


@pytest.mark.parametrize(
    ("payload", "expected_status"),
    [
        ({"closure_type": "invalid", "reason": "原因", "expected_revision": 1}, 422),
        ({"closure_type": "completed", "reason": "  ", "expected_revision": 1}, 422),
        ({"closure_type": "completed", "reason": "原因", "expected_revision": 0}, 422),
        ({"closure_type": "completed", "reason": "原因"}, 422),
        (
            {
                "closure_type": "completed",
                "reason": "原因",
                "expected_revision": 1,
                "unknown": "private",
            },
            422,
        ),
    ],
)
def test_close_project_rejects_invalid_payload(
    harness: ProjectsHarness,
    payload: dict[str, object],
    expected_status: int,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        response = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000003"},
            json=payload,
        )

    assert response.status_code == expected_status
    assert "private" not in response.text


def test_close_project_rejects_invalid_idempotency_key(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        response = client.post(
            "/api/projects/P-2026-001/close",
            headers={"Idempotency-Key": "not-a-uuid"},
            json={
                "closure_type": "completed",
                "reason": "正常完成",
                "expected_revision": 1,
            },
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_close_project_requires_structured_idempotency_key_error(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        response = client.post(
            "/api/projects/P-2026-001/close",
            json={
                "closure_type": "completed",
                "reason": "正常完成",
                "expected_revision": 1,
            },
        )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid Idempotency-Key",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }


@pytest.mark.parametrize(
    ("method", "suffix", "payload", "headers"),
    [
        ("get", "", None, None),
        (
            "put",
            "",
            {
                "company_id": 1,
                "name": "项目",
                "description": None,
                "expected_revision": 1,
            },
            None,
        ),
        (
            "post",
            "/close",
            {
                "closure_type": "completed",
                "reason": "正常完成",
                "expected_revision": 1,
            },
            {"Idempotency-Key": "70000000-0000-4000-8000-000000000006"},
        ),
    ],
)
def test_new_project_routes_use_structured_invalid_path_errors(
    harness: ProjectsHarness,
    method: str,
    suffix: str,
    payload: object,
    headers: dict[str, str] | None,
) -> None:
    with harness.client() as client:
        response = client.request(
            method,
            f"/api/projects/CON{suffix}",
            json=payload,
            headers=headers,
        )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid project code",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }


def test_update_commit_failure_rolls_back_project_changes(tmp_path: Path) -> None:
    setup = _build_harness(tmp_path)
    original_company_id = _insert_company(setup, name="原客户")
    replacement_company_id = _insert_company(setup, name="新客户")
    with setup.client() as client:
        _create_project(client, company_id=original_company_id)

    harness = _build_harness(tmp_path, commit_failure=_missing_table_error())
    with harness.client(raise_server_exceptions=False) as client:
        response = client.put(
            "/api/projects/P-2026-001",
            json={
                "company_id": replacement_company_id,
                "name": "不应保存",
                "description": "不应保存",
                "expected_revision": 1,
            },
        )

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Project operation failed",
        "error_code": "PROJECT_OPERATION_FAILED",
        "field_errors": {},
        "current_revision": None,
    }
    connection = connect_database(harness.database_path)
    try:
        row = connection.execute(
            "SELECT company_id, name, description, revision FROM projects"
        ).fetchone()
        assert tuple(row) == (
            original_company_id,
            "自动化改造项目",
            "产线升级",
            1,
        )
    finally:
        connection.close()


def test_close_commit_failure_rolls_back_project_and_idempotency(
    tmp_path: Path,
) -> None:
    setup = _build_harness(tmp_path)
    company_id = _insert_company(setup)
    with setup.client() as client:
        _create_project(client, company_id=company_id)

    harness = _build_harness(tmp_path, commit_failure=_missing_table_error())
    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects/P-2026-001/close",
            headers={
                "Idempotency-Key": "70000000-0000-4000-8000-000000000005"
            },
            json={
                "closure_type": "cancelled",
                "reason": "不应保存",
                "expected_revision": 1,
            },
        )

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Project operation failed",
        "error_code": "PROJECT_OPERATION_FAILED",
        "field_errors": {},
        "current_revision": None,
    }
    connection = connect_database(harness.database_path)
    try:
        project = connection.execute(
            """
            SELECT status, closure_type, archive_reason, archived_at, revision
            FROM projects
            """
        ).fetchone()
        assert tuple(project) == ("active", None, None, None, 1)
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM idempotency_requests"
            ).fetchone()[0]
            == 0
        )
    finally:
        connection.close()


def test_dashboard_uses_one_snapshot_for_totals_and_categories(
    tmp_path: Path,
) -> None:
    setup = _build_harness(tmp_path)
    company_id = _insert_company(setup)
    with setup.client() as client:
        _create_project(client, "Snapshot-A", company_id=company_id)
    connection = connect_database(setup.database_path)
    try:
        connection.execute(
            """
            INSERT INTO documents
                (project_code, category, logical_name, created_at)
            VALUES ('Snapshot-A', 'Existing', '初始文档', ?)
            """,
            (NOW.isoformat(),),
        )
    finally:
        connection.close()

    harness = _build_harness(tmp_path, inject_document_before_categories=True)
    with harness.client() as client:
        response = client.get("/api/projects/snapshot-a/dashboard")

    assert response.status_code == 200
    assert response.json()["documents"] == {
        "document_count": 1,
        "version_count": 0,
        "categories": [
            {"category": "Existing", "document_count": 1, "version_count": 0}
        ],
    }
    verifier = connect_database(harness.database_path)
    try:
        assert verifier.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 2
    finally:
        verifier.close()


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", "/api/projects", None),
        ("get", "/api/projects?status=private", None),
        ("post", "/api/projects", _project_payload()),
        ("post", "/api/projects/P-1/archive", {"reason": None}),
        ("get", "/api/projects/P-1/dashboard", None),
        ("get", "/api/projects/P-1", None),
        (
            "put",
            "/api/projects/P-1",
            {
                "company_id": 1,
                "name": "项目",
                "description": None,
                "expected_revision": 1,
            },
        ),
    ],
)
def test_every_business_route_requires_authentication(
    harness: ProjectsHarness,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    with harness.client(authenticated=False) as client:
        response = client.request(method, path, json=payload)

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_close_route_requires_authentication_before_reading_body(
    harness: ProjectsHarness,
) -> None:
    with harness.client(authenticated=False) as client:
        response = client.post(
            "/api/projects/P-1/close",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000004"},
            content=b'{"private":',
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    "path",
    ["/api/projects", "/api/projects/P-1/archive"],
)
def test_authentication_precedes_malformed_json(
    harness: ProjectsHarness,
    path: str,
) -> None:
    with harness.client(authenticated=False) as client:
        response = client.post(
            path,
            content=b'{"private":',
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
    assert "private" not in response.text


def test_concurrent_duplicate_creation_has_one_201_and_one_409(
    tmp_path: Path,
) -> None:
    barrier = threading.Barrier(2)
    harness = _build_harness(
        tmp_path,
        dml_barrier=("INSERT INTO PROJECTS", barrier),
    )
    company_id = _insert_company(harness)

    def create(code: str) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.post(
                "/api/projects",
                json=_project_payload(code, company_id=company_id),
            )
            return response.status_code, cast(dict[str, Any], response.json())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(create, ("Race-A", "rAcE-A")))

    assert sorted(status_code for status_code, _ in results) == [201, 409]
    conflict = next(body for status_code, body in results if status_code == 409)
    assert conflict == {"detail": "Project code already exists"}
    connection = connect_database(harness.database_path)
    try:
        rows = connection.execute("SELECT project_code FROM projects").fetchall()
        assert len(rows) == 1
        assert rows[0]["project_code"].casefold() == "race-a"
    finally:
        connection.close()


def test_concurrent_unicode_equivalent_creation_has_one_201_and_one_409(
    tmp_path: Path,
) -> None:
    barrier = threading.Barrier(2)
    harness = _build_harness(
        tmp_path,
        dml_barrier=("INSERT INTO PROJECTS", barrier),
    )
    company_id = _insert_company(harness)

    def create(code: str) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.post(
                "/api/projects",
                json=_project_payload(code, company_id=company_id),
            )
            return response.status_code, cast(dict[str, Any], response.json())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(create, ("Å", "A\u030a")))

    assert sorted(status_code for status_code, _ in results) == [201, 409]
    assert next(body for code, body in results if code == 409) == {
        "detail": "Project code already exists"
    }
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 1
    finally:
        connection.close()


def test_concurrent_archive_calls_are_all_retired_and_leave_project_active(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, "Race-Archive", company_id=company_id)

    def archive(reason: str) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.post(
                "/api/projects/race-archive/archive",
                json={"reason": reason},
            )
            return response.status_code, cast(dict[str, Any], response.json())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(archive, ("原因甲", "原因乙")))

    assert [status_code for status_code, _ in results] == [410, 410]
    assert {body["error_code"] for _, body in results} == {
        "PROJECT_ARCHIVE_RETIRED"
    }
    connection = connect_database(harness.database_path)
    try:
        project = connection.execute(
            "SELECT status, closure_type, archive_reason, revision FROM projects"
        ).fetchone()
        assert tuple(project) == ("active", None, None, 1)
    finally:
        connection.close()


def test_commit_failure_rolls_back_and_logs_without_client_leak(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    failure = _missing_table_error()
    harness = _build_harness(tmp_path, commit_failure=failure)
    company_id = _insert_company(harness)
    caplog.set_level(logging.ERROR, logger=projects_module.__name__)

    with harness.client(raise_server_exceptions=False) as client:
        response = client.post(
            "/api/projects",
            json=_project_payload("Private-Input", company_id=company_id),
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project operation failed"}
    assert "Private-Input" not in response.text
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 0
    finally:
        connection.close()
    records = _project_error_records(caplog)
    assert len(records) == 1
    assert records[0].getMessage() == (
        "Project database operation failed "
        "(sqlite_errorcode=1, sqlite_errorname=SQLITE_ERROR)"
    )
    assert records[0].exc_info is not None
    assert "Private-Input" not in records[0].getMessage()


@pytest.mark.parametrize(
    ("path", "sql_prefix"),
    [
        ("/api/projects", "SELECT PROJECTS.ID,"),
        ("/api/projects/P-1/dashboard", "SELECT PROJECTS.ID,"),
    ],
)
def test_unexpected_read_failure_logs_once_and_returns_fixed_500(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    path: str,
    sql_prefix: str,
) -> None:
    harness = _build_harness(
        tmp_path,
        execute_failure=(sql_prefix, _missing_table_error()),
    )
    caplog.set_level(logging.ERROR, logger=projects_module.__name__)

    with harness.client(raise_server_exceptions=False) as client:
        response = client.get(path)

    assert response.status_code == 500
    if path.endswith("/dashboard"):
        assert response.json() == {
            "detail": "Project operation failed",
            "error_code": "PROJECT_OPERATION_FAILED",
            "field_errors": {},
            "current_revision": None,
        }
    else:
        assert response.json() == {"detail": "Project operation failed"}
    assert "private_secret_table" not in response.text
    records = _project_error_records(caplog)
    assert len(records) == 1
    assert records[0].exc_info is not None


def test_expected_404_and_409_do_not_log_errors(
    harness: ProjectsHarness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    company_id = _insert_company(harness)
    caplog.set_level(logging.ERROR, logger=projects_module.__name__)
    with harness.client() as client:
        _create_project(client, "Expected-A", company_id=company_id)
        duplicate = client.post(
            "/api/projects",
            json=_project_payload("expected-a", company_id=company_id),
        )
        unknown_company = client.post(
            "/api/projects",
            json=_project_payload("Expected-B", company_id=999),
        )
        missing_archive = client.post(
            "/api/projects/Missing/archive",
            json={"reason": None},
        )
        missing_dashboard = client.get("/api/projects/Missing/dashboard")

    assert duplicate.status_code == 409
    assert unknown_company.status_code == 404
    assert missing_archive.status_code == 410
    assert missing_dashboard.status_code == 404
    assert _project_error_records(caplog) == []


def _project_error_records(
    caplog: pytest.LogCaptureFixture,
) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name == projects_module.__name__ and record.levelno >= logging.ERROR
    ]


class _CommitFailingConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        failure: sqlite3.Error,
    ) -> None:
        self._connection = connection
        self._failure = failure

    def commit(self) -> None:
        raise self._failure

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _ExecuteFailingConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        sql_prefix: str,
        failure: sqlite3.Error,
    ) -> None:
        self._connection = connection
        self._sql_prefix = sql_prefix
        self._failure = failure

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        normalized_sql = " ".join(sql.split()).upper()
        if normalized_sql.startswith(self._sql_prefix):
            raise self._failure
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _DmlBarrierConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        sql_prefix: str,
        barrier: threading.Barrier,
    ) -> None:
        self._connection = connection
        self._sql_prefix = sql_prefix
        self._barrier = barrier
        self._reached_target = False
        self._expect_first_business_statement = False

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        normalized_sql = " ".join(sql.split()).upper()
        if normalized_sql == "BEGIN":
            self._expect_first_business_statement = True
        elif self._expect_first_business_statement:
            self._expect_first_business_statement = False
            if not normalized_sql.startswith(self._sql_prefix):
                raise AssertionError("target DML was not the first business SQL")
        if not self._reached_target and normalized_sql.startswith(self._sql_prefix):
            self._reached_target = True
            self._barrier.wait(timeout=10)
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _DocumentRaceConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        database_path: Path,
    ) -> None:
        self._connection = connection
        self._database_path = database_path
        self._injected = False

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        normalized_sql = " ".join(sql.split()).upper()
        if not self._injected and normalized_sql.startswith(
            "SELECT DOCUMENTS.CATEGORY AS CATEGORY,"
        ):
            project_code = cast(tuple[str], parameters)[0]
            competitor = connect_database(self._database_path)
            try:
                competitor.execute(
                    """
                    INSERT INTO documents
                        (project_code, category, logical_name, created_at)
                    VALUES (?, 'Concurrent', '并发文档', ?)
                    """,
                    (project_code, NOW.isoformat()),
                )
            finally:
                competitor.close()
            self._injected = True
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


def _missing_table_error() -> sqlite3.OperationalError:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("SELECT * FROM private_secret_table")
    except sqlite3.OperationalError as failure:
        return failure
    finally:
        connection.close()
    raise AssertionError("missing table probe unexpectedly succeeded")


@pytest.mark.parametrize("closure_type", ["cancelled", "completed"])
def test_restore_archived_project_clears_closure_and_records_immutable_audit(
    harness: ProjectsHarness,
    closure_type: str,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)

    archived_at = "2026-08-27T08:00:00+00:00"
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            UPDATE projects
            SET status = 'archived', closure_type = ?, archive_reason = ?,
                archived_at = ?, revision = 2, updated_at = ?
            WHERE project_code_key = ?
            """,
            (
                closure_type,
                "历史完结原因",
                archived_at,
                archived_at,
                "p-2026-001",
            ),
        )
    finally:
        connection.close()

    key = "70000000-0000-4000-8000-000000000101"
    payload = {"reason": "客户确认继续实施", "expected_revision": 2}
    with harness.client() as client:
        restored = client.post(
            "/api/projects/P-2026-001/restore",
            headers={"Idempotency-Key": key},
            json=payload,
        )
        replay = client.post(
            "/api/projects/p-2026-001/restore",
            headers={"Idempotency-Key": key},
            json=payload,
        )

    assert restored.status_code == replay.status_code == 200
    assert replay.json() == restored.json()
    assert restored.json() == {
        "id": 1,
        "project_code": "P-2026-001",
        "company_id": company_id,
        "company_name": "示例公司",
        "name": "自动化改造项目",
        "description": "产线升级",
        "status": "active",
        "closure_type": None,
        "archive_reason": None,
        "archived_at": None,
        "revision": 3,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }

    connection = connect_database(harness.database_path)
    try:
        event = connection.execute(
            """
            SELECT project_id, from_closure_type, from_archive_reason,
                   from_archived_at, restore_reason, expected_revision,
                   resulting_revision, created_at
            FROM project_restore_events
            """
        ).fetchone()
        assert tuple(event) == (
            1,
            closure_type,
            "历史完结原因",
            archived_at,
            "客户确认继续实施",
            2,
            3,
            NOW.isoformat(),
        )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute(
                "UPDATE project_restore_events SET restore_reason = '篡改'"
            )
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("DELETE FROM project_restore_events")
    finally:
        connection.close()


def test_restore_project_rejects_stale_revision_active_project_and_changed_replay(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        active = client.post(
            "/api/projects/P-2026-001/restore",
            headers={
                "Idempotency-Key": "70000000-0000-4000-8000-000000000102"
            },
            json={"reason": "不应恢复", "expected_revision": 1},
        )

    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            UPDATE projects
            SET status = 'archived', closure_type = 'cancelled',
                archive_reason = '客户暂停', archived_at = ?, revision = 2
            WHERE project_code_key = ?
            """,
            (NOW.isoformat(), "p-2026-001"),
        )
    finally:
        connection.close()

    key = "70000000-0000-4000-8000-000000000103"
    with harness.client() as client:
        stale = client.post(
            "/api/projects/P-2026-001/restore",
            headers={"Idempotency-Key": key},
            json={"reason": "恢复", "expected_revision": 1},
        )
        restored = client.post(
            "/api/projects/P-2026-001/restore",
            headers={"Idempotency-Key": key},
            json={"reason": "恢复", "expected_revision": 2},
        )
        changed = client.post(
            "/api/projects/P-2026-001/restore",
            headers={"Idempotency-Key": key},
            json={"reason": "另一个原因", "expected_revision": 2},
        )

    assert active.status_code == 409
    assert active.json()["error_code"] == "PROJECT_ALREADY_ACTIVE"
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    assert stale.json()["current_revision"] == 2
    assert restored.status_code == 200
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"


@pytest.mark.parametrize(
    "payload",
    [
        {"reason": "", "expected_revision": 2},
        {"reason": "恢复", "expected_revision": 0},
        {"reason": "恢复"},
        {"reason": "恢复", "expected_revision": 2, "extra": True},
    ],
)
def test_restore_project_rejects_invalid_payload(
    harness: ProjectsHarness,
    payload: dict[str, object],
) -> None:
    with harness.client() as client:
        response = client.post(
            "/api/projects/P-2026-001/restore",
            headers={
                "Idempotency-Key": "70000000-0000-4000-8000-000000000104"
            },
            json=payload,
        )

    assert response.status_code == 422


def test_restore_project_rejects_invalid_reason_with_structured_contract(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        response = client.post(
            "/api/projects/P-2026-001/restore",
            headers={
                "Idempotency-Key": "70000000-0000-4000-8000-000000000105"
            },
            json={"reason": 123, "expected_revision": 2},
        )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "Invalid project restore payload",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }
