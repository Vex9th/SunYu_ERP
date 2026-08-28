from __future__ import annotations

import json
import logging
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
        "created_at": NOW.isoformat(),
        "updated_at": harness.clock.value.isoformat(),
    }


def test_contact_delete_checks_ownership(harness: CompaniesHarness) -> None:
    with harness.client() as client:
        company = _create_company(client, "甲公司")
        other = _create_company(client, "乙公司")
        contact = _create_contact(client, company["id"])

        wrong_company = client.delete(
            f"/api/companies/{other['id']}/contacts/{contact['id']}"
        )
        still_present = client.get(f"/api/companies/{company['id']}")
        deleted = client.delete(
            f"/api/companies/{company['id']}/contacts/{contact['id']}"
        )
        missing = client.delete(
            f"/api/companies/{company['id']}/contacts/{contact['id']}"
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

        deleted = client.delete(f"/api/companies/{company['id']}")

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
        connection.execute(
            """
            INSERT INTO projects
                (project_code, company_id, name, status, archived_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"P-{project_status}",
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
        response = client.delete(f"/api/companies/{company['id']}")
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
        response = client.delete(f"/api/companies/{company['id']}")
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
def test_writes_do_not_upgrade_a_stale_read_snapshot(
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
                json=_company_payload("并发更新公司"),
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
                response = client.put(path, json=_contact_payload("并发更新联系人"))
                assert response.status_code == 200
                assert response.json()["name"] == "并发更新联系人"
            else:
                response = client.delete(path)
                assert response.status_code == 204

    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 2
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
        replacement = _company_payload("aCmE")

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
        response = client.request(method, target, json=payload)

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
        response = client.request(method, target, json=payload)

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
        company_put = client.put("/api/companies/999", json=_company_payload())
        company_delete = client.delete("/api/companies/999")
        contact_post = client.post(
            "/api/companies/999/contacts",
            json=_contact_payload(),
        )
        contact_put = client.put(
            "/api/companies/999/contacts/999",
            json=_contact_payload(),
        )
        contact_delete = client.delete("/api/companies/999/contacts/999")

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
        connection.execute(
            """
            INSERT INTO projects
                (project_code, company_id, name, status, archived_at,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"EXPECTED-{project_status}",
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
        referenced = client.delete(f"/api/companies/{company['id']}")

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
        response = client.delete(f"/api/companies/{company['id']}")

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
        response = client.delete(f"/api/companies/{company['id']}")

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
        if not self._injected and normalized_sql.startswith(
            "DELETE FROM COMPANIES WHERE ID = ?"
        ):
            company_id = cast(tuple[int], parameters)[0]
            competitor = connect_database(self._database_path)
            try:
                competitor.execute(
                    """
                    INSERT INTO projects
                        (project_code, company_id, name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        f"RACE-{company_id}",
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

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        normalized_sql = " ".join(sql.split()).upper()
        if not self._injected and normalized_sql.startswith(self._write_prefix):
            competitor = connect_database(self._database_path)
            try:
                marker = f"并发公司-{id(self)}"
                competitor.execute(
                    """
                    INSERT INTO companies (name, created_at, updated_at)
                    VALUES (?, ?, ?)
                    """,
                    (marker, NOW.isoformat(), NOW.isoformat()),
                )
            finally:
                competitor.close()
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
