from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import Request

from backend.app.features.access_policy import (
    bind_request_connection,
    protect_application_routes,
)
from backend.app.features.commercial import create_commercial_router
from backend.app.features.companies import create_companies_router
from backend.app.features.dashboards import create_dashboards_router
from backend.app.features.inventory import create_inventory_router
from backend.app.features.projects import create_projects_router
from backend.app.features.system import SettingsStore
from backend.tests.account_support import MEMBER_PASSWORD, make_access_app
from backend.tests.features.test_company_ledger import (
    _company,
    _contract,
    _order,
    _project,
    _receipt,
    _supplier_fact,
)


@pytest.fixture
def scoped(tmp_path: Path):
    harness = make_access_app(tmp_path)
    harness.app.state.settings = SettingsStore(harness.settings)

    def get_connection(request: Request) -> Iterator:
        with harness.connection() as connection:
            bind_request_connection(connection, request)
            yield connection

    for factory in (
        create_projects_router,
        create_dashboards_router,
        create_companies_router,
        create_commercial_router,
        create_inventory_router,
    ):
        router = factory(get_connection, lambda: harness.settings)
        protect_application_routes(router)
        harness.app.include_router(router)
    owner = harness.owner_client()
    with harness.connection() as connection:
        customer = _company(connection, "合成客户")
        supplier = _company(connection, "合成供应商")
        first, second = (
            _project(connection, customer, "ACCESS-A"),
            _project(connection, customer, "ACCESS-B"),
        )
        contract, allocations = _contract(
            connection,
            customer,
            "SECRET-CROSS-CONTRACT",
            [(first, 10000), (second, 90000)],
        )
        _receipt(connection, first, allocations[0], 1000)
        _receipt(connection, second, allocations[1], 50000)
        a = _order(connection, first, supplier, "ORDER-A", "confirmed", [(1000, 1000)])
        b = _order(connection, second, supplier, "ORDER-B", "confirmed", [(9000, 1000)])
        _supplier_fact(connection, "supplier_payments", a, 100)
        _supplier_fact(connection, "supplier_payments", b, 8000)
        connection.execute("""INSERT INTO inventory_items (id, brand,name,model,unit,quantity_milli,inventory_value_cents,create_idempotency_key,create_request_hash,created_at,updated_at)
            VALUES (1,'brand','共享物料','model','件',5000,5000,'scoped-item','scoped-hash','2026-11-01','2026-11-01')""")
        for index, project in enumerate((first, second, None), start=1):
            connection.execute(
                """INSERT INTO inventory_movements
                (inventory_item_id,project_id,movement_type,quantity_delta_milli,value_delta_cents,quantity_after_milli,value_after_cents,source_type,source_id,occurred_on,created_at)
                VALUES (1,?,'adjustment',1000,1000,5000,5000,'inventory_adjustment',?,'2026-11-01','2026-11-01')""",
                (project, index),
            )
    group = owner.post("/api/workgroups", json={"name": "采购组"}).json()
    keys = [
        "projects.view",
        "projects.create",
        "companies.view",
        "companies.create",
        "companies.edit",
        "company_ledger.view",
        "contracts.view",
        "customer_receipts.view",
        "customer_invoices.view",
        "procurement.orders.view",
        "procurement.payments.view",
        "procurement.invoices.view",
        "inventory.view",
        "sensitive.procurement_prices",
    ]
    response = owner.put(
        f"/api/workgroups/{group['id']}/access",
        json={"permission_keys": keys, "project_ids": [first], "expected_revision": 1},
    )
    assert response.status_code == 200, response.text
    assert (
        owner.post(
            "/api/accounts",
            json={
                "username": "buyer",
                "password": MEMBER_PASSWORD,
                "group_id": group["id"],
            },
        ).status_code
        == 201
    )
    return (
        harness,
        owner,
        harness.member_client(),
        (customer, supplier, first, second, contract, group["id"]),
    )


def test_project_list_and_dashboard_only_count_authorized_projects(scoped):
    _, _, member, _ = scoped
    response = member.get("/api/projects?status=all")
    assert response.status_code == 200, response.text
    assert [p["project_code"] for p in response.json()] == ["ACCESS-A"]
    dashboard = member.get("/api/dashboard")
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["summary"]["active_project_count"] == 1
    assert dashboard.json()["summary"]["contracted_amount_cents"] == 10000
    assert dashboard.json()["summary"]["received_amount_cents"] == 1000
    assert dashboard.json()["backup"] is None
    assert "ACCESS-B" not in dashboard.text


def test_company_ledger_filters_before_aggregation(scoped):
    _, _, member, (customer, supplier, *_) = scoped
    result = member.get(f"/api/companies/{supplier}/ledger")
    assert result.status_code == 200, result.text
    supplier_result = result.json()["supplier"]
    assert supplier_result["summary"]["order_count"] == 1
    assert supplier_result["summary"]["ordered_amount_cents"] == 1000
    assert supplier_result["summary"]["paid_amount_cents"] == 100
    customer_result = member.get(f"/api/companies/{customer}/ledger")
    assert (
        customer_result.json()["customer"]["summary"]["contracted_amount_cents"]
        == 10000
    )
    assert "ACCESS-B" not in customer_result.text
    assert "SECRET-CROSS-CONTRACT" not in customer_result.text


