"""在全新、隔离的发布验证目录中，通过运行中的 EXE 验证采购和重启持久化。"""
from __future__ import annotations

import argparse
import json
import re
import secrets
from pathlib import Path
from uuid import uuid4

import httpx

PROJECT = "/api/projects/RELEASE-SMOKE"


def post(client: httpx.Client, path: str, payload: dict, expected: int = 201):
    response = client.post(path, json=payload, headers={"Idempotency-Key": str(uuid4())})
    assert response.status_code == expected, (path, response.status_code, response.text)
    return response.json() if response.content else None


def seed(client: httpx.Client) -> dict:
    password = f"{secrets.randbelow(1000000):06d}"
    # 已设置密码的数据库会立即失败，绝不复用或清空已有业务数据。
    post(client, "/api/auth/setup", {"password": password}, 204)
    post(client, "/api/auth/login", {"password": password}, 204)
    company = post(client, "/api/companies", {
        "name": "发布验证供应商",
        **dict.fromkeys(("taxpayer_id", "registered_address", "registered_phone",
                        "bank_name", "bank_account", "notes")),
    })
    post(client, "/api/projects", {
        "project_code": "RELEASE-SMOKE", "company_id": company["id"],
        "name": "发布验证项目", "description": "仅用于成品包自检",
    })
    source = post(client, f"{PROJECT}/procurement-lists", {"name": "验证清单", "notes": None})
    line = post(client, f"{PROJECT}/procurement-lists/{source['id']}/lines", {
        "sequence_no": 1, "category": "电气", "name": "验证物料", "brand": None,
        "model": "TEST", "specification": None, "unit": "PCS", "quantity": "1.000",
        "unit_cost_cents": 10000, "quoted_unit_price_cents": 15000,
    })
    source = post(client, f"{PROJECT}/procurement-lists/{source['id']}/confirm",
                  {"expected_revision": line["list_revision"]}, 200)
    order = post(client, f"{PROJECT}/purchase-orders", {
        "order_no": "", "supplier_company_id": company["id"], "ordered_on": "2026-10-12",
        "expected_delivery_on": None, "tax_rate_bps": 1300, "notes": None,
        "document_version_ids": [], "lines": [{
            "procurement_line_id": source["lines"][0]["id"], "quantity": "1.000",
            "unit_cost_cents": 10000, "overage_reason": None,
        }],
    })
    assert re.fullmatch(r"PO_FBYZXM_20261012_FBYZGYS_001", order["order_no"]), order["order_no"]
    path = f"{PROJECT}/purchase-orders/{order['id']}"
    post(client, f"{path}/confirm", {"expected_revision": order["revision"]}, 200)
    allocation = {"purchase_order_line_id": order["lines"][0]["id"], "amount_cents": 5000}
    post(client, f"{path}/supplier-payments", {
        "paid_on": "2026-10-12", "payment_method": "银行转账", "reference_no": None,
        "notes": None, "amount_cents": 5000, "allocations": [allocation],
    })
    post(client, f"{path}/supplier-invoices", {
        "invoice_no": "SMOKE_INV_001", "invoiced_on": "2026-10-12",
        "document_version_ids": [], "amount_cents": 11300,
        "allocations": [{**allocation, "amount_cents": 11300}],
    })
    post(client, f"{path}/goods-receipts", {
        "received_on": "2026-10-12", "warehouse_name": "验证仓库", "notes": None,
        "lines": [{"purchase_order_line_id": order["lines"][0]["id"], "quantity": "1.000"}],
    })
    return {"password": password, "company_id": company["id"], "order_id": order["id"],
            "order_no": order["order_no"]}


def verify(client: httpx.Client, state: dict) -> None:
    post(client, "/api/auth/login", {"password": state["password"]}, 204)
    response = client.get(f"{PROJECT}/purchase-orders/{state['order_id']}")
    response.raise_for_status()
    order = response.json()
    expected = {"order_no": state["order_no"], "tax_rate_bps": 1300,
                "net_amount_cents": 10000, "tax_amount_cents": 1300,
                "ordered_amount_cents": 11300, "paid_amount_cents": 5000,
                "invoiced_amount_cents": 11300, "status": "received"}
    assert {key: order[key] for key in expected} == expected
    response = client.get(f"/api/companies/{state['company_id']}/ledger")
    response.raise_for_status()
    assert response.json()["supplier"]["summary"] == {
        "project_count": 1, "order_count": 1, "ordered_amount_cents": 11300,
        "paid_amount_cents": 5000, "unpaid_amount_cents": 6300,
        "invoiced_amount_cents": 11300, "uninvoiced_amount_cents": 0,
    }
    response = client.get(f"{PROJECT}/procurement-overview")
    response.raise_for_status()
    assert response.json()["procurement_received_cents"] == 11300


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("seed", "verify"))
    parser.add_argument("state", type=Path)
    args = parser.parse_args()
    with httpx.Client(base_url="http://127.0.0.1:8765", timeout=15, trust_env=False) as client:
        if args.phase == "seed":
            with args.state.open("x", encoding="utf-8") as output:
                args.state.chmod(0o600)
                state = seed(client)
                json.dump(state, output)
        else:
            state = json.loads(args.state.read_text(encoding="utf-8"))
        verify(client, state)
    print(f"Packaged business smoke {args.phase}: PASS (number, tax, payment, invoice, receipt, ledger)")


if __name__ == "__main__":
    main()
