import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app.core.database import connect_database
from backend.app.main import create_app


class NoScheduler:
    def __init__(self, **kwargs):
        pass

    def start(self):
        pass

    def stop(self):
        pass

    def snapshot(self):
        return {}


@pytest.fixture
def business(tmp_path):
    config = tmp_path / "config.json"
    data = tmp_path / "DATA"
    config.write_text(
        json.dumps(
            {
                "data_dir": str(data),
                "backup_enabled": False,
                "session_secret": "synthetic-business-access-secret-32-characters",
            }
        )
    )
    app = create_app(
        config_path=config,
        migrations_dir=Path("backend/migrations"),
        scheduler_factory=NoScheduler,
    )
    with TestClient(
        app, base_url="http://127.0.0.1", client=("127.0.0.1", 12345)
    ) as owner:
        response = owner.post(
            "/api/auth/bootstrap",
            json={
                "username": "owner",
                "display_name": "主账号",
                "password": "SyntheticOwner123",
            },
        )
        assert response.status_code == 200, response.text
        connection = connect_database(data / "iapm.sqlite")
        connection.execute(
            "INSERT INTO companies(id,name,created_at,updated_at) VALUES(1,'合成供应商','2026-11-01','2026-11-01')"
        )
        for i in (1, 2):
            connection.execute(
                """INSERT INTO projects(id,project_code,project_code_key,company_id,name,created_at,updated_at)
                VALUES(?,?,?,1,?,'2026-11-01','2026-11-01')""",
                (i, f"TEST-{i}", f"test-{i}", f"测试项目{i}"),
            )
        yield owner, app, connection
        connection.close()


def member(business, permissions, username="buyer"):
    owner, app, _connection = business
    group = owner.post("/api/workgroups", json={"name": f"组-{username}"}).json()
    response = owner.put(
        f"/api/workgroups/{group['id']}/access",
        json={
            "expected_revision": group["revision"],
            "permission_keys": permissions,
            "project_ids": [1],
        },
    )
    assert response.status_code == 200, response.text
    response = owner.post(
        "/api/accounts",
        json={
            "username": username,
            "password": "SyntheticBuyer123",
            "display_name": "采购张姐",
            "group_id": group["id"],
        },
    )
    assert response.status_code == 201, response.text
    client = TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 12346))
    response = client.post(
        "/api/auth/login", json={"username": username, "password": "SyntheticBuyer123"}
    )
    assert response.status_code == 204, response.text
    return client, response, group


