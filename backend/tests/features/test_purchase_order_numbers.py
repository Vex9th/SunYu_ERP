from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.tests.features.test_procurement_extensions import (
    Harness,
    _build_harness,
    _create_confirmed_list,
    _insert_company,
)


def _prepare(tmp_path: Path) -> tuple[Harness, dict[str, object]]:
    harness = _build_harness(tmp_path)
    with harness.connection() as connection:
        connection.execute("UPDATE projects SET name = '测试项目'")
    with harness.client() as client:
        procurement_list = _create_confirmed_list(client, harness.project_code)
    return harness, {
        "order_no": "",
        "supplier_company_id": harness.supplier_company_id,
        "ordered_on": "2026-10-11",
        "expected_delivery_on": None,
        "lines": [
            {
                "procurement_line_id": procurement_list["lines"][0]["id"],
                "quantity": "1.000",
                "unit_cost_cents": 900,
                "overage_reason": None,
            }
        ],
        "notes": None,
        "document_version_ids": [],
    }


def _endpoint(harness: Harness) -> str:
    return f"/api/projects/{harness.project_code}/purchase-orders"


def _preview(client: TestClient, harness: Harness, **parameters: object):
    return client.get(
        f"/api/projects/{harness.project_code}/purchase-order-number-preview",
        params={
            "supplier_company_id": harness.supplier_company_id,
            "ordered_on": "2026-10-11",
            **parameters,
        },
    )


def _create(client: TestClient, harness: Harness, payload: dict[str, object]):
    return client.post(
        _endpoint(harness),
        headers={"Idempotency-Key": str(uuid4())},
        json=payload,
    )


@pytest.mark.parametrize(
    ("project_name", "supplier_name", "expected"),
    [
        ("测试项目", "供应商公司", "PO_CSXM_20261011_GYSGS_001"),
        ("North Site 2", "ACME / Co. 9", "PO_NORTHSITE2_20261011_ACMECO9_001"),
        ("ＡＢＣ 项目", "华东 M&E", "PO_ABCXM_20261011_HDME_001"),
        ("🛰\ue000", "🧪\ue001", "PO_P1_20261011_S2_001"),
    ],
)
def test_preview_normalizes_names_to_ascii_and_has_stable_id_fallback(
    tmp_path: Path, project_name: str, supplier_name: str, expected: str
) -> None:
    harness, _ = _prepare(tmp_path)
    with harness.connection() as connection:
        connection.execute("UPDATE projects SET name = ?", (project_name,))
        connection.execute(
            "UPDATE companies SET name = ? WHERE id = ?",
            (supplier_name, harness.supplier_company_id),
        )
    with harness.client() as client:
        result = _preview(client, harness)
    assert result.status_code == 200, result.text
    assert result.json() == {"order_no": expected}
    assert re.fullmatch(r"[A-Z0-9_]+", result.json()["order_no"])


