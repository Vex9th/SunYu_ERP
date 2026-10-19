from __future__ import annotations

import sqlite3
from collections import defaultdict
from typing import Any

from backend.app.features.purchase_order_tax import gross_line_value

_SUPPLIER_AMOUNTS = (
    "ordered_amount_cents",
    "paid_amount_cents",
    "unpaid_amount_cents",
    "invoiced_amount_cents",
    "uninvoiced_amount_cents",
)
_CUSTOMER_AMOUNTS = (
    "contracted_amount_cents",
    "allocated_received_amount_cents",
    "unreceived_amount_cents",
    "unallocated_received_amount_cents",
    "invoiced_amount_cents",
)


def company_ledger(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object]:
    """在调用方的只读事务中汇总公司往来，不修改任何业务记录。"""
    return {
        "company_id": company_id,
        "supplier": _supplier_ledger(connection, company_id),
        "customer": _customer_ledger(connection, company_id),
    }


def _supplier_ledger(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object]:
    rows = connection.execute(
        """
        SELECT orders.id AS order_id, orders.order_no, orders.project_id,
               projects.project_code, projects.name AS project_name,
               orders.ordered_on, orders.status
        FROM purchase_orders AS orders
        JOIN projects ON projects.id = orders.project_id
        WHERE orders.supplier_company_id = ?
          AND orders.status IN ('confirmed', 'partially_received', 'received')
        ORDER BY orders.ordered_on DESC, orders.id DESC
        """,
        (company_id,),
    ).fetchall()
    orders = {
        int(row["order_id"]): {
            **dict(row),
            **dict.fromkeys(_SUPPLIER_AMOUNTS, 0),
        }
        for row in rows
    }
    lines = connection.execute(
        """
        SELECT lines.purchase_order_id, lines.unit_cost_cents, lines.quantity_milli,
               lines.tax_amount_cents, lines.gross_unit_cost_cents
        FROM purchase_order_lines AS lines
        JOIN purchase_orders AS orders ON orders.id = lines.purchase_order_id
        WHERE orders.supplier_company_id = ?
          AND orders.status IN ('confirmed', 'partially_received', 'received')
        """,
        (company_id,),
    ).fetchall()
    for line in lines:
        orders[int(line["purchase_order_id"])]["ordered_amount_cents"] += gross_line_value(
            int(line["unit_cost_cents"]),
            int(line["quantity_milli"]),
            int(line["tax_amount_cents"]), line["gross_unit_cost_cents"],
        )

    # 金额事实独立读取，避免订单行、付款和发票互相联表放大。
    for table, amount_key in (
        ("supplier_payments", "paid_amount_cents"),
        ("supplier_invoices", "invoiced_amount_cents"),
    ):
        facts = connection.execute(
            f"""
            SELECT facts.purchase_order_id, facts.amount_cents
            FROM {table} AS facts
            JOIN purchase_orders AS orders ON orders.id = facts.purchase_order_id
            WHERE orders.supplier_company_id = ?
              AND orders.status IN ('confirmed', 'partially_received', 'received')
              AND facts.status = 'active'
            """,
            (company_id,),
        ).fetchall()
        for fact in facts:
            orders[int(fact["purchase_order_id"])][amount_key] += int(
                fact["amount_cents"]
            )

    for order in orders.values():
        order["unpaid_amount_cents"] = max(
            order["ordered_amount_cents"] - order["paid_amount_cents"],
            0,
        )
        order["uninvoiced_amount_cents"] = max(
            order["ordered_amount_cents"] - order["invoiced_amount_cents"],
            0,
        )
    order_list = list(orders.values())
    return {
        "summary": {
            "project_count": len({order["project_id"] for order in order_list}),
            "order_count": len(order_list),
            **_sum_amounts(order_list, _SUPPLIER_AMOUNTS),
        },
        "orders": order_list,
    }


