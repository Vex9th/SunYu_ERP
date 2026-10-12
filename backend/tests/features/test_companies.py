from __future__ import annotations

import json
import logging
import shutil
import sqlite3
from collections.abc import Iterator
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
from backend.app.core.security import (
    SESSION_COOKIE_NAME,
    create_session_token,
)
from backend.app.core.storage_paths import project_code_identity
from backend.app.features import companies as companies_module
from backend.app.features.companies import create_companies_router

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 28, 9, 15, tzinfo=timezone.utc)
COMPANY_KEYS = {
    "id",
    "name",
    "taxpayer_id",
    "registered_address",
    "registered_phone",
    "bank_name",
    "bank_account",
    "notes",
    "revision",
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
    "revision",
    "created_at",
    "updated_at",
}
IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000001"


@dataclass
class MutableClock:
    value: datetime = NOW

    def __call__(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta = timedelta(minutes=5)) -> None:
        self.value += delta


@dataclass
class CompaniesHarness:
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


def _company_payload(name: str = "示例公司") -> dict[str, object]:
    return {
        "name": name,
        "taxpayer_id": "91310000TEST000001",
        "registered_address": "上海市测试路 1 号",
        "registered_phone": "021-12345678",
        "bank_name": "测试银行",
        "bank_account": "6222000000000000",
        "notes": "重点客户",
    }


def _contact_payload(name: str = "张三") -> dict[str, object]:
    return {
        "name": name,
        "phone": "13800000000",
        "email": "contact@example.test",
        "position": "项目经理",
        "notes": "首选联系人",
    }


def _build_harness(
    tmp_path: Path,
    *,
    commit_failure: sqlite3.Error | None = None,
    inject_project_before_company_delete: bool = False,
    inject_concurrent_write_before: str | None = None,
    execute_failure: tuple[str, sqlite3.Error] | None = None,
) -> CompaniesHarness:
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
        elif inject_project_before_company_delete:
            exposed = cast(
                sqlite3.Connection,
                _ProjectRaceConnection(owned, database_path),
            )
        elif inject_concurrent_write_before is not None:
            exposed = cast(
                sqlite3.Connection,
                _ConcurrentWriteConnection(
                    owned,
                    database_path,
                    inject_concurrent_write_before,
                ),
            )
        elif execute_failure is not None:
            exposed = cast(
                sqlite3.Connection,
                _ExecuteFailingConnection(owned, *execute_failure),
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
        create_companies_router(
            get_connection,
            get_settings,
            clock=clock,
        )
    )
    return CompaniesHarness(app, database_path, settings, clock)


@pytest.fixture
def harness(tmp_path: Path) -> CompaniesHarness:
    return _build_harness(tmp_path)


def _create_company(
    client: TestClient,
    name: str = "示例公司",
) -> dict[str, Any]:
    response = client.post("/api/companies", json=_company_payload(name))
    assert response.status_code == 201
    return cast(dict[str, Any], response.json())


def _create_contact(
    client: TestClient,
    company_id: int,
    name: str = "张三",
) -> dict[str, Any]:
    response = client.post(
        f"/api/companies/{company_id}/contacts",
        json=_contact_payload(name),
    )
    assert response.status_code == 201
    return cast(dict[str, Any], response.json())


def test_create_normalizes_company_fields_and_returns_empty_contacts(
    harness: CompaniesHarness,
) -> None:
    payload = _company_payload("  示例公司  ")
    payload.update(
        {
            "taxpayer_id": "  91310000TEST000001  ",
            "registered_address": " \t ",
            "registered_phone": None,
            "bank_name": "  测试银行  ",
            "bank_account": "\n",
            "notes": "  重点客户  ",
        }
    )

    with harness.client() as client:
        response = client.post("/api/companies", json=payload)

    assert response.status_code == 201
    body = response.json()
    assert set(body) == COMPANY_KEYS | {"contacts"}
    assert body == {
        "id": 1,
        "name": "示例公司",
        "taxpayer_id": "91310000TEST000001",
        "registered_address": None,
        "registered_phone": None,
        "bank_name": "测试银行",
        "bank_account": None,
        "notes": "重点客户",
        "revision": 1,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
        "contacts": [],
    }


