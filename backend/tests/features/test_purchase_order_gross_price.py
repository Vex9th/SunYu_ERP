from pathlib import Path

import pytest

from backend.tests.features.test_procurement_extensions import (
    _build_harness,
    _create_confirmed_list,
)
from backend.tests.features.test_purchase_order_tax import _headers, _payload, _receive


@pytest.mark.parametrize(
    "quantity,gross_unit,net_unit,rate,net,tax,gross",
    [
        ("39.000", 75000, 66372, 1300, 2588496, 336504, 2925000),
        ("3.000", 5, 4, 1300, 13, 2, 15),
        ("0.500", 1, 1, 1300, 1, 0, 1),
        ("2.000", 100, 100, 0, 200, 0, 200),
        ("2.000", 100, 100, None, 200, 0, 200),
    ],
)
def test_gross_quote_is_authoritative_on_create_reload_and_edit(
    tmp_path: Path, quantity, gross_unit, net_unit, rate, net, tax, gross
):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        payload = _payload(
            harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=rate
        )
        payload["lines"][0].update(
            quantity=quantity,
            unit_cost_cents=net_unit,
            gross_unit_cost_cents=gross_unit,
            overage_reason="整批采购",
        )
        path = f"/api/projects/{harness.project_code}/purchase-orders"
        response = client.post(path, headers=_headers(), json=payload)
        assert response.status_code == 201, response.text
        order = response.json()
        for result in (order, client.get(f"{path}/{order['id']}").json()):
            assert (
                result["net_amount_cents"],
                result["tax_amount_cents"],
                result["ordered_amount_cents"],
            ) == (net, tax, gross)
            assert result["lines"][0]["gross_unit_cost_cents"] == gross_unit
            assert result["lines"][0]["net_amount_cents"] == net
        edited = client.put(
            f"{path}/{order['id']}",
            json={**payload, "expected_revision": order["revision"]},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["ordered_amount_cents"] == gross
        assert edited.json()["lines"][0]["gross_unit_cost_cents"] == gross_unit
        confirmed = client.post(
            f"{path}/{order['id']}/confirm",
            headers=_headers(),
            json={"expected_revision": edited.json()["revision"]},
        )
        assert confirmed.status_code == 200, confirmed.text
        overview = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        ).json()
        assert overview["procurement_committed_cents"] == gross
        detail = client.get(
            f"/api/projects/{harness.project_code}/procurement-lists/{source['id']}"
        ).json()
        assert detail["lines"][0]["ordered_amount_cents"] == gross
        receipt = _receive(client, harness, confirmed.json(), quantity)
        assert receipt["lines"][0]["value_cents"] == gross
        facts = {
            "paid_on": "2026-08-31",
            "payment_method": "银行转账",
            "reference_no": None,
            "notes": None,
            "amount_cents": gross,
            "allocations": [
                {
                    "purchase_order_line_id": order["lines"][0]["id"],
                    "amount_cents": gross,
                }
            ],
        }
        paid = client.post(
            f"{path}/{order['id']}/supplier-payments", headers=_headers(), json=facts
        )
        assert paid.status_code == 201, paid.text


@pytest.mark.parametrize("gross", [-1, True, 1.5, "75000", 2**63])
def test_invalid_gross_unit_price_is_rejected(tmp_path: Path, gross):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        payload = _payload(
            harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=1300
        )
        payload["lines"][0]["gross_unit_cost_cents"] = gross
        response = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers=_headers(),
            json=payload,
        )
        assert response.status_code == 422


def test_gross_quote_edit_without_tax_rate_preserves_existing_rate(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        payload = _payload(
            harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=1300
        )
        payload["lines"][0].update(
            quantity="39.000", unit_cost_cents=66372,
            gross_unit_cost_cents=75000, overage_reason="整批采购",
        )
        path = f"/api/projects/{harness.project_code}/purchase-orders"
        created = client.post(path, headers=_headers(), json=payload)
        assert created.status_code == 201, created.text
        order = created.json()
        payload.pop("tax_rate_bps")
        edited = client.put(
            f"{path}/{order['id']}",
            json={**payload, "notes": "只修改说明", "expected_revision": order["revision"]},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["tax_rate_bps"] == 1300
        assert edited.json()["ordered_amount_cents"] == 2925000
        assert edited.json()["lines"][0]["gross_unit_cost_cents"] == 75000
        assert edited.json()["notes"] == "只修改说明"