def _customer_ledger(
    connection: sqlite3.Connection,
    company_id: int,
) -> dict[str, object]:
    project_rows = connection.execute(
        """
        SELECT projects.id AS project_id, projects.project_code,
               projects.name AS project_name
        FROM projects
        WHERE projects.company_id = ? OR EXISTS (
            SELECT 1 FROM contract_project_allocations AS allocations
            JOIN contracts ON contracts.id = allocations.contract_id
            WHERE allocations.project_id = projects.id
              AND contracts.customer_company_id = ?
              AND (
                  contracts.status IN ('signed', 'completed')
                  OR (
                      contracts.status = 'terminated' AND EXISTS (
                          SELECT 1 FROM receipts
                          WHERE receipts.contract_allocation_id = allocations.id
                            AND receipts.project_id = allocations.project_id
                            AND receipts.status = 'active'
                      )
                  )
              )
        )
        ORDER BY projects.project_code COLLATE NOCASE, projects.id
        """,
        (company_id, company_id),
    ).fetchall()
    projects: dict[int, dict[str, Any]] = {
        int(row["project_id"]): {
            **dict(row),
            **dict.fromkeys(_CUSTOMER_AMOUNTS, 0),
            "contracts": [],
        }
        for row in project_rows
    }
    allocation_rows = connection.execute(
        """
        SELECT allocations.id AS allocation_id, allocations.project_id,
               allocations.amount_cents AS allocated_amount_cents,
               contracts.id AS contract_id, contracts.contract_no,
               contracts.title, contracts.status, contracts.signed_on
        FROM contract_project_allocations AS allocations
        JOIN contracts ON contracts.id = allocations.contract_id
        WHERE contracts.customer_company_id = ?
          AND contracts.status IN ('signed', 'completed', 'terminated')
        ORDER BY contracts.signed_on DESC, contracts.id DESC, allocations.id
        """,
        (company_id,),
    ).fetchall()
    receipt_rows = connection.execute(
        """
        SELECT receipts.contract_allocation_id, receipts.amount_cents
        FROM receipts
        JOIN contract_project_allocations AS allocations
            ON allocations.id = receipts.contract_allocation_id
           AND allocations.project_id = receipts.project_id
        JOIN contracts ON contracts.id = allocations.contract_id
        WHERE contracts.customer_company_id = ?
          AND contracts.status IN ('signed', 'completed', 'terminated')
          AND receipts.status = 'active'
        """,
        (company_id,),
    ).fetchall()
    received_by_allocation: dict[int, int] = defaultdict(int)
    for receipt in receipt_rows:
        received_by_allocation[int(receipt["contract_allocation_id"])] += int(
            receipt["amount_cents"]
        )
    for row in allocation_rows:
        received = received_by_allocation[int(row["allocation_id"])]
        terminated = row["status"] == "terminated"
        if terminated and received == 0:
            continue
        project = projects[int(row["project_id"])]
        # 终止合同保留已发生的到账和原分摊，未履行部分不再形成应收。
        unreceived = (
            0 if terminated else max(int(row["allocated_amount_cents"]) - received, 0)
        )
        contract = {
            key: row[key]
            for key in (
                "allocation_id",
                "contract_id",
                "contract_no",
                "title",
                "status",
                "signed_on",
                "allocated_amount_cents",
            )
        }
        contract.update(
            received_amount_cents=received,
            unreceived_amount_cents=unreceived,
        )
        project["contracts"].append(contract)
        if not terminated:
            project["contracted_amount_cents"] += int(row["allocated_amount_cents"])
        project["allocated_received_amount_cents"] += received
        project["unreceived_amount_cents"] += unreceived

    # 未关联合同的到账和销项发票只能按项目甲方归集。
    unallocated_rows = connection.execute(
        """
        SELECT receipts.project_id, receipts.amount_cents
        FROM receipts
        JOIN projects ON projects.id = receipts.project_id
        WHERE projects.company_id = ? AND receipts.status = 'active'
          AND receipts.contract_allocation_id IS NULL
        """,
        (company_id,),
    ).fetchall()
    for receipt in unallocated_rows:
        projects[int(receipt["project_id"])]["unallocated_received_amount_cents"] += (
            int(receipt["amount_cents"])
        )
    invoice_rows = connection.execute(
        """
        SELECT invoices.project_id, invoices.amount_cents
        FROM project_invoices AS invoices
        JOIN projects ON projects.id = invoices.project_id
        WHERE projects.company_id = ? AND invoices.status = 'recorded'
        """,
        (company_id,),
    ).fetchall()
    for invoice in invoice_rows:
        projects[int(invoice["project_id"])]["invoiced_amount_cents"] += int(
            invoice["amount_cents"] or 0
        )
    project_list = list(projects.values())
    return {
        "summary": {
            "project_count": len(project_list),
            "contract_count": len(
                {
                    contract["contract_id"]
                    for project in project_list
                    for contract in project["contracts"]
                }
            ),
            **_sum_amounts(project_list, _CUSTOMER_AMOUNTS),
        },
        "projects": project_list,
    }


def _sum_amounts(
    rows: list[dict[str, Any]],
    fields: tuple[str, ...],
) -> dict[str, int]:
    return {field: sum(int(row[field]) for row in rows) for field in fields}