def test_preview_is_read_only_and_created_orders_advance_sequence(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    with harness.connection() as connection:
        before = list(connection.iterdump())
    with harness.client() as client:
        first_preview = _preview(client, harness)
        second_preview = _preview(client, harness)
        assert first_preview.status_code == second_preview.status_code == 200
        assert first_preview.json() == second_preview.json()
        with harness.connection() as connection:
            assert list(connection.iterdump()) == before
        first = _create(client, harness, payload)
        second = _create(client, harness, payload)
        next_day = _create(client, harness, {**payload, "ordered_on": "2026-10-12"})
        assert first.status_code == second.status_code == next_day.status_code == 201
        assert first.json()["order_no"] == "PO_CSXM_20261011_GYSGS_001"
        assert second.json()["order_no"] == "PO_CSXM_20261011_GYSGS_002"
        assert next_day.json()["order_no"] == "PO_CSXM_20261012_GYSGS_001"
        assert _preview(client, harness).json()["order_no"].endswith("_003")


def test_sequence_handles_manual_case_collisions_and_literal_underscores(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    with harness.client() as client:
        for number in ("po_csxm_20261011_gysgs_009", "POXCSXM_20261011_GYSGS_999"):
            response = _create(client, harness, {**payload, "order_no": number})
            assert response.status_code == 201, response.text
        response = _create(client, harness, payload)
        assert response.status_code == 201, response.text
        assert response.json()["order_no"] == "PO_CSXM_20261011_GYSGS_010"
        boundary = _create(
            client, harness, {**payload, "order_no": "PO_CSXM_20261011_GYSGS_999"}
        )
        assert boundary.status_code == 201
        assert (
            _preview(client, harness).json()["order_no"]
            == "PO_CSXM_20261011_GYSGS_1000"
        )


@pytest.mark.parametrize(
    ("legacy_suffix", "expected_suffix"),
    [
        ("1" * 4301, "1" * 4300 + "2"),
        ("9" * 4300, "1" + "0" * 4300),
        ("0" * 4300 + "7", "008"),
    ],
    ids=["4301-digit-suffix", "4300-digit-carry", "long-leading-zeros"],
)
def test_sequence_preserves_arbitrarily_long_legacy_numeric_suffixes(
    tmp_path: Path, legacy_suffix: str, expected_suffix: str
) -> None:
    harness, payload = _prepare(tmp_path)
    prefix = "PO_CSXM_20261011_GYSGS_"
    with harness.client() as client:
        legacy = _create(
            client, harness, {**payload, "order_no": prefix + legacy_suffix}
        )
        assert legacy.status_code == 201, legacy.text
        preview = _preview(client, harness)
        assert preview.status_code == 200, preview.text
        assert preview.json()["order_no"] == prefix + expected_suffix
        automatic = _create(client, harness, payload)
        assert automatic.status_code == 201, automatic.text
        assert automatic.json()["order_no"] == prefix + expected_suffix
        loaded = client.get(f"{_endpoint(harness)}/{legacy.json()['id']}")
        assert loaded.json()["order_no"] == prefix + legacy_suffix


def test_same_abbreviations_in_other_projects_and_suppliers_share_sequence(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    with harness.connection() as connection:
        second_supplier = _insert_company(connection, "工艺商公司")
    with harness.client() as client:
        first = _create(client, harness, payload)
        second = _create(
            client, harness, {**payload, "supplier_company_id": second_supplier}
        )
        assert first.status_code == second.status_code == 201
        assert second.json()["order_no"] == "PO_CSXM_20261011_GYSGS_002"
        other = client.get(
            f"/api/projects/{harness.other_project_code}/purchase-order-number-preview",
            params={"supplier_company_id": second_supplier, "ordered_on": "2026-10-11"},
        )
        assert other.status_code == 200, other.text
        assert other.json()["order_no"] == "PO_CSXM_20261011_GYSGS_003"


def test_names_are_bounded_and_renaming_does_not_rewrite_saved_numbers(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    with harness.client() as client:
        legacy = _create(client, harness, {**payload, "order_no": "历史采购-01"})
        automatic = _create(client, harness, payload)
        assert legacy.status_code == automatic.status_code == 201
        with harness.connection() as connection:
            connection.execute("UPDATE projects SET name = ?", ("项目" * 200,))
            connection.execute(
                "UPDATE companies SET name = ? WHERE id = ?",
                ("ABC" * 200, harness.supplier_company_id),
            )
        preview = _preview(client, harness)
        assert preview.status_code == 200
        assert len(preview.json()["order_no"]) <= 100
        assert re.fullmatch(r"[A-Z0-9_]+", preview.json()["order_no"])
        for order in (legacy.json(), automatic.json()):
            loaded = client.get(f"{_endpoint(harness)}/{order['id']}")
            assert loaded.json()["order_no"] == order["order_no"]
        edited = client.put(
            f"{_endpoint(harness)}/{legacy.json()['id']}",
            json={**payload, "order_no": "历史采购-01", "expected_revision": 1},
        )
        assert edited.status_code == 200
        assert edited.json()["order_no"] == "历史采购-01"
        blank = client.put(
            f"{_endpoint(harness)}/{legacy.json()['id']}",
            json={**payload, "expected_revision": edited.json()["revision"]},
        )
        assert blank.status_code == 422


def test_concurrent_creates_and_retries_allocate_unique_numbers(tmp_path: Path) -> None:
    harness, payload = _prepare(tmp_path)
    barrier = Barrier(6)
    shared_key = str(uuid4())
    keys = [shared_key, shared_key, *(str(uuid4()) for _ in range(4))]

    def create(key: str):
        with harness.client() as client:
            barrier.wait(timeout=10)
            return client.post(
                _endpoint(harness), headers={"Idempotency-Key": key}, json=payload
            )

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(create, keys))
    assert [result.status_code for result in results] == [201] * 6
    assert results[0].json() == results[1].json()
    numbers = {result.json()["order_no"] for result in results}
    assert numbers == {f"PO_CSXM_20261011_GYSGS_{number:03d}" for number in range(1, 6)}
    with harness.connection() as connection:
        assert (
            connection.execute("SELECT COUNT(*) FROM purchase_orders").fetchone()[0]
            == 5
        )


def test_auto_idempotency_replays_original_input_after_rename_and_archive(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    headers = {"Idempotency-Key": str(uuid4())}
    with harness.client() as client:
        first = client.post(_endpoint(harness), headers=headers, json=payload)
        assert first.status_code == 201, first.text
        with harness.connection() as connection:
            connection.execute(
                "UPDATE projects SET name = '新项目', status = 'archived', "
                "archived_at = '2026-10-11T00:00:00+00:00'"
            )
        replay = client.post(_endpoint(harness), headers=headers, json=payload)
        assert replay.status_code == 201
        assert replay.json() == first.json()
        changed = client.post(
            _endpoint(harness), headers=headers, json={**payload, "notes": "changed"}
        )
        assert changed.status_code == 409
        assert changed.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
        for rejected in (_preview(client, harness), _create(client, harness, payload)):
            assert rejected.status_code == 409
            assert rejected.json()["error_code"] == "PROJECT_ARCHIVED"


@pytest.mark.parametrize(
    "parameters",
    [
        {"supplier_company_id": "0"},
        {"supplier_company_id": "abc"},
        {"supplier_company_id": "1.0"},
        {"supplier_company_id": "-1"},
        {"supplier_company_id": str(2**63)},
        {"supplier_company_id": "9" * 4301},
        {"ordered_on": "2026-02-30"},
        {"ordered_on": "20261011"},
        {"ordered_on": ""},
    ],
)
def test_preview_rejects_invalid_parameters(
    tmp_path: Path, parameters: dict[str, object]
) -> None:
    harness, _ = _prepare(tmp_path)
    with harness.client() as client:
        response = _preview(client, harness, **parameters)
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_preview_requires_authentication_existing_references_and_single_parameters(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    endpoint = f"/api/projects/{harness.project_code}/purchase-order-number-preview"
    with TestClient(harness.app) as anonymous:
        assert anonymous.get(endpoint).status_code == 401
    with harness.client() as client:
        for params in (
            {},
            {"supplier_company_id": harness.supplier_company_id},
            {"ordered_on": "2026-10-11"},
            [
                ("supplier_company_id", "2"),
                ("supplier_company_id", "3"),
                ("ordered_on", "2026-10-11"),
            ],
            [
                ("supplier_company_id", "2"),
                ("ordered_on", "2026-10-11"),
                ("ordered_on", "2026-10-12"),
            ],
        ):
            assert client.get(endpoint, params=params).status_code == 422
        assert _preview(client, harness, supplier_company_id=99999).status_code == 404
        unknown_project = client.get(
            "/api/projects/P-MISSING/purchase-order-number-preview",
            params={
                "supplier_company_id": harness.supplier_company_id,
                "ordered_on": "2026-10-11",
            },
        )
        assert unknown_project.status_code == 404
        assert (
            _create(
                client, harness, {**payload, "supplier_company_id": 99999}
            ).status_code
            == 404
        )


def test_multipart_auto_number_is_used_in_managed_files_and_attachment_retry_hash(
    tmp_path: Path,
) -> None:
    harness, payload = _prepare(tmp_path)
    headers = {"Idempotency-Key": str(uuid4())}
    data = {"payload": json.dumps(payload, ensure_ascii=False)}
    with harness.client() as client:
        first = client.post(
            _endpoint(harness),
            headers=headers,
            data=data,
            files=[("files", ("合同.pdf", b"contract", "application/pdf"))],
        )
        replay = client.post(
            _endpoint(harness),
            headers=headers,
            data=data,
            files=[("files", ("合同.pdf", b"contract", "application/pdf"))],
        )
        changed = client.post(
            _endpoint(harness),
            headers=headers,
            data=data,
            files=[("files", ("合同.pdf", b"changed", "application/pdf"))],
        )
    assert first.status_code == replay.status_code == 201, first.text
    assert first.json() == replay.json()
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    assert first.json()["order_no"] == "PO_CSXM_20261011_GYSGS_001"
    with harness.connection() as connection:
        version = connection.execute(
            "SELECT * FROM document_versions WHERE id = ?",
            (first.json()["document_version_ids"][0],),
        ).fetchone()
        assert first.json()["order_no"] in version["managed_filename"]
        assert (
            harness.settings.data_dir / version["stored_relative_path"]
        ).read_bytes() == b"contract"
        assert (
            connection.execute("SELECT COUNT(*) FROM purchase_orders").fetchone()[0]
            == 1
        )


def test_failed_create_does_not_consume_sequence(tmp_path: Path) -> None:
    harness, payload = _prepare(tmp_path)
    with harness.client() as client:
        invalid = {
            **payload,
            "lines": [{**payload["lines"][0], "procurement_line_id": 99999}],
        }
        failed = _create(client, harness, invalid)
        assert failed.status_code == 422
        valid = _create(client, harness, payload)
        assert valid.status_code == 201, valid.text
        assert valid.json()["order_no"] == "PO_CSXM_20261011_GYSGS_001"
