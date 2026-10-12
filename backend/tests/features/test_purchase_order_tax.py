from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from backend.app.features import procurement
from backend.tests.features.test_procurement_extensions import (
    _build_harness,
    _create_confirmed_list,
)


def _headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _payload(supplier: int, line_id: int, **overrides: object) -> dict:
    return {
        "order_no": "PO-TAX",
        "supplier_company_id": supplier,
        "ordered_on": "2026-08-31",
        "expected_delivery_on": None,
        "notes": None,
        "document_version_ids": [],
        "lines": [
            {
                "procurement_line_id": line_id,
                "quantity": "0.050",
                "unit_cost_cents": 1000,
                "overage_reason": None,
            }
        ],
        **overrides,
    }


@pytest.mark.parametrize(
    "rate,tax,gross",
    [
        (1300, 7, 57),
        (300, 2, 52),
        (1, 0, 50),
        (10000, 50, 100),
        (0, 0, 50),
        (None, 0, 50),
    ],
)
def test_order_adds_tax_after_rounding_each_line_to_cents(
    tmp_path: Path, rate: int | None, tax: int, gross: int
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        payload = _payload(
            harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=rate
        )
        response = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers=_headers(),
            json=payload,
        )
        assert response.status_code == 201, response.text
        order = response.json()
        assert (
            order["net_amount_cents"],
            order["tax_amount_cents"],
            order["ordered_amount_cents"],
        ) == (50, tax, gross)
        assert order["tax_rate_bps"] == rate
        assert order["lines"][0]["unit_cost_cents"] == 1000
        assert (
            order["lines"][0]["net_amount_cents"],
            order["lines"][0]["tax_amount_cents"],
            order["lines"][0]["line_amount_cents"],
        ) == (50, tax, gross)


@pytest.mark.parametrize("rate", [True, False, -1, 10001, 13.0, "1300", [], {}])
def test_invalid_tax_rate_is_rejected(tmp_path: Path, rate: object) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        response = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers=_headers(),
            json=_payload(
                harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=rate
            ),
        )
        assert response.status_code == 422


def test_omitted_tax_keeps_legacy_normalized_payload_and_hash() -> None:
    payload = _payload(1, 2)
    expected = {
        **payload,
        "lines": [
            {
                "procurement_line_id": 2,
                "quantity_milli": 50,
                "unit_cost_cents": 1000,
                "overage_reason": None,
            }
        ],
    }
    assert procurement._normalize_order(payload) == expected
    assert procurement._request_hash(
        procurement._normalize_order(payload)
    ) == procurement._request_hash(expected)


