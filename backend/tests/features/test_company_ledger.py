from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI

from backend.app.core.database import connect_database
from backend.app.features.commercial import create_commercial_router
from backend.app.features.companies import create_companies_router
from backend.tests.features.test_companies import CompaniesHarness, _build_harness

NOW = "2026-10-11T09:00:00+00:00"


@pytest.fixture
def harness(tmp_path: Path) -> CompaniesHarness:
    return _build_harness(tmp_path)


def _insert(connection: sqlite3.Connection, table: str, **values: Any) -> int:
    cursor = connection.execute(
        f"INSERT INTO {table} ({', '.join(values)}) "
        f"VALUES ({', '.join('?' for _ in values)})",
        tuple(values.values()),
    )
    assert cursor.lastrowid is not None
    return int(cursor.lastrowid)


def _company(connection: sqlite3.Connection, name: str) -> int:
    return _insert(connection, "companies", name=name, created_at=NOW, updated_at=NOW)


def _project(connection: sqlite3.Connection, customer: int, code: str) -> int:
    return _insert(
        connection,
        "projects",
        company_id=customer,
        project_code=code,
        project_code_key=code.casefold(),
        name="同名项目",
        created_at=NOW,
        updated_at=NOW,
    )


def _order(
    connection: sqlite3.Connection,
    project: int,
    supplier: int,
    number: str,
    status: str,
    lines: list[tuple[int, int]],
) -> int:
    order = _insert(
        connection,
        "purchase_orders",
        project_id=project,
        supplier_company_id=supplier,
        order_no=number,
        ordered_on="2026-10-10",
        status=status,
        create_idempotency_key=str(uuid4()),
        create_request_hash="hash",
        created_at=NOW,
        updated_at=NOW,
    )
    procurement_list = _insert(
        connection,
        "procurement_lists",
        project_id=project,
        name=number,
        create_idempotency_key=str(uuid4()),
        create_request_hash="hash",
        created_at=NOW,
        updated_at=NOW,
    )
    for index, (unit_cost, quantity) in enumerate(lines, start=1):
        line = _insert(
            connection,
            "procurement_lines",
            procurement_list_id=procurement_list,
            sequence_no=index,
            category="设备",
            name=f"设备 {index}",
            quantity_milli=quantity,
            unit="台",
            unit_cost_cents=unit_cost,
            quoted_unit_price_cents=unit_cost,
            create_idempotency_key=str(uuid4()),
            create_request_hash="hash",
            created_at=NOW,
            updated_at=NOW,
        )
        _insert(
            connection,
            "purchase_order_lines",
            purchase_order_id=order,
            procurement_line_id=line,
            unit_cost_cents=unit_cost,
            quantity_milli=quantity,
            created_at=NOW,
        )
    return order


def _supplier_fact(
    connection: sqlite3.Connection,
    table: str,
    order: int,
    amount: int,
    status: str = "active",
) -> None:
    fields = (
        {"paid_on": "2026-10-10", "payment_method": "bank_transfer"}
        if table == "supplier_payments"
        else {"invoiced_on": "2026-10-10", "invoice_no": str(uuid4())}
    )
    _insert(
        connection,
        table,
        purchase_order_id=order,
        amount_cents=amount,
        status=status,
        idempotency_key=str(uuid4()),
        request_hash="hash",
        created_at=NOW,
        updated_at=NOW,
        **fields,
    )


def _contract(
    connection: sqlite3.Connection,
    customer: int,
    number: str,
    allocations: list[tuple[int, int]],
    status: str = "signed",
) -> tuple[int, list[int]]:
    contract = _insert(
        connection,
        "contracts",
        customer_company_id=customer,
        contract_no=number,
        title=f"{number} 合同",
        status=status,
        signed_on="2026-10-01",
        final_delivery_on="2026-12-31",
        total_amount_cents=sum(amount for _, amount in allocations),
        created_at=NOW,
        updated_at=NOW,
    )
    return contract, [
        _insert(
            connection,
            "contract_project_allocations",
            contract_id=contract,
            project_id=project,
            amount_cents=amount,
        )
        for project, amount in allocations
    ]