def test_list_is_case_insensitive_stable_and_includes_contact_count(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        beta = _create_company(client, "beta")
        alpha = _create_company(client, "Alpha")
        gamma = _create_company(client, "gamma")
        _create_contact(client, beta["id"], "王一")
        _create_contact(client, beta["id"], "王二")
        _create_contact(client, gamma["id"], "李一")

        response = client.get("/api/companies")

    assert response.status_code == 200
    rows = response.json()
    assert [row["name"] for row in rows] == ["Alpha", "beta", "gamma"]
    assert [row["contact_count"] for row in rows] == [0, 2, 1]
    assert all(set(row) == COMPANY_KEYS | {"contact_count"} for row in rows)
    assert rows[0]["id"] == alpha["id"]


def test_get_details_orders_contacts_by_id(harness: CompaniesHarness) -> None:
    with harness.client() as client:
        company = _create_company(client)
        first = _create_contact(client, company["id"], "同名联系人")
        second = _create_contact(client, company["id"], "同名联系人")

        response = client.get(f"/api/companies/{company['id']}")

    assert response.status_code == 200
    assert set(response.json()) == COMPANY_KEYS | {"contacts"}
    assert response.json()["contacts"] == [first, second]
    assert all(set(contact) == CONTACT_KEYS for contact in response.json()["contacts"])


def test_put_company_replaces_fields_but_preserves_contacts(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
        harness.clock.advance()
        replacement = {
            "name": "  替换公司  ",
            "taxpayer_id": None,
            "registered_address": " 新地址 ",
            "registered_phone": " ",
            "bank_name": None,
            "bank_account": None,
            "notes": " 新备注 ",
            "expected_revision": company["revision"],
        }

        response = client.put(
            f"/api/companies/{company['id']}",
            json=replacement,
        )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "替换公司"
    assert body["taxpayer_id"] is None
    assert body["registered_address"] == "新地址"
    assert body["registered_phone"] is None
    assert body["notes"] == "新备注"
    assert body["created_at"] == NOW.isoformat()
    assert body["updated_at"] == harness.clock.value.isoformat()
    assert body["contacts"] == [contact]


def test_contact_put_replaces_fields_and_wrong_company_is_404(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        company = _create_company(client, "甲公司")
        other = _create_company(client, "乙公司")
        contact = _create_contact(client, company["id"])
        harness.clock.advance()
        replacement = {
            "name": "  李四  ",
            "phone": None,
            "email": " ",
            "position": " 总经理 ",
            "notes": None,
            "expected_revision": contact["revision"],
        }

        wrong_company = client.put(
            f"/api/companies/{other['id']}/contacts/{contact['id']}",
            json=replacement,
        )
        updated = client.put(
            f"/api/companies/{company['id']}/contacts/{contact['id']}",
            json=replacement,
        )

    assert wrong_company.status_code == 404
    assert wrong_company.json() == {"detail": "Contact not found"}
    assert updated.status_code == 200
    assert updated.json() == {
        "id": contact["id"],
        "company_id": company["id"],
        "name": "李四",
        "phone": None,
        "email": None,
        "position": "总经理",
        "notes": None,
        "revision": 2,
        "created_at": NOW.isoformat(),
        "updated_at": harness.clock.value.isoformat(),
    }


def test_contact_delete_checks_ownership(harness: CompaniesHarness) -> None:
    with harness.client() as client:
        company = _create_company(client, "甲公司")
        other = _create_company(client, "乙公司")
        contact = _create_contact(client, company["id"])

        wrong_company = client.request("DELETE",
            f"/api/companies/{other['id']}/contacts/{contact['id']}",
            json={"expected_revision": contact["revision"]},
        )
        still_present = client.get(f"/api/companies/{company['id']}")
        deleted = client.request("DELETE",
            f"/api/companies/{company['id']}/contacts/{contact['id']}",
            json={"expected_revision": contact["revision"]},
        )
        missing = client.request("DELETE",
            f"/api/companies/{company['id']}/contacts/{contact['id']}",
            json={"expected_revision": contact["revision"]},
        )

    assert wrong_company.status_code == 404
    assert still_present.json()["contacts"] == [contact]
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Contact not found"}


def test_delete_company_cascades_contacts(harness: CompaniesHarness) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])

        deleted = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )

    assert deleted.status_code == 204
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM contacts WHERE id = ?",
                (contact["id"],),
            ).fetchone()[0]
            == 0
        )
    finally:
        connection.close()