def test_tax_on_multipart_create_and_legacy_update_preserves_rate(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        source = _create_confirmed_list(client, harness.project_code)
        payload = _payload(
            harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=1300
        )
        path = f"/api/projects/{harness.project_code}/purchase-orders"
        response = client.post(
            path,
            headers=_headers(),
            data={"payload": json.dumps(payload)},
            files={"files": ("contract.pdf", b"%PDF-1.4 tax", "application/pdf")},
        )
        assert response.status_code == 201, response.text
        order = response.json()
        payload.pop("tax_rate_bps")
        payload["lines"][0]["unit_cost_cents"] = 2000
        updated = client.put(
            f"{path}/{order['id']}",
            json={**payload, "expected_revision": order["revision"]},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["tax_rate_bps"] == 1300
        assert updated.json()["ordered_amount_cents"] == 113
        cleared = client.put(
            f"{path}/{order['id']}",
            json={
                **payload,
                "tax_rate_bps": None,
                "expected_revision": updated.json()["revision"],
            },
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["tax_rate_bps"] is None
        assert cleared.json()["ordered_amount_cents"] == 100


def _create_order(client, harness, *, rate=1300, quantity="1.000", unit_cost=10000):
    source = _create_confirmed_list(client, harness.project_code)
    payload = _payload(
        harness.supplier_company_id, source["lines"][0]["id"], tax_rate_bps=rate
    )
    payload["lines"][0].update(quantity=quantity, unit_cost_cents=unit_cost)
    path = f"/api/projects/{harness.project_code}/purchase-orders"
    response = client.post(path, headers=_headers(), json=payload)
    assert response.status_code == 201, response.text
    order = response.json()
    confirmed = client.post(
        f"{path}/{order['id']}/confirm",
        headers=_headers(),
        json={"expected_revision": order["revision"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json(), source, payload


def test_gross_amount_caps_payments_invoices_and_drives_procurement_totals(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order, source, payload = _create_order(client, harness)
        path = f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}"
        for kind in ("payments", "invoices"):
            facts = {
                "amount_cents": 11300,
                "allocations": [
                    {
                        "purchase_order_line_id": order["lines"][0]["id"],
                        "amount_cents": 11300,
                    }
                ],
            }
            if kind == "payments":
                facts.update(
                    paid_on="2026-08-31",
                    payment_method="银行转账",
                    reference_no=None,
                    notes=None,
                )
            else:
                facts.update(
                    invoice_no="INV-TAX",
                    invoiced_on="2026-08-31",
                    document_version_ids=[],
                )
            response = client.post(
                f"{path}/supplier-{kind}", headers=_headers(), json=facts
            )
            assert response.status_code == 201, response.text
            facts.update(
                amount_cents=1,
                allocations=[
                    {
                        "purchase_order_line_id": order["lines"][0]["id"],
                        "amount_cents": 1,
                    }
                ],
            )
            if kind == "invoices":
                facts["invoice_no"] = "INV-OVER"
            exceeded = client.post(
                f"{path}/supplier-{kind}", headers=_headers(), json=facts
            )
            assert exceeded.status_code == 409, exceeded.text
            assert exceeded.json()["error_code"] == (
                "PAYMENT_AMOUNT_EXCEEDED"
                if kind == "payments"
                else "INVOICE_AMOUNT_EXCEEDED"
            )
        overview = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        ).json()
        assert overview["procurement_committed_cents"] == 11300
        detail = client.get(
            f"/api/projects/{harness.project_code}/procurement-lists/{source['id']}"
        ).json()
        assert detail["lines"][0]["ordered_amount_cents"] == 11300
        assert detail["lines"][0]["payment_status"] == "paid"
        edited = client.put(
            path,
            json={
                **payload,
                "tax_rate_bps": 300,
                "expected_revision": order["revision"],
            },
        )
        assert edited.status_code == 409
        assert edited.json()["error_code"] == "PURCHASE_ORDER_NOT_EDITABLE"


def _receive(client, harness, order, quantity):
    response = client.post(
        f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/goods-receipts",
        headers=_headers(),
        json={
            "received_on": "2026-08-31",
            "warehouse_name": "主仓",
            "notes": None,
            "lines": [
                {
                    "purchase_order_line_id": order["lines"][0]["id"],
                    "quantity": quantity,
                }
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_partial_receipts_use_gross_value_and_close_rounding_remainder(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order, _, _ = _create_order(
            client, harness, rate=1300, quantity="0.050", unit_cost=1000
        )
        receipts = [
            _receive(client, harness, order, quantity)
            for quantity in ("0.025", "0.024", "0.001")
        ]
        assert [receipt["lines"][0]["value_cents"] for receipt in receipts] == [
            29,
            27,
            1,
        ]
        detail = client.get(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}"
        ).json()
        assert detail["received_amount_cents"] == detail["ordered_amount_cents"] == 57
        with harness.connection() as connection:
            inventory = connection.execute(
                "SELECT quantity_milli, inventory_value_cents FROM inventory_items"
            ).fetchone()
            assert tuple(inventory) == (50, 57)


def test_reversal_then_small_rereceipt_never_creates_negative_value(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order, _, _ = _create_order(client, harness, rate=10000, unit_cost=1)
        receipts = [
            _receive(client, harness, order, quantity)
            for quantity in ("0.250", "0.250", "0.500")
        ]
        assert [receipt["lines"][0]["value_cents"] for receipt in receipts] == [1, 1, 0]
        reversed_receipt = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipts[2]['id']}/reverse",
            headers=_headers(),
            json={"reason": "尾批退回", "expected_revision": receipts[2]["revision"]},
        )
        assert reversed_receipt.status_code == 200, reversed_receipt.text
        assert _receive(client, harness, order, "0.001")["lines"][0]["value_cents"] == 0
        assert _receive(client, harness, order, "0.499")["lines"][0]["value_cents"] == 0
        # 再反冲非最后一批，重收只能恢复被反冲的金额。
        reversed_early = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipts[0]['id']}/reverse",
            headers=_headers(),
            json={"reason": "首批退回", "expected_revision": receipts[0]["revision"]},
        )
        assert reversed_early.status_code == 200, reversed_early.text
        assert _receive(client, harness, order, "0.250")["lines"][0]["value_cents"] == 1
        with harness.connection() as connection:
            assert tuple(
                connection.execute(
                    "SELECT quantity_milli, inventory_value_cents FROM inventory_items"
                ).fetchone()
            ) == (1000, 2)


def test_unset_tax_preserves_legacy_individual_receipt_rounding(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order, _, _ = _create_order(client, harness, rate=None, unit_cost=1)
        assert _receive(client, harness, order, "0.500")["lines"][0]["value_cents"] == 1
        assert _receive(client, harness, order, "0.500")["lines"][0]["value_cents"] == 1


def test_tax_and_order_gross_overflow_are_rejected_before_storage() -> None:
    from backend.app.features.api_common import ApiError
    from backend.app.features.purchase_order_tax import (
        calculate_line_amounts,
        gross_line_value,
    )

    with pytest.raises(ApiError):
        calculate_line_amounts(2**63 - 1, 1000, 1)
    with pytest.raises(ApiError):
        gross_line_value(2**63 - 1, 1000, 1)
    payload = _payload(1, 2, tax_rate_bps=10000)
    payload["lines"] = [
        {
            "procurement_line_id": identifier,
            "quantity": "1.000",
            "unit_cost_cents": 2**61,
            "overage_reason": None,
        }
        for identifier in (1, 2)
    ]
    with pytest.raises(ApiError):
        procurement._normalize_order(payload)
