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
            f"/api/projects/{equivalent_code}/archive",
            json={"reason": "等价编号归档"},
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
    assert archived.json()["archive_reason"] == "等价编号归档"
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
        (
            "/api/projects/P-1/archive",
            b'{"private":',
            "Invalid archive payload",
        ),
        (
            "/api/projects/P-1/archive",
            ('{"reason":' + "[" * 10_000 + "0" + "]" * 10_000 + "}").encode(),
            "Invalid archive payload",
        ),
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
            "/api/projects/P-1/archive",
            json={"reason": "报价未接受"},
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
    assert archived_rows.json()[0] == {**archived, "company_name": "示例公司"}
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


def test_archive_normalizes_reason_and_is_case_insensitive(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        original = _create_project(client, "Project-A", company_id=company_id)
        harness.clock.advance()
        response = client.post(
            "/api/projects/project-a/archive",
            json={"reason": "  客户取消  "},
        )
        detail = client.get("/api/projects/PROJECT-A")

    assert response.status_code == 200
    assert response.json() == {
        **original,
        "status": "archived",
        "archive_reason": "客户取消",
        "archived_at": harness.clock.value.isoformat(),
        "updated_at": harness.clock.value.isoformat(),
    }
    assert detail.status_code == 200
    assert detail.json()["revision"] == 2


def test_archive_is_idempotent_and_preserves_first_values(
    harness: ProjectsHarness,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        first = client.post(
            "/api/projects/P-2026-001/archive",
            json={"reason": "第一次原因"},
        )
        harness.clock.advance()
        second = client.post(
            "/api/projects/p-2026-001/archive",
            json={"reason": "第二次原因"},
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == first.json()
    assert second.json()["archive_reason"] == "第一次原因"
    assert second.json()["archived_at"] == NOW.isoformat()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"reason": None, "unknown": "private"},
        {"reason": 123},
        {"reason": ["private"]},
    ],
)
def test_archive_rejects_invalid_payload_before_idempotent_response(
    harness: ProjectsHarness,
    payload: Any,
) -> None:
    company_id = _insert_company(harness)
    with harness.client() as client:
        _create_project(client, company_id=company_id)
        first = client.post(
            "/api/projects/P-2026-001/archive",
            json={"reason": None},
        )
        response = client.post(
            "/api/projects/P-2026-001/archive",
            json=payload,
        )

    assert first.status_code == 200
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid archive payload"}
    assert "private" not in response.text


@pytest.mark.parametrize("invalid_text", ["\ud800", "\x00"])
def test_archive_rejects_unsafe_reason(
    harness: ProjectsHarness,
    invalid_text: str,
) -> None:
    company_id = _insert_company(harness)
    with harness.client(raise_server_exceptions=False) as client:
        _create_project(client, company_id=company_id)
        response = client.post(
            "/api/projects/P-2026-001/archive",
            content=json.dumps(
                {"reason": invalid_text},
                ensure_ascii=True,
            ).encode("ascii"),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid archive payload"}


def test_archive_and_dashboard_validate_project_code_without_echo(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        archived = client.post("/api/projects/CON/archive", json={"reason": None})
        dashboard = client.get("/api/projects/COM1/dashboard")

    assert archived.status_code == 422
    assert archived.json() == {"detail": "Invalid project code"}
    assert dashboard.status_code == 422
    assert dashboard.json() == {
        "detail": "Invalid project code",
        "error_code": "VALIDATION_ERROR",
        "field_errors": {},
        "current_revision": None,
    }
    assert "CON" not in archived.text
    assert "COM1" not in dashboard.text


def test_missing_project_archive_and_dashboard_are_fixed_404(
    harness: ProjectsHarness,
) -> None:
    with harness.client() as client:
        archived = client.post(
            "/api/projects/MISSING/archive",
            json={"reason": None},
        )
        dashboard = client.get("/api/projects/MISSING/dashboard")

    assert archived.status_code == 404
    assert archived.json() == {"detail": "Project not found"}
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


def test_concurrent_archive_preserves_one_complete_first_result(
    tmp_path: Path,
) -> None:
    setup = _build_harness(tmp_path)
    company_id = _insert_company(setup)
    with setup.client() as client:
        _create_project(client, "Race-Archive", company_id=company_id)

    barrier = threading.Barrier(2)
    harness = _build_harness(
        tmp_path,
        dml_barrier=("UPDATE PROJECTS SET", barrier),
    )

    def archive(reason: str) -> tuple[int, dict[str, Any]]:
        with harness.client() as client:
            response = client.post(
                "/api/projects/race-archive/archive",
                json={"reason": reason},
            )
            return response.status_code, cast(dict[str, Any], response.json())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(archive, ("原因甲", "原因乙")))

    assert [status_code for status_code, _ in results] == [200, 200]
    assert results[0][1] == results[1][1]
    assert results[0][1]["archive_reason"] in {"原因甲", "原因乙"}
    assert results[0][1]["status"] == "archived"
    assert results[0][1]["archived_at"] == NOW.isoformat()
    assert results[0][1]["updated_at"] == NOW.isoformat()


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
    assert missing_archive.status_code == 404
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