def test_owner_business_write_has_inline_atomic_history(business):
    owner, _, _db = business
    response = owner.post(
        "/api/companies",
        json={
            "name": "审计测试公司",
            "taxpayer_id": None,
            "registered_address": None,
            "registered_phone": None,
            "bank_name": None,
            "bank_account": None,
            "notes": None,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    company = response.json()
    assert company["activity_summary"]["created_by"] == "主账号"
    history = owner.get(f"/api/operation-history/company/{company['id']}")
    assert history.status_code == 200, history.text
    assert history.json()["items"][0]["actor_name"] == "主账号"


def test_project_module_and_owner_only_routes_are_enforced(business):
    client, _, _ = member(business, ["projects.view", "companies.view"])
    response = client.get("/api/projects")
    assert response.status_code == 200, response.text
    assert [p["id"] for p in response.json()] == [1]
    assert client.get("/api/projects/TEST-2").status_code == 403
    assert client.post("/api/companies", json={"name": "禁止创建"}).status_code == 403
    assert client.get("/api/system/overview").status_code == 403
    assert client.get("/api/system/updates").status_code == 403


def test_every_business_route_has_explicit_policy():
    from fastapi.routing import APIRoute

    from backend.app.features.access_policy import policy_for_route

    app = create_app()
    missing = []
    for route in app.state.business_routes:
        if (
            isinstance(route, APIRoute)
            and route.path.startswith("/api/")
            and policy_for_route(route) is None
        ):
            missing.append((route.path, route.name))
    assert not missing


def test_same_key_isolated_by_account_and_transfer_revokes_replay(business):
    owner, _app, db = business
    keys = ["projects.view", "companies.view", "companies.create"]
    first, _, group = member(business, keys)
    second, _, _ = member(business, keys, "buyer2")
    key = str(uuid4())
    payload = {
        "name": "账号一公司",
        "taxpayer_id": None,
        "registered_address": None,
        "registered_phone": None,
        "bank_name": None,
        "bank_account": None,
        "notes": None,
    }
    response = first.post(
        "/api/companies", json=payload, headers={"Idempotency-Key": key}
    )
    assert response.status_code == 201, response.text
    first_id = response.json()["id"]
    repeated = first.post(
        "/api/companies", json=payload, headers={"Idempotency-Key": key}
    )
    assert repeated.status_code == 201 and repeated.json()["id"] == first_id
    second_response = second.post(
        "/api/companies",
        json={**payload, "name": "账号二公司"},
        headers={"Idempotency-Key": key},
    )
    assert second_response.status_code == 201, second_response.text
    assert second_response.json()["id"] != first_id
    assert (
        db.execute(
            "SELECT COUNT(*) FROM operation_events WHERE resource_type='company' AND resource_id=?",
            (str(first_id),),
        ).fetchone()[0]
        == 1
    )
    group = owner.get("/api/workgroups").json()[0]
    response = owner.put(
        f"/api/workgroups/{group['id']}/access",
        json={
            "permission_keys": ["projects.view", "companies.view"],
            "project_ids": [2],
            "expected_revision": group["revision"],
        },
    )
    assert response.status_code == 200, response.text
    assert (
        first.post(
            "/api/companies", json=payload, headers={"Idempotency-Key": key}
        ).status_code
        == 403
    )
    assert first.get("/api/projects/TEST-1").status_code == 403


def test_banking_fields_are_redacted_in_records_and_history(business):
    owner, _, _db = business
    payload = {
        "name": "银行资料测试",
        "taxpayer_id": None,
        "registered_address": None,
        "registered_phone": None,
        "bank_name": "秘密开户行",
        "bank_account": "secret-account",
        "notes": None,
    }
    created = owner.post("/api/companies", json=payload)
    assert created.status_code == 201, created.text
    client, _, _ = member(business, ["projects.view", "companies.view"])
    detail = client.get(f"/api/companies/{created.json()['id']}")
    assert detail.status_code == 200 and detail.json()["bank_account"] is None
    assert "secret-account" not in detail.text
    history = client.get(f"/api/operation-history/company/{created.json()['id']}")
    assert history.status_code == 200, history.text
    assert "secret-account" not in history.text


@pytest.mark.parametrize("multipart", [False, True])
def test_contract_allocation_cannot_add_ungranted_project(business, multipart):
    client, _, _ = member(
        business, ["projects.view", "contracts.view", "contracts.create"]
    )
    payload = {
        "contract_no": "SECRET-ALLOCATION",
        "title": "测试合同",
        "customer_company_id": 1,
        "total_amount_cents": 10000,
        "signed_on": None,
        "final_delivery_on": None,
        "notes": None,
        "document_version_ids": [],
        "allocations": [
            {"project_code": "TEST-1", "amount_cents": 1000},
            {"project_code": "TEST-2", "amount_cents": 9000},
        ],
    }
    kwargs = (
        {"json": payload}
        if not multipart
        else {"files": {"payload": (None, json.dumps(payload), "application/json")}}
    )
    response = client.post(
        "/api/projects/TEST-1/contracts",
        headers={"Idempotency-Key": str(uuid4())},
        **kwargs,
    )
    assert response.status_code == 403, response.text
    assert business[2].execute("SELECT COUNT(*) FROM contracts").fetchone()[0] == 0


def test_customer_receipt_summary_does_not_use_same_id_goods_receipt(business):
    owner, _, database = business
    database.execute("""INSERT INTO contracts(id,contract_no,title,customer_company_id,status,signed_on,
        total_amount_cents,final_delivery_on,created_at,updated_at)
        VALUES(1,'TEST-RECEIPT','合成收款合同',1,'signed','2026-10-31',1000,'2026-11-01','2026-11-01','2026-11-01')""")
    database.execute(
        "INSERT INTO contract_project_allocations(id,contract_id,project_id,amount_cents) VALUES(1,1,1,1000)"
    )
    response = owner.post(
        "/api/projects/TEST-1/receipts",
        json={
            "contract_allocation_id": 1,
            "milestone": "advance",
            "received_on": "2026-11-01",
            "amount_cents": 1000,
            "payment_method": "bank_transfer",
            "reference_no": None,
            "notes": None,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    receipt = response.json()
    database.execute(
        """INSERT INTO operation_events
        (request_id,action,resource_type,resource_id,actor_kind,actor_name,summary,occurred_at)
        VALUES('collision','procurement.receipts.register','goods_receipt',?,'user','其他到货人','登记到货','2026-11-01')""",
        (str(receipt["id"]),),
    )
    overview = owner.get("/api/projects/TEST-1/payments")
    assert overview.status_code == 200, overview.text
    row = next(
        item for item in overview.json()["receipts"] if item["id"] == receipt["id"]
    )
    assert row["activity_summary"]["last_actor"] == "主账号"
    assert row["activity_summary"]["last_action"] == "登记客户收款"