def _receipt(
    connection: sqlite3.Connection,
    project: int,
    allocation: int | None,
    amount: int,
    status: str = "active",
) -> None:
    _insert(
        connection,
        "receipts",
        project_id=project,
        contract_allocation_id=allocation,
        milestone="advance",
        received_on="2026-10-10",
        amount_cents=amount,
        payment_method="bank_transfer",
        status=status,
        voided_on="2026-10-11" if status == "voided" else None,
        void_reason="录入错误" if status == "voided" else None,
        created_at=NOW,
        updated_at=NOW,
    )


def _invoice(
    connection: sqlite3.Connection,
    project: int,
    amount: int,
    status: str = "recorded",
) -> None:
    _insert(
        connection,
        "project_invoices",
        project_id=project,
        invoice_type="contract_payment",
        status=status,
        amount_cents=amount,
        counterparty_name="仅用于展示，不用于公司归属",
        invoice_number=str(uuid4()),
        requested_on="2026-10-09",
        recorded_on="2026-10-10",
        created_at=NOW,
        updated_at=NOW,
    )


def _ledger(harness: CompaniesHarness, company: int) -> dict[str, Any]:
    with harness.client() as client:
        response = client.get(f"/api/companies/{company}/ledger")
    assert response.status_code == 200, response.text
    return response.json()