def test_partial_contract_visibility_is_allocation_summary(scoped):
    _, _, member, _ = scoped
    result = member.get("/api/projects/ACCESS-A/contracts")
    assert result.status_code == 200, result.text
    contract = result.json()["items"][0]
    assert contract["restricted"] is True
    assert contract["total_amount_cents"] is None
    assert [a["project_code"] for a in contract["allocations"]] == ["ACCESS-A"]
    assert contract["allocations"][0]["amount_cents"] == 10000
    assert "SECRET-CROSS-CONTRACT" not in result.text
    assert "ACCESS-B" not in result.text


def test_inventory_movements_page_and_shared_balance_are_scoped(scoped):
    _, _, member, _ = scoped
    result = member.get("/api/inventory/items/1/movements?page_size=1")
    assert result.status_code == 200, result.text
    assert result.json()["total"] == 1
    assert result.json()["items"][0]["project_code"] == "ACCESS-A"
    detail = member.get("/api/inventory/items/1")
    assert detail.status_code == 200, detail.text
    assert detail.json()["quantity"] is None
    assert detail.json()["movements"][0]["quantity_after"] is None
    assert "ACCESS-B" not in detail.text


def test_member_created_project_is_granted_to_current_group(scoped):
    harness, _, member, (customer, *rest) = scoped
    response = member.post(
        "/api/projects",
        json={
            "project_code": "ACCESS-NEW",
            "company_id": customer,
            "name": "新项目",
            "description": None,
        },
    )
    assert response.status_code == 201, response.text
    with harness.connection() as connection:
        assert (
            connection.execute(
                "SELECT group_id FROM workgroup_projects WHERE project_id=?",
                (response.json()["id"],),
            ).fetchone()[0]
            == rest[-1]
        )
    assert "ACCESS-NEW" in member.get("/api/projects").text


def test_dashboard_excludes_modules_without_view_permissions(scoped):
    _, owner, member, (_, _, first, _, _, group_id) = scoped
    assert (
        owner.put(
            f"/api/workgroups/{group_id}/access",
            json={
                "permission_keys": ["projects.view"],
                "project_ids": [first],
                "expected_revision": 2,
            },
        ).status_code
        == 200
    )
    result = member.get("/api/projects/ACCESS-A/dashboard")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["commercial"]["contracts"] == []
    assert body["receivables"]["received_amount_cents"] is None
    assert body["stages"] == []
    assert body["profit"]["actual_profit_cents"] is None


def test_company_edit_preserves_hidden_bank_fields_and_rejects_explicit_values(scoped):
    harness, _, member, (customer, *_) = scoped
    with harness.connection() as connection:
        connection.execute(
            "UPDATE companies SET bank_name='原开户行',bank_account='original-private-account' WHERE id=?",
            (customer,),
        )
    payload = {
        "name": "新公司名",
        "taxpayer_id": None,
        "registered_address": None,
        "registered_phone": None,
        "notes": None,
        "expected_revision": 1,
    }
    result = member.put(f"/api/companies/{customer}", json=payload)
    assert result.status_code == 200, result.text
    with harness.connection() as connection:
        row = connection.execute(
            "SELECT bank_name,bank_account FROM companies WHERE id=?", (customer,)
        ).fetchone()
        assert tuple(row) == ("原开户行", "original-private-account")
    result = member.put(
        f"/api/companies/{customer}",
        json={
            **payload,
            "expected_revision": 2,
            "bank_name": None,
            "bank_account": None,
        },
    )
    assert result.status_code == 403, result.text


def test_receipts_view_does_not_disclose_contract_module_amounts(scoped):
    _, owner, member, (_, _, first, _, _, group_id) = scoped
    assert (
        owner.put(
            f"/api/workgroups/{group_id}/access",
            json={
                "permission_keys": ["projects.view", "customer_receipts.view"],
                "project_ids": [first],
                "expected_revision": 2,
            },
        ).status_code
        == 200
    )
    response = member.get("/api/projects/ACCESS-A/payments")
    assert response.status_code == 200, response.text
    assert response.json()["received_amount_cents"] == 1000
    assert response.json()["contracted_amount_cents"] is None


def test_customer_ledger_keeps_visible_receipts_without_contract_details(scoped):
    _, owner, member, (customer, _, first, _, _, group_id) = scoped
    assert owner.put(f"/api/workgroups/{group_id}/access", json={
        "permission_keys": ["companies.view", "company_ledger.view", "customer_receipts.view"],
        "project_ids": [first], "expected_revision": 2,
    }).status_code == 200
    response = member.get(f"/api/companies/{customer}/ledger")
    assert response.status_code == 200, response.text
    customer_result = response.json()["customer"]
    assert customer_result["summary"]["allocated_received_amount_cents"] == 1000
    assert customer_result["summary"]["contracted_amount_cents"] is None
    assert customer_result["projects"][0]["contracts"] == []


def test_company_create_cannot_set_hidden_bank_values(scoped):
    _, _, member, _ = scoped
    payload = {
        "name": "普通成员新建公司", "taxpayer_id": None, "registered_address": None,
        "registered_phone": None, "bank_name": "未经授权银行", "bank_account": "123",
        "notes": None,
    }
    assert member.post("/api/companies", json=payload).status_code == 403
    response = member.post("/api/companies", json={**payload, "bank_name": None, "bank_account": None})
    assert response.status_code == 201, response.text
