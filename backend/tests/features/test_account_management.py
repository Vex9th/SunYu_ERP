import json
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest

from backend.tests.account_support import MEMBER_PASSWORD, make_access_app


@pytest.fixture
def harness(tmp_path: Path):
    return make_access_app(tmp_path)


def _create_group(owner, name="采购组"):
    response = owner.post("/api/workgroups", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _create_member(owner, group_id=None):
    response = owner.post(
        "/api/accounts",
        json={
            "username": "buyer",
            "password": MEMBER_PASSWORD,
            "display_name": "采购张姐",
            "group_id": group_id,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_management_routes_require_real_account(harness):
    assert harness.client().get("/api/accounts").status_code == 401


def test_member_cannot_manage_self_or_read_accounts(harness):
    owner = harness.owner_client()
    group = _create_group(owner)
    account = _create_member(owner, group["id"])
    member = harness.member_client()
    assert member.get("/api/accounts").status_code == 403
    assert member.get("/api/workgroups").status_code == 403
    assert member.get("/api/permissions/catalog").status_code == 403
    assert (
        member.patch(
            f"/api/accounts/{account['id']}",
            json={"group_id": None, "expected_revision": 1},
        ).status_code
        == 403
    )


def test_owner_protection_and_revision_conflicts(harness):
    owner = harness.owner_client()
    account = owner.get("/api/auth/session").json()["user"]
    for payload in ({"enabled": False}, {"group_id": 1}):
        assert (
            owner.patch(
                f"/api/accounts/{account['id']}",
                json={**payload, "expected_revision": 1},
            ).status_code
            == 409
        )
    updated = owner.patch(
        f"/api/accounts/{account['id']}",
        json={"display_name": "新主账号名", "expected_revision": 1},
    )
    assert updated.status_code == 200
    assert (
        owner.patch(
            f"/api/accounts/{account['id']}",
            json={"display_name": "旧更新", "expected_revision": 1},
        ).status_code
        == 409
    )


def test_group_validates_unknown_permissions_dependencies_and_projects(harness):
    owner = harness.owner_client()
    group = _create_group(owner)
    url = f"/api/workgroups/{group['id']}/access"
    for keys, projects in [
        (["unknown.permission"], []),
        (["procurement.payments.register"], []),
        (["projects.view"], [999999]),
        (["projects.view"], [True]),
    ]:
        response = owner.put(
            url,
            json={
                "permission_keys": keys,
                "project_ids": projects,
                "expected_revision": 1,
            },
        )
        assert response.status_code == 422, response.text
    good = owner.put(
        url,
        json={
            "permission_keys": [
                "procurement.payments.view",
                "procurement.payments.register",
            ],
            "project_ids": [],
            "expected_revision": 1,
        },
    )
    assert good.status_code == 200
    stale = owner.put(
        url, json={"permission_keys": [], "project_ids": [], "expected_revision": 1}
    )
    assert stale.status_code == 409


def test_group_unique_names_and_archive_requires_empty_membership(harness):
    owner = harness.owner_client()
    group = _create_group(owner, "Finance")
    assert (
        owner.post("/api/workgroups", json={"name": "ＦＩＮＡＮＣＥ"}).status_code
        == 409
    )
    account = _create_member(owner, group["id"])
    url = f"/api/workgroups/{group['id']}"
    assert (
        owner.request("DELETE", url, json={"expected_revision": 1}).status_code == 409
    )
    assert (
        owner.patch(
            f"/api/accounts/{account['id']}",
            json={"group_id": None, "expected_revision": 1},
        ).status_code
        == 200
    )
    archived = owner.request("DELETE", url, json={"expected_revision": 1})
    assert archived.status_code == 200
    assert archived.json()["archived"] is True and archived.json()["enabled"] is False
    assert (
        owner.patch(url, json={"enabled": True, "expected_revision": 2}).status_code
        == 409
    )


def test_transfer_revoke_and_group_disable_apply_to_existing_cookie(harness):
    owner = harness.owner_client()
    first, second = _create_group(owner), _create_group(owner, "财务组")
    owner.put(
        f"/api/workgroups/{first['id']}/access",
        json={
            "permission_keys": ["documents.view"],
            "project_ids": [],
            "expected_revision": 1,
        },
    )
    account = _create_member(owner, first["id"])
    member = harness.member_client()
    before = member.get("/api/auth/session").json()
    assert before["permissions"] == ["documents.view"]
    assert (
        owner.patch(
            f"/api/accounts/{account['id']}",
            json={"group_id": second["id"], "expected_revision": 1},
        ).status_code
        == 200
    )
    with harness.connection() as connection:
        event = connection.execute(
            "SELECT changes_json FROM operation_events WHERE action='accounts.update' AND resource_id=? ORDER BY id DESC LIMIT 1",
            (str(account["id"]),),
        ).fetchone()
    assert json.loads(event["changes_json"])["group_name"] == {
        "before": first["name"], "after": second["name"]
    }
    after = member.get("/api/auth/session").json()
    assert after["permissions"] == [] and after["user"]["group_id"] == second["id"]
    assert after["access_revision"] != before["access_revision"]
    assert (
        owner.put(
            f"/api/workgroups/{second['id']}/access",
            json={
                "permission_keys": ["documents.view"],
                "project_ids": [],
                "expected_revision": 1,
            },
        ).status_code
        == 200
    )
    assert member.get("/api/auth/session").json()["permissions"] == ["documents.view"]
    assert (
        owner.patch(
            f"/api/workgroups/{second['id']}",
            json={"enabled": False, "expected_revision": 2},
        ).status_code
        == 200
    )
    assert member.get("/api/auth/session").json()["permissions"] == []


def test_disable_and_password_reset_revoke_existing_sessions(harness):
    owner = harness.owner_client()
    account = _create_member(owner)
    member = harness.member_client()
    reset = owner.post(
        f"/api/accounts/{account['id']}/reset-password",
        json={"password": "ChangedPassword123", "expected_revision": 1},
    )
    assert reset.status_code == 200
    assert member.get("/_test/principal").status_code == 401
    assert (
        member.post(
            "/api/auth/login", json={"username": "buyer", "password": MEMBER_PASSWORD}
        ).status_code
        == 401
    )
    assert (
        member.post(
            "/api/auth/login",
            json={"username": "buyer", "password": "ChangedPassword123"},
        ).status_code
        == 204
    )
    assert (
        owner.patch(
            f"/api/accounts/{account['id']}",
            json={"enabled": False, "expected_revision": 2},
        ).status_code
        == 200
    )
    assert member.get("/_test/principal").status_code == 401
    assert (
        member.post(
            "/api/auth/login",
            json={"username": "buyer", "password": "ChangedPassword123"},
        ).status_code
        == 401
    )


def test_management_idempotency_and_audit_never_store_passwords(harness):
    owner = harness.owner_client()
    headers = {"Idempotency-Key": str(uuid4())}
    payload = {
        "username": "buyer",
        "password": MEMBER_PASSWORD,
        "display_name": "采购张姐",
        "group_id": None,
    }
    first = owner.post("/api/accounts", json=payload, headers=headers)
    second = owner.post("/api/accounts", json=payload, headers=headers)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert (
        owner.post(
            "/api/accounts",
            json={**payload, "password": "OtherPassword123"},
            headers=headers,
        ).status_code
        == 409
    )
    with harness.connection() as connection:
        events = connection.execute(
            "SELECT * FROM operation_events WHERE action = 'accounts.create'"
        ).fetchall()
        assert len(events) == 1
        stored = json.dumps([dict(row) for row in events]) + json.dumps(
            [
                dict(row)
                for row in connection.execute("SELECT * FROM idempotency_requests")
            ]
        )
        assert MEMBER_PASSWORD not in stored and "$argon2" not in stored
    assert "password" not in first.text


def test_failed_audit_rolls_back_account_write(harness):
    owner = harness.owner_client()
    with harness.connection() as connection:
        connection.execute(
            "CREATE TRIGGER test_fail_account_event BEFORE INSERT ON operation_events WHEN NEW.action = 'accounts.create' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END"
        )
    # The deliberate database failure may be translated to an API 500 or raised by TestClient.
    try:
        response = owner.post(
            "/api/accounts",
            json={
                "username": "buyer",
                "password": MEMBER_PASSWORD,
                "display_name": "采购",
            },
        )
    except sqlite3.DatabaseError:
        pass
    else:
        assert response.status_code == 500
    with harness.connection() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM accounts WHERE username_key = 'buyer'"
            ).fetchone()[0]
            == 0
        )


def test_quotes_and_material_advances_have_separate_view_dependencies(harness):
    owner = harness.owner_client()
    group = _create_group(owner)
    url = f"/api/workgroups/{group['id']}/access"
    assert (
        owner.put(
            url,
            json={
                "permission_keys": ["quotes.download"],
                "project_ids": [],
                "expected_revision": 1,
            },
        ).status_code
        == 422
    )
    keys = [
        "quotes.view",
        "quotes.create",
        "quotes.download",
        "material_advances.view",
        "material_advances.reimburse",
    ]
    assert (
        owner.put(
            url,
            json={"permission_keys": keys, "project_ids": [], "expected_revision": 1},
        ).status_code
        == 200
    )