@pytest.mark.parametrize("project_status", ["active", "archived"])
def test_delete_company_rejects_every_project_reference_without_changes(
    harness: CompaniesHarness,
    project_status: str,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
    connection = connect_database(harness.database_path)
    try:
        archived_at = NOW.isoformat() if project_status == "archived" else None
        project_code = f"P-{project_status}"
        connection.execute(
            """
            INSERT INTO projects
                (project_code, project_code_key, company_id, name,
                 status, archived_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_code,
                project_code_identity(project_code),
                company["id"],
                "测试项目",
                project_status,
                archived_at,
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()

    with harness.client() as client:
        response = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )
        detail = client.get(f"/api/companies/{company['id']}")

    assert response.status_code == 409
    assert response.json() == {"detail": "Company is referenced by projects"}
    assert detail.status_code == 200
    assert detail.json()["contacts"] == [contact]


def test_delete_company_maps_concurrent_project_reference_to_atomic_409(
    tmp_path: Path,
) -> None:
    harness = _build_harness(
        tmp_path,
        inject_project_before_company_delete=True,
    )
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
        response = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )
        detail = client.get(f"/api/companies/{company['id']}")

    assert response.status_code == 409
    assert response.json() == {"detail": "Company is referenced by projects"}
    assert detail.status_code == 200
    assert detail.json()["contacts"] == [contact]
    connection = connect_database(harness.database_path)
    try:
        project = connection.execute(
            "SELECT company_id, status FROM projects"
        ).fetchone()
        assert dict(project) == {"company_id": company["id"], "status": "active"}
    finally:
        connection.close()


@pytest.mark.parametrize(
    "operation",
    [
        "replace_company",
        "create_contact",
        "replace_contact",
        "delete_contact",
    ],
)
def test_writes_acquire_immediate_transaction_before_mutation(
    tmp_path: Path,
    operation: str,
) -> None:
    sql_prefixes = {
        "replace_company": "UPDATE COMPANIES SET",
        "create_contact": "INSERT INTO CONTACTS",
        "replace_contact": "UPDATE CONTACTS SET",
        "delete_contact": "DELETE FROM CONTACTS",
    }
    harness = _build_harness(
        tmp_path,
        inject_concurrent_write_before=sql_prefixes[operation],
    )
    with harness.client() as client:
        company = _create_company(client)
        if operation == "replace_company":
            response = client.put(
                f"/api/companies/{company['id']}",
                json={
                    **_company_payload("并发更新公司"),
                    "expected_revision": company["revision"],
                },
            )
            assert response.status_code == 200
            assert response.json()["name"] == "并发更新公司"
        elif operation == "create_contact":
            response = client.post(
                f"/api/companies/{company['id']}/contacts",
                json=_contact_payload(),
            )
            assert response.status_code == 201
        else:
            contact = _create_contact(client, company["id"])
            path = f"/api/companies/{company['id']}/contacts/{contact['id']}"
            if operation == "replace_contact":
                response = client.put(
                    path,
                    json={
                        **_contact_payload("并发更新联系人"),
                        "expected_revision": contact["revision"],
                    },
                )
                assert response.status_code == 200
                assert response.json()["name"] == "并发更新联系人"
            else:
                response = client.request("DELETE",
                    path,
                    json={"expected_revision": contact["revision"]},
                )
                assert response.status_code == 204

    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 1
    finally:
        connection.close()


def test_duplicate_company_name_is_case_insensitive_and_unchanged(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        original = _create_company(client, "Acme")
        response = client.post("/api/companies", json=_company_payload("aCmE"))
        listed = client.get("/api/companies")

    assert response.status_code == 409
    assert response.json() == {"detail": "Company name already exists"}
    assert listed.json() == [
        {**{key: original[key] for key in COMPANY_KEYS}, "contact_count": 0}
    ]


def test_put_rejects_duplicate_company_name_without_changing_either_company(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        first = _create_company(client, "Acme")
        second = _create_company(client, "Beta")
        replacement = {
            **_company_payload("aCmE"),
            "expected_revision": second["revision"],
        }

        response = client.put(
            f"/api/companies/{second['id']}",
            json=replacement,
        )
        first_after = client.get(f"/api/companies/{first['id']}")
        second_after = client.get(f"/api/companies/{second['id']}")

    assert response.status_code == 409
    assert response.json() == {"detail": "Company name already exists"}
    assert first_after.json() == first
    assert second_after.json() == second


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {**_company_payload(), "unknown": "private"},
        {key: value for key, value in _company_payload().items() if key != "notes"},
        {**_company_payload(), "name": " \t\n "},
        {**_company_payload(), "name": None},
        {**_company_payload(), "taxpayer_id": 123},
        {**_company_payload(), "registered_address": []},
        {**_company_payload(), "registered_phone": True},
        {**_company_payload(), "bank_name": {}},
        {**_company_payload(), "bank_account": ["private"]},
        {**_company_payload(), "notes": 1.5},
        [*list(_company_payload().values())],
        None,
    ],
)
@pytest.mark.parametrize("method", ["post", "put"])
def test_company_writes_reject_invalid_payload_with_fixed_detail(
    harness: CompaniesHarness,
    payload: Any,
    method: str,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        target = (
            "/api/companies" if method == "post" else f"/api/companies/{company['id']}"
        )
        request_payload = payload
        if method == "put" and isinstance(payload, dict) and set(payload) == set(
            _company_payload()
        ):
            request_payload = {**payload, "expected_revision": company["revision"]}
        response = client.request(method, target, json=request_payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid company payload"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {**_contact_payload(), "unknown": "private"},
        {key: value for key, value in _contact_payload().items() if key != "notes"},
        {**_contact_payload(), "name": " \t\n "},
        {**_contact_payload(), "name": 123},
        {**_contact_payload(), "phone": []},
        {**_contact_payload(), "email": True},
        {**_contact_payload(), "position": {}},
        {**_contact_payload(), "notes": ["private"]},
        None,
    ],
)
@pytest.mark.parametrize("method", ["post", "put"])
def test_contact_writes_reject_invalid_payload_with_fixed_detail(
    harness: CompaniesHarness,
    payload: Any,
    method: str,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
        target = (
            f"/api/companies/{company['id']}/contacts"
            if method == "post"
            else f"/api/companies/{company['id']}/contacts/{contact['id']}"
        )
        request_payload = payload
        if method == "put" and isinstance(payload, dict) and set(payload) == set(
            _contact_payload()
        ):
            request_payload = {**payload, "expected_revision": contact["revision"]}
        response = client.request(method, target, json=request_payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid contact payload"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    ("resource", "field"),
    [
        *(("company", field) for field in _company_payload()),
        *(("contact", field) for field in _contact_payload()),
    ],
)
@pytest.mark.parametrize("invalid_text", ["\ud800", "\x00"])
@pytest.mark.parametrize("method", ["post", "put"])
def test_text_fields_reject_values_sqlite_cannot_store_safely(
    harness: CompaniesHarness,
    resource: str,
    field: str,
    invalid_text: str,
    method: str,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
        if resource == "company":
            company = _create_company(client) if method == "put" else None
            path = (
                "/api/companies"
                if company is None
                else f"/api/companies/{company['id']}"
            )
            payload = _company_payload()
            detail = "Invalid company payload"
        else:
            company = _create_company(client)
            contact = (
                _create_contact(client, company["id"]) if method == "put" else None
            )
            path = (
                f"/api/companies/{company['id']}/contacts"
                if contact is None
                else f"/api/companies/{company['id']}/contacts/{contact['id']}"
            )
            payload = _contact_payload()
            detail = "Invalid contact payload"
        payload[field] = invalid_text
        if method == "put":
            payload["expected_revision"] = (
                company["revision"] if resource == "company" else contact["revision"]
            )
        response = client.request(
            method,
            path,
            content=json.dumps(payload, ensure_ascii=True).encode("ascii"),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert "ud800" not in response.text


@pytest.mark.parametrize(
    ("method", "path", "detail"),
    [
        ("post", "/api/companies", "Invalid company payload"),
        ("put", "/api/companies/1", "Invalid company payload"),
        ("post", "/api/companies/1/contacts", "Invalid contact payload"),
        ("put", "/api/companies/1/contacts/1", "Invalid contact payload"),
    ],
)
def test_deeply_nested_json_has_fixed_422(
    harness: CompaniesHarness,
    method: str,
    path: str,
    detail: str,
) -> None:
    nested = "[" * 10_000 + "0" + "]" * 10_000

    with harness.client(raise_server_exceptions=False) as client:
        response = client.request(
            method,
            path,
            content=(f'{{"name":{nested}}}').encode(),
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": detail}


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", "/api/companies", None),
        ("post", "/api/companies", _company_payload()),
        ("get", "/api/companies/1", None),
        ("put", "/api/companies/1", _company_payload()),
        ("delete", "/api/companies/1", None),
        ("post", "/api/companies/1/contacts", _contact_payload()),
        ("put", "/api/companies/1/contacts/1", _contact_payload()),
        ("delete", "/api/companies/1/contacts/1", None),
    ],
)
def test_every_business_route_requires_authentication(
    harness: CompaniesHarness,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    with harness.client(authenticated=False) as client:
        response = client.request(method, path, json=payload)

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/companies"),
        ("put", "/api/companies/1"),
        ("post", "/api/companies/1/contacts"),
        ("put", "/api/companies/1/contacts/1"),
    ],
)
def test_authentication_precedes_malformed_json(
    harness: CompaniesHarness,
    method: str,
    path: str,
) -> None:
    with harness.client(authenticated=False) as client:
        response = client.request(
            method,
            path,
            content=b'{"private":',
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    ("method", "path", "detail"),
    [
        ("post", "/api/companies", "Invalid company payload"),
        ("put", "/api/companies/1", "Invalid company payload"),
        ("post", "/api/companies/1/contacts", "Invalid contact payload"),
        ("put", "/api/companies/1/contacts/1", "Invalid contact payload"),
    ],
)
def test_authenticated_malformed_json_has_fixed_422_detail(
    harness: CompaniesHarness,
    method: str,
    path: str,
    detail: str,
) -> None:
    with harness.client() as client:
        response = client.request(
            method,
            path,
            content=b'{"private":',
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert "private" not in response.text


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", "/api/companies/private", None),
        ("put", "/api/companies/private", _company_payload()),
        ("delete", "/api/companies/private", None),
        ("post", "/api/companies/private/contacts", _contact_payload()),
        ("put", "/api/companies/1/contacts/private", _contact_payload()),
        ("delete", "/api/companies/1/contacts/private", None),
    ],
)
def test_invalid_identifiers_have_fixed_422_without_echo(
    harness: CompaniesHarness,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    with harness.client() as client:
        response = client.request(method, path, json=payload)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid identifier"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    "identifier",
    [
        "+1",
        "1_0",
        "０１",
        "0",
        "-1",
        "9223372036854775808",
    ],
)
@pytest.mark.parametrize(
    ("method", "path_template"),
    [
        ("get", "/api/companies/{identifier}"),
        ("delete", "/api/companies/1/contacts/{identifier}"),
    ],
)
def test_identifiers_accept_only_positive_ascii_sqlite_integers(
    harness: CompaniesHarness,
    identifier: str,
    method: str,
    path_template: str,
) -> None:
    with harness.client(raise_server_exceptions=False) as client:
        response = client.request(
            method,
            path_template.format(identifier=identifier),
        )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid identifier"}
    assert identifier not in response.text


def test_largest_sqlite_identifier_is_valid_but_not_found(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        response = client.get("/api/companies/9223372036854775807")

    assert response.status_code == 404
    assert response.json() == {"detail": "Company not found"}


def test_very_long_ascii_identifier_has_fixed_422(harness: CompaniesHarness) -> None:
    identifier = "9" * 4301

    with harness.client(raise_server_exceptions=False) as client:
        response = client.get(f"/api/companies/{identifier}")

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid identifier"}
    assert identifier not in response.text


def test_missing_company_and_contact_resources_return_fixed_404(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        company_get = client.get("/api/companies/999")
        company_put = client.put(
            "/api/companies/999",
            json={**_company_payload(), "expected_revision": 1},
        )
        company_delete = client.request("DELETE",
            "/api/companies/999", json={"expected_revision": 1}
        )
        contact_post = client.post(
            "/api/companies/999/contacts",
            json=_contact_payload(),
        )
        contact_put = client.put(
            "/api/companies/999/contacts/999",
            json={**_contact_payload(), "expected_revision": 1},
        )
        contact_delete = client.request("DELETE",
            "/api/companies/999/contacts/999",
            json={"expected_revision": 1},
        )

    for response in (company_get, company_put, company_delete, contact_post):
        assert response.status_code == 404
        assert response.json() == {"detail": "Company not found"}
    for response in (contact_put, contact_delete):
        assert response.status_code == 404
        assert response.json() == {"detail": "Contact not found"}


def test_unexpected_database_failure_logs_diagnostics_without_client_leak(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    failure = _missing_table_error()
    harness = _build_harness(
        tmp_path,
        commit_failure=failure,
    )
    caplog.set_level(logging.ERROR, logger=companies_module.__name__)

    with harness.client(raise_server_exceptions=False) as client:
        response = client.post("/api/companies", json=_company_payload())

    assert response.status_code == 500
    assert response.json() == {"detail": "Company operation failed"}
    assert "private_secret_table" not in response.text
    records = [
        record
        for record in caplog.records
        if record.name == companies_module.__name__ and record.levelno == logging.ERROR
    ]
    assert len(records) == 1
    assert records[0].getMessage() == (
        "Company database operation failed "
        "(sqlite_errorcode=1, sqlite_errorname=SQLITE_ERROR)"
    )
    assert records[0].exc_info is not None
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("path", "sql_prefix"),
    [
        ("/api/companies", "SELECT COMPANIES.ID,"),
        ("/api/companies/1", "SELECT ID, NAME,"),
    ],
)
def test_unexpected_read_failure_logs_and_returns_fixed_500(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    path: str,
    sql_prefix: str,
) -> None:
    harness = _build_harness(
        tmp_path,
        execute_failure=(sql_prefix, _missing_table_error()),
    )
    caplog.set_level(logging.ERROR, logger=companies_module.__name__)

    with harness.client(raise_server_exceptions=False) as client:
        response = client.get(path)

    assert response.status_code == 500
    assert response.json() == {"detail": "Company operation failed"}
    assert "private_secret_table" not in response.text
    records = [
        record
        for record in caplog.records
        if record.name == companies_module.__name__ and record.levelno == logging.ERROR
    ]
    assert len(records) == 1
    assert records[0].getMessage() == (
        "Company database operation failed "
        "(sqlite_errorcode=1, sqlite_errorname=SQLITE_ERROR)"
    )
    assert records[0].exc_info is not None


@pytest.mark.parametrize("project_status", ["active", "archived"])
def test_expected_integrity_conflicts_do_not_log_errors(
    harness: CompaniesHarness,
    caplog: pytest.LogCaptureFixture,
    project_status: str,
) -> None:
    caplog.set_level(logging.ERROR, logger=companies_module.__name__)
    with harness.client() as client:
        company = _create_company(client)
        duplicate = client.post(
            "/api/companies",
            json=_company_payload(company["name"].swapcase()),
        )
        missing_company = client.post(
            "/api/companies/999/contacts",
            json=_contact_payload(),
        )
    connection = connect_database(harness.database_path)
    try:
        archived_at = NOW.isoformat() if project_status == "archived" else None
        project_code = f"EXPECTED-{project_status}"
        connection.execute(
            """
            INSERT INTO projects
                (project_code, project_code_key, company_id, name,
                 status, archived_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_code,
                project_code_identity(project_code),
                company["id"],
                "预期项目引用",
                project_status,
                archived_at,
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
    finally:
        connection.close()
    with harness.client() as client:
        referenced = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )

    assert duplicate.status_code == 409
    assert missing_company.status_code == 404
    assert referenced.status_code == 409
    assert not [
        record
        for record in caplog.records
        if record.name == companies_module.__name__ and record.levelno >= logging.ERROR
    ]


def test_non_foreign_key_delete_integrity_error_logs_and_returns_fixed_500(
    harness: CompaniesHarness,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_company_delete
            BEFORE DELETE ON companies
            BEGIN
                SELECT RAISE(ABORT, 'private trigger detail');
            END
            """
        )
    finally:
        connection.close()
    caplog.set_level(logging.ERROR, logger=companies_module.__name__)

    with harness.client() as client:
        response = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Company operation failed"}
    assert "private trigger detail" not in response.text
    records = [
        record
        for record in caplog.records
        if record.name == companies_module.__name__ and record.levelno == logging.ERROR
    ]
    assert len(records) == 1
    assert "sqlite_errorcode=1811" in records[0].getMessage()
    assert "sqlite_errorname=SQLITE_CONSTRAINT_TRIGGER" in records[0].getMessage()
    assert records[0].exc_info is not None
    with harness.client() as client:
        detail = client.get(f"/api/companies/{company['id']}")
    assert detail.status_code == 200


def test_project_reference_confirmation_failure_logs_the_confirmation_error(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    harness = _build_harness(
        tmp_path,
        execute_failure=(
            "SELECT 1 FROM PROJECTS WHERE COMPANY_ID = ? LIMIT 1",
            _missing_table_error(),
        ),
    )
    with harness.client() as client:
        company = _create_company(client)
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            CREATE TRIGGER reject_company_confirmation
            BEFORE DELETE ON companies
            BEGIN
                SELECT RAISE(ABORT, 'force project confirmation');
            END
            """
        )
    finally:
        connection.close()
    caplog.set_level(logging.ERROR, logger=companies_module.__name__)

    with harness.client() as client:
        response = client.request("DELETE",
            f"/api/companies/{company['id']}",
            json={"expected_revision": company["revision"]},
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Company operation failed"}
    assert "private_secret_table" not in response.text
    records = [
        record
        for record in caplog.records
        if record.name == companies_module.__name__ and record.levelno == logging.ERROR
    ]
    assert len(records) == 1
    assert records[0].getMessage() == (
        "Company database operation failed "
        "(sqlite_errorcode=1, sqlite_errorname=SQLITE_ERROR)"
    )
    assert records[0].exc_info is not None


def test_responses_do_not_disclose_secrets_or_paths(harness: CompaniesHarness) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
        responses = [
            client.get("/api/companies"),
            client.get(f"/api/companies/{company['id']}"),
        ]

    serialized = " ".join(response.text for response in responses)
    assert set(company) == COMPANY_KEYS | {"contacts"}
    assert set(contact) == CONTACT_KEYS
    assert "session_secret" not in serialized
    assert "password_hash" not in serialized
    assert str(harness.database_path) not in serialized
    assert harness.settings.session_secret not in serialized


def test_revision_migration_upgrades_existing_companies_and_contacts(
    tmp_path: Path,
) -> None:
    staged_migrations = tmp_path / "migrations"
    staged_migrations.mkdir()
    migration_paths = sorted((PROJECT_ROOT / "backend" / "migrations").glob("*.sql"))
    for migration_path in migration_paths:
        if migration_path.name >= "015_write_safety.sql":
            continue
        shutil.copy2(migration_path, staged_migrations / migration_path.name)

    database_path = tmp_path / "upgrade.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, staged_migrations)
        company_id = connection.execute(
            """
            INSERT INTO companies (name, created_at, updated_at)
            VALUES ('升级前公司', ?, ?)
            """,
            (NOW.isoformat(), NOW.isoformat()),
        ).lastrowid
        assert company_id is not None
        contact_id = connection.execute(
            """
            INSERT INTO contacts (company_id, name, created_at, updated_at)
            VALUES (?, '升级前联系人', ?, ?)
            """,
            (company_id, NOW.isoformat(), NOW.isoformat()),
        ).lastrowid
        assert contact_id is not None

        migration = PROJECT_ROOT / "backend" / "migrations" / "015_write_safety.sql"
        shutil.copy2(migration, staged_migrations / migration.name)
        assert apply_migrations(connection, staged_migrations) == ["015_write_safety"]

        assert connection.execute(
            "SELECT revision FROM companies WHERE id = ?", (company_id,)
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT revision FROM contacts WHERE id = ?", (contact_id,)
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_company_create_idempotency_replays_same_response_and_rejects_new_body(
    harness: CompaniesHarness,
) -> None:
    headers = {"Idempotency-Key": IDEMPOTENCY_KEY}
    with harness.client() as client:
        created = client.post(
            "/api/companies", json=_company_payload("幂等公司"), headers=headers
        )
        replayed = client.post(
            "/api/companies", json=_company_payload("幂等公司"), headers=headers
        )
        reused = client.post(
            "/api/companies", json=_company_payload("另一个公司"), headers=headers
        )
        listed = client.get("/api/companies")

    assert created.status_code == 201
    assert created.json()["revision"] == 1
    assert replayed.status_code == 201
    assert replayed.json() == created.json()
    assert reused.status_code == 409
    assert reused.json() == {
        "detail": "Idempotency key reused",
        "error_code": "IDEMPOTENCY_KEY_REUSED",
        "field_errors": {},
        "current_revision": None,
    }
    assert [row["name"] for row in listed.json()] == ["幂等公司"]


def test_contact_create_idempotency_replays_without_duplicate(
    harness: CompaniesHarness,
) -> None:
    headers = {"Idempotency-Key": IDEMPOTENCY_KEY}
    with harness.client() as client:
        company = _create_company(client)
        path = f"/api/companies/{company['id']}/contacts"
        created = client.post(path, json=_contact_payload("幂等联系人"), headers=headers)
        replayed = client.post(path, json=_contact_payload("幂等联系人"), headers=headers)
        reused = client.post(path, json=_contact_payload("另一个联系人"), headers=headers)
        detail = client.get(f"/api/companies/{company['id']}")

    assert created.status_code == 201
    assert created.json()["revision"] == 1
    assert replayed.json() == created.json()
    assert reused.status_code == 409
    assert reused.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    assert [row["name"] for row in detail.json()["contacts"]] == ["幂等联系人"]


def test_company_update_rejects_stale_revision_without_overwriting(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        first = client.put(
            f"/api/companies/{company['id']}",
            json={**_company_payload("第一页修改"), "expected_revision": 1},
        )
        stale = client.put(
            f"/api/companies/{company['id']}",
            json={**_company_payload("第二页旧表单"), "expected_revision": 1},
        )
        current = client.get(f"/api/companies/{company['id']}")

    assert first.status_code == 200
    assert first.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json() == {
        "detail": "Resource was modified",
        "error_code": "REVISION_CONFLICT",
        "field_errors": {},
        "current_revision": 2,
    }
    assert stale.headers["X-Current-Revision"] == "2"
    assert current.json()["name"] == "第一页修改"
    assert current.json()["revision"] == 2


def test_contact_update_rejects_stale_revision_without_overwriting(
    harness: CompaniesHarness,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        contact = _create_contact(client, company["id"])
        path = f"/api/companies/{company['id']}/contacts/{contact['id']}"
        first = client.put(
            path,
            json={**_contact_payload("第一页修改"), "expected_revision": 1},
        )
        stale = client.put(
            path,
            json={**_contact_payload("第二页旧表单"), "expected_revision": 1},
        )
        current = client.get(f"/api/companies/{company['id']}")

    assert first.status_code == 200
    assert first.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    assert stale.json()["current_revision"] == 2
    assert current.json()["contacts"][0]["name"] == "第一页修改"


@pytest.mark.parametrize("resource", ["company", "contact"])
@pytest.mark.parametrize("operation", ["update", "delete"])
def test_existing_writes_require_expected_revision_with_structured_422(
    harness: CompaniesHarness,
    resource: str,
    operation: str,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        if resource == "company":
            path = f"/api/companies/{company['id']}"
            payload = _company_payload("无版本号公司") if operation == "update" else {}
        else:
            contact = _create_contact(client, company["id"])
            path = f"/api/companies/{company['id']}/contacts/{contact['id']}"
            payload = _contact_payload("无版本号联系人") if operation == "update" else {}
        response = client.request(
            "put" if operation == "update" else "delete",
            path,
            json=payload,
        )

    assert response.status_code == 422
    assert response.json()["error_code"] == "VALIDATION_ERROR"
    assert response.json()["current_revision"] is None


@pytest.mark.parametrize("resource", ["company", "contact"])
def test_delete_rejects_stale_revision_and_preserves_resource(
    harness: CompaniesHarness,
    resource: str,
) -> None:
    with harness.client() as client:
        company = _create_company(client)
        if resource == "company":
            path = f"/api/companies/{company['id']}"
            client.put(
                path,
                json={**_company_payload("已更新公司"), "expected_revision": 1},
            )
            stale = client.request("delete", path, json={"expected_revision": 1})
            current = client.get(path)
        else:
            contact = _create_contact(client, company["id"])
            path = f"/api/companies/{company['id']}/contacts/{contact['id']}"
            client.put(
                path,
                json={**_contact_payload("已更新联系人"), "expected_revision": 1},
            )
            stale = client.request("delete", path, json={"expected_revision": 1})
            current = client.get(f"/api/companies/{company['id']}")

    assert stale.status_code == 409
    assert stale.json()["error_code"] == "REVISION_CONFLICT"
    assert stale.json()["current_revision"] == 2
    assert current.status_code == 200


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


def _missing_table_error() -> sqlite3.OperationalError:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("SELECT * FROM private_secret_table")
    except sqlite3.OperationalError as failure:
        return failure
    finally:
        connection.close()
    raise AssertionError("missing table probe unexpectedly succeeded")


class _ProjectRaceConnection:
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
        if not self._injected and normalized_sql == "BEGIN IMMEDIATE":
            company = self._connection.execute(
                """
                SELECT companies.id
                FROM companies
                WHERE NOT EXISTS (
                    SELECT 1 FROM projects WHERE projects.company_id = companies.id
                )
                ORDER BY companies.id
                LIMIT 1
                """
            ).fetchone()
            if company is None:
                return self._connection.execute(sql, parameters)
            company_id = int(company["id"])
            competitor = connect_database(self._database_path)
            try:
                project_code = f"RACE-{company_id}"
                competitor.execute(
                    """
                    INSERT INTO projects
                        (project_code, project_code_key, company_id, name,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project_code,
                        project_code_identity(project_code),
                        company_id,
                        "并发项目",
                        NOW.isoformat(),
                        NOW.isoformat(),
                    ),
                )
            finally:
                competitor.close()
            self._injected = True
        return self._connection.execute(sql, parameters)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _ConcurrentWriteConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        database_path: Path,
        write_prefix: str,
    ) -> None:
        self._connection = connection
        self._database_path = database_path
        self._write_prefix = write_prefix
        self._injected = False
        self._immediate_started = False

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        normalized_sql = " ".join(sql.split()).upper()
        if normalized_sql == "BEGIN IMMEDIATE":
            self._immediate_started = True
        if not self._injected and normalized_sql.startswith(self._write_prefix):
            if not self._immediate_started:
                raise AssertionError("write started before BEGIN IMMEDIATE")
            self._injected = True
        return self._connection.execute(sql, parameters)

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