def test_supplier_totals_are_per_order_without_fact_join_multiplication(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        supplier = _company(connection, "供货公司")
        other = _company(connection, "其他公司")
        first_project = _project(connection, other, "P-A")
        second_project = _project(connection, other, "P-B")
        first = _order(
            connection,
            first_project,
            supplier,
            "PO-A",
            "confirmed",
            [(101, 500), (99, 1500)],
        )
        second = _order(
            connection,
            second_project,
            supplier,
            "PO-B",
            "partially_received",
            [(1000, 1000)],
        )
        third = _order(
            connection, second_project, supplier, "PO-C", "received", [(500, 1000)]
        )
        for amount in (20, 30):
            _supplier_fact(connection, "supplier_payments", first, amount)
        _supplier_fact(connection, "supplier_payments", first, 99, "reversed")
        for amount in (40, 60):
            _supplier_fact(connection, "supplier_invoices", first, amount)
        _supplier_fact(connection, "supplier_invoices", first, 88, "reversed")
        _supplier_fact(connection, "supplier_payments", second, 1000)
        _supplier_fact(connection, "supplier_invoices", second, 1000)
        _supplier_fact(connection, "supplier_payments", third, 100)
        _supplier_fact(connection, "supplier_invoices", third, 200)
        for state in ("draft", "cancelled"):
            ignored = _order(
                connection,
                first_project,
                supplier,
                f"PO-{state}",
                state,
                [(8000, 1000)],
            )
            _supplier_fact(connection, "supplier_payments", ignored, 900)
            _supplier_fact(connection, "supplier_invoices", ignored, 800)
        _order(
            connection, first_project, other, "PO-OTHER", "confirmed", [(9999, 1000)]
        )

    supplier_ledger = _ledger(harness, supplier)["supplier"]
    assert supplier_ledger["summary"] == {
        "project_count": 2,
        "order_count": 3,
        "ordered_amount_cents": 1700,
        "paid_amount_cents": 1150,
        "unpaid_amount_cents": 550,
        "invoiced_amount_cents": 1300,
        "uninvoiced_amount_cents": 400,
    }
    orders = {order["order_id"]: order for order in supplier_ledger["orders"]}
    assert set(orders) == {first, second, third}
    assert orders[first] == {
        "order_id": first,
        "order_no": "PO-A",
        "project_id": first_project,
        "project_code": "P-A",
        "project_name": "同名项目",
        "ordered_on": "2026-10-10",
        "status": "confirmed",
        "ordered_amount_cents": 200,
        "paid_amount_cents": 50,
        "unpaid_amount_cents": 150,
        "invoiced_amount_cents": 100,
        "uninvoiced_amount_cents": 100,
    }


def test_customer_uses_contract_customer_and_keeps_unallocated_receipts_separate(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        customer = _company(connection, "兼有供货角色")
        other = _company(connection, "另一甲方")
        first = _project(connection, customer, "C-A")
        second = _project(connection, other, "C-B")
        empty = _project(connection, customer, "C-EMPTY")
        contract, allocations = _contract(
            connection, customer, "CT-A", [(first, 10000), (second, 20000)]
        )
        completed, completed_allocations = _contract(
            connection, customer, "CT-B", [(first, 5000)], "completed"
        )
        _, foreign_allocations = _contract(
            connection, other, "CT-OTHER", [(first, 90000)]
        )
        _receipt(connection, first, allocations[0], 1000)
        _receipt(connection, first, allocations[0], 2000)
        _receipt(connection, first, allocations[0], 4000, "voided")
        _receipt(connection, second, allocations[1], 5000)
        _receipt(connection, first, completed_allocations[0], 1000)
        _receipt(connection, first, foreign_allocations[0], 7000)
        _receipt(connection, first, None, 600)
        _receipt(connection, first, None, 900, "voided")
        _receipt(connection, second, None, 800)
        for state in ("draft", "terminated"):
            _, ignored = _contract(
                connection, customer, f"CT-{state}", [(first, 50000)], state
            )
            _receipt(
                connection,
                first,
                ignored[0],
                100,
                "voided" if state == "terminated" else "active",
            )
        _invoice(connection, first, 40000)
        _invoice(connection, first, 700)
        for state in ("planned", "requested", "void"):
            _invoice(connection, first, 90000, state)
        _invoice(connection, second, 9999)
        _order(connection, second, customer, "MIXED-PO", "confirmed", [(4321, 1000)])

    ledger = _ledger(harness, customer)
    assert ledger["company_id"] == customer
    assert ledger["supplier"]["summary"]["ordered_amount_cents"] == 4321
    assert ledger["customer"]["summary"] == {
        "project_count": 3,
        "contract_count": 2,
        "contracted_amount_cents": 35000,
        "allocated_received_amount_cents": 9000,
        "unreceived_amount_cents": 26000,
        "unallocated_received_amount_cents": 600,
        "invoiced_amount_cents": 40700,
    }
    projects = {
        project["project_id"]: project for project in ledger["customer"]["projects"]
    }
    assert projects[first] == {
        "project_id": first,
        "project_code": "C-A",
        "project_name": "同名项目",
        "contracted_amount_cents": 15000,
        "allocated_received_amount_cents": 4000,
        "unreceived_amount_cents": 11000,
        "unallocated_received_amount_cents": 600,
        "invoiced_amount_cents": 40700,
        "contracts": [
            {
                "allocation_id": completed_allocations[0],
                "contract_id": completed,
                "contract_no": "CT-B",
                "title": "CT-B 合同",
                "status": "completed",
                "signed_on": "2026-10-01",
                "allocated_amount_cents": 5000,
                "received_amount_cents": 1000,
                "unreceived_amount_cents": 4000,
            },
            {
                "allocation_id": allocations[0],
                "contract_id": contract,
                "contract_no": "CT-A",
                "title": "CT-A 合同",
                "status": "signed",
                "signed_on": "2026-10-01",
                "allocated_amount_cents": 10000,
                "received_amount_cents": 3000,
                "unreceived_amount_cents": 7000,
            },
        ],
    }
    assert projects[second]["contracted_amount_cents"] == 20000
    assert projects[second]["allocated_received_amount_cents"] == 5000
    assert projects[second]["unallocated_received_amount_cents"] == 0
    assert projects[second]["invoiced_amount_cents"] == 0
    assert projects[empty]["contracts"] == []
    assert projects[empty]["contracted_amount_cents"] == 0


def test_terminating_paid_contract_keeps_historical_receipts_without_receivables(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        customer = _company(connection, "历史收款客户")
        other = _company(connection, "项目甲方")
        paid_project = _project(connection, other, "HISTORY-PAID")
        history_only_project = _project(connection, other, "HISTORY-ONLY")
        voided_project = _project(connection, other, "HISTORY-VOIDED")
        unpaid_project = _project(connection, other, "HISTORY-UNPAID")
        contract, allocations = _contract(
            connection,
            customer,
            "CT-HISTORY",
            [
                (paid_project, 10000),
                (voided_project, 20000),
                (unpaid_project, 30000),
                (history_only_project, 40000),
            ],
        )
        _receipt(connection, paid_project, allocations[0], 3000)
        _receipt(connection, paid_project, allocations[0], 1000, "voided")
        _receipt(connection, voided_project, allocations[1], 500, "voided")
        _receipt(connection, history_only_project, allocations[3], 6000)
        current, current_allocations = _contract(
            connection,
            customer,
            "CT-CURRENT",
            [(paid_project, 5000)],
        )
        _receipt(connection, paid_project, current_allocations[0], 500)

    def get_connection() -> Iterator[sqlite3.Connection]:
        with closing(connect_database(harness.database_path)) as connection:
            yield connection

    harness.app.include_router(
        create_commercial_router(get_connection, lambda: harness.settings)
    )
    before = _ledger(harness, customer)["customer"]["summary"]
    assert before["contracted_amount_cents"] == 105000
    assert before["allocated_received_amount_cents"] == 9500
    assert before["unreceived_amount_cents"] == 95500
    with harness.client() as client:
        response = client.post(
            f"/api/projects/HISTORY-PAID/contracts/{contract}/transition",
            json={
                "to_status": "terminated",
                "occurred_at": "2026-10-11T09:00:00+08:00",
                "reason": "客户终止",
                "expected_revision": 1,
            },
        )
    assert response.status_code == 200, response.text
    ledger = _ledger(harness, customer)["customer"]
    assert ledger["summary"] == {
        "project_count": 2,
        "contract_count": 2,
        "contracted_amount_cents": 5000,
        "allocated_received_amount_cents": 9500,
        "unreceived_amount_cents": 4500,
        "unallocated_received_amount_cents": 0,
        "invoiced_amount_cents": 0,
    }
    projects = {row["project_id"]: row for row in ledger["projects"]}
    assert set(projects) == {paid_project, history_only_project}
    assert projects[history_only_project]["contracted_amount_cents"] == 0
    assert projects[history_only_project]["allocated_received_amount_cents"] == 6000
    assert projects[history_only_project]["unreceived_amount_cents"] == 0
    project = projects[paid_project]
    assert project["contracted_amount_cents"] == 5000
    assert project["allocated_received_amount_cents"] == 3500
    assert project["unreceived_amount_cents"] == 4500
    contracts = {row["contract_id"]: row for row in project["contracts"]}
    assert contracts[contract] == {
        "allocation_id": allocations[0],
        "contract_id": contract,
        "contract_no": "CT-HISTORY",
        "title": "CT-HISTORY 合同",
        "status": "terminated",
        "signed_on": "2026-10-01",
        "allocated_amount_cents": 10000,
        "received_amount_cents": 3000,
        "unreceived_amount_cents": 0,
    }
    assert contracts[current]["unreceived_amount_cents"] == 4500


def test_company_rename_and_reused_name_never_move_ledger_between_ids(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        original = _company(connection, "历史名称")
        customer = _company(connection, "甲方")
        project = _project(connection, customer, "NAME-ID")
        _order(connection, project, original, "OLD", "confirmed", [(100, 1000)])
        connection.execute(
            "UPDATE companies SET name = '新名称' WHERE id = ?", (original,)
        )
        replacement = _company(connection, "历史名称")
        _order(connection, project, replacement, "NEW", "confirmed", [(999, 1000)])
    assert (
        _ledger(harness, original)["supplier"]["summary"]["ordered_amount_cents"] == 100
    )
    assert (
        _ledger(harness, replacement)["supplier"]["summary"]["ordered_amount_cents"]
        == 999
    )


def test_empty_company_returns_zero_summaries(harness: CompaniesHarness) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        company = _company(connection, "空往来公司")
    ledger = _ledger(harness, company)
    assert ledger["supplier"]["orders"] == []
    assert ledger["customer"]["projects"] == []
    assert ledger["supplier"]["summary"] == {
        "project_count": 0,
        "order_count": 0,
        "ordered_amount_cents": 0,
        "paid_amount_cents": 0,
        "unpaid_amount_cents": 0,
        "invoiced_amount_cents": 0,
        "uninvoiced_amount_cents": 0,
    }
    assert ledger["customer"]["summary"] == {
        "project_count": 0,
        "contract_count": 0,
        "contracted_amount_cents": 0,
        "allocated_received_amount_cents": 0,
        "unreceived_amount_cents": 0,
        "unallocated_received_amount_cents": 0,
        "invoiced_amount_cents": 0,
    }


@pytest.mark.parametrize("company_id", ["0", "-1", "abc", str(2**63)])
def test_ledger_reuses_company_identifier_validation(
    harness: CompaniesHarness,
    company_id: str,
) -> None:
    with harness.client() as client:
        assert client.get(f"/api/companies/{company_id}/ledger").status_code == 422


def test_ledger_requires_login_and_unknown_company_is_404(
    harness: CompaniesHarness,
) -> None:
    with harness.client(authenticated=False) as client:
        assert client.get("/api/companies/999999/ledger").status_code == 401
    with harness.client() as client:
        response = client.get("/api/companies/999999/ledger")
    assert response.status_code == 404
    assert response.json()["detail"] == "Company not found"


def test_ledger_is_read_only_and_query_count_does_not_grow_per_order(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        company = _company(connection, "只读校验")
        project = _project(connection, company, "READ-ONLY")
        for index in range(25):
            order = _order(
                connection, project, company, f"PO-{index}", "confirmed", [(100, 1000)]
            )
            _supplier_fact(connection, "supplier_payments", order, 10)
        before = "\n".join(connection.iterdump())

    statements: list[str] = []

    def read_only_connection() -> Iterator[sqlite3.Connection]:
        connection = connect_database(harness.database_path)
        connection.execute("PRAGMA query_only=ON")
        connection.set_trace_callback(statements.append)
        try:
            yield connection
        finally:
            connection.close()

    app = FastAPI()
    app.include_router(
        create_companies_router(read_only_connection, lambda: harness.settings)
    )
    harness.app = app
    ledger = _ledger(harness, company)
    assert ledger["supplier"]["summary"]["order_count"] == 25
    assert ledger["supplier"]["summary"]["paid_amount_cents"] == 250
    assert (
        len([sql for sql in statements if sql.lstrip().upper().startswith("SELECT")])
        <= 10
    )
    assert any(sql.strip().upper() == "BEGIN" for sql in statements)
    with closing(connect_database(harness.database_path)) as connection:
        assert "\n".join(connection.iterdump()) == before


def test_ledger_keeps_one_snapshot_when_payment_arrives_during_read(
    harness: CompaniesHarness,
) -> None:
    with closing(connect_database(harness.database_path)) as connection:
        company = _company(connection, "并发付款校验")
        project = _project(connection, company, "SNAPSHOT")
        order = _order(
            connection, project, company, "PO-SNAPSHOT", "confirmed", [(100, 1000)]
        )

    writes: list[int] = []

    def snapshot_connection() -> Iterator[sqlite3.Connection]:
        with (
            closing(connect_database(harness.database_path)) as reader,
            closing(connect_database(harness.database_path)) as writer,
        ):

            def write_during_read(sql: str) -> None:
                if "FROM purchase_orders AS orders" in sql and not writes:
                    _supplier_fact(writer, "supplier_payments", order, 77)
                    writes.append(77)

            reader.set_trace_callback(write_during_read)
            yield reader

    app = FastAPI()
    app.include_router(
        create_companies_router(snapshot_connection, lambda: harness.settings)
    )
    harness.app = app
    first = _ledger(harness, company)
    assert writes == [77]
    assert first["supplier"]["summary"]["paid_amount_cents"] == 0
    assert first["supplier"]["summary"]["unpaid_amount_cents"] == 100
    second = _ledger(harness, company)
    assert second["supplier"]["summary"]["paid_amount_cents"] == 77
    assert second["supplier"]["summary"]["unpaid_amount_cents"] == 23
