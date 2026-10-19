from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import pytest

from backend.app.core.database import connect_database
from backend.app.features.companies import create_companies_router
from backend.tests.features.test_company_ledger import (
    _company,
    _order,
    _project,
    _supplier_fact,
)
from backend.tests.features.test_dashboards import DashboardHarness, _build_harness


@pytest.fixture
def harness(tmp_path: Path) -> DashboardHarness:
    result = _build_harness(tmp_path)

    def get_connection() -> Iterator[sqlite3.Connection]:
        with closing(connect_database(result.database_path)) as connection:
            yield connection

    result.app.include_router(
        create_companies_router(get_connection, lambda: result.settings)
    )
    return result


def _set_order_tax(
    connection: sqlite3.Connection,
    order: int,
    rate: int,
    tax_per_line: int,
) -> None:
    connection.execute(
        "UPDATE purchase_orders SET tax_rate_bps = ? WHERE id = ?", (rate, order)
    )
    connection.execute(
        "UPDATE purchase_order_lines SET tax_amount_cents = ? "
        "WHERE purchase_order_id = ?",
        (tax_per_line, order),
    )


def test_company_ledger_uses_gross_purchase_value_and_active_payment_invoice_facts(
    harness: DashboardHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        supplier = _company(connection, "含税往来供应商")
        customer = _company(connection, "项目甲方")
        project = _project(connection, customer, "TAX-LEDGER")
        order = _order(
            connection, project, supplier, "TAX-13", "confirmed", [(10000, 1000)]
        )
        _set_order_tax(connection, order, 1300, 1300)
        _supplier_fact(connection, "supplier_payments", order, 6000)
        _supplier_fact(connection, "supplier_payments", order, 700, "reversed")
        _supplier_fact(connection, "supplier_invoices", order, 5000)
        _supplier_fact(connection, "supplier_invoices", order, 800, "reversed")
        for ignored_status in ("draft", "cancelled"):
            ignored = _order(
                connection, project, supplier, ignored_status, ignored_status,
                [(20000, 1000)],
            )
            _set_order_tax(connection, ignored, 1300, 2600)

    with harness.client() as client:
        response = client.get(f"/api/companies/{supplier}/ledger")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["supplier"]["summary"] == {
        "project_count": 1,
        "order_count": 1,
        "ordered_amount_cents": 11300,
        "paid_amount_cents": 6000,
        "unpaid_amount_cents": 5300,
        "invoiced_amount_cents": 5000,
        "uninvoiced_amount_cents": 6300,
    }
    assert body["supplier"]["orders"][0]["order_id"] == order
    assert body["supplier"]["orders"][0]["ordered_amount_cents"] == 11300
    assert body["customer"]["projects"] == []


def test_project_dashboard_commits_gross_value_and_keeps_legacy_orders_unchanged(
    harness: DashboardHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        supplier = _company(connection, "采购成本供应商")
        project = _project(connection, supplier, "TAX-COST")
        order = _order(
            connection, project, supplier, "TAX-13", "confirmed", [(10000, 1000)]
        )
        _set_order_tax(connection, order, 1300, 1300)
        legacy = _order(
            connection, project, supplier, "LEGACY", "received", [(7000, 1000)]
        )
        _supplier_fact(connection, "supplier_payments", order, 6000)
        _supplier_fact(connection, "supplier_payments", order, 700, "reversed")
        cancelled = _order(
            connection, project, supplier, "CANCELLED", "cancelled", [(20000, 1000)]
        )
        _set_order_tax(connection, cancelled, 1300, 2600)
        assert connection.execute(
            "SELECT tax_rate_bps FROM purchase_orders WHERE id = ?", (legacy,)
        ).fetchone()[0] is None

    with harness.client() as client:
        response = client.get("/api/projects/TAX-COST/dashboard")
        ledger_response = client.get(f"/api/companies/{supplier}/ledger")
    assert response.status_code == 200, response.text
    assert response.json()["costs"] == {
        "material_consumed_cents": 0,
        "labor_cents": 0,
        "field_material_cents": 0,
        "total_cents": 0,
        "procurement_committed_cents": 18300,
        "procurement_received_cents": 0,
        "procurement_paid_cents": 6000,
        "completeness": "complete",
    }
    assert ledger_response.status_code == 200, ledger_response.text
    orders = {
        row["order_id"]: row for row in ledger_response.json()["supplier"]["orders"]
    }
    assert orders[legacy]["ordered_amount_cents"] == 7000
    assert orders[legacy]["unpaid_amount_cents"] == 7000
    assert orders[order]["ordered_amount_cents"] == 11300


def test_summaries_add_each_rounded_line_tax_without_retaxing_order_total(
    harness: DashboardHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        supplier = _company(connection, "分币税额供应商")
        project = _project(connection, supplier, "TAX-ROUND")
        order = _order(
            connection, project, supplier, "ROUND", "partially_received",
            [(1, 500), (1, 500)],
        )
        # 每行未税 0.5 分先舍入为 1 分，再加 50% 税额舍入为 1 分。
        _set_order_tax(connection, order, 5000, 1)

    with harness.client() as client:
        ledger_response = client.get(f"/api/companies/{supplier}/ledger")
        dashboard_response = client.get("/api/projects/TAX-ROUND/dashboard")
    assert ledger_response.status_code == 200, ledger_response.text
    assert dashboard_response.status_code == 200, dashboard_response.text
    assert ledger_response.json()["supplier"]["summary"]["ordered_amount_cents"] == 4
    assert dashboard_response.json()["costs"]["procurement_committed_cents"] == 4


def test_gross_quote_drives_ledger_and_dashboard_without_unit_round_trip(harness):
    with closing(connect_database(harness.database_path)) as connection:
        supplier = _company(connection, "原含税报价供应商")
        project = _project(connection, supplier, "GROSS-COST")
        order = _order(connection, project, supplier, "GROSS-39", "confirmed", [(66372, 39000)])
        _set_order_tax(connection, order, 1300, 336504)
        connection.execute("UPDATE purchase_order_lines SET gross_unit_cost_cents = 75000 WHERE purchase_order_id = ?", (order,))
        _supplier_fact(connection, "supplier_payments", order, 2925000)
        _supplier_fact(connection, "supplier_invoices", order, 2925000)
    with harness.client() as client:
        ledger = client.get(f"/api/companies/{supplier}/ledger")
        dashboard = client.get("/api/projects/GROSS-COST/dashboard")
    assert ledger.status_code == dashboard.status_code == 200
    summary = ledger.json()["supplier"]["summary"]
    assert summary["ordered_amount_cents"] == 2925000
    assert summary["unpaid_amount_cents"] == summary["uninvoiced_amount_cents"] == 0
    assert dashboard.json()["costs"]["procurement_committed_cents"] == 2925000
