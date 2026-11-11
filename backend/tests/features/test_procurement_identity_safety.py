from io import BytesIO
from uuid import uuid4

import pytest
from openpyxl import load_workbook

from backend.tests.features.test_business_access import business as _business
from backend.tests.features.test_business_access import member
from backend.tests.features.test_procurement import _line_payload
from backend.tests.features.test_procurement_extensions import _workbook_bytes

business = _business


def _post(client, path, payload, *, status=201, key=None):
    response = client.post(
        path, json=payload, headers={"Idempotency-Key": key or str(uuid4())}
    )
    assert response.status_code == status, response.text
    return response.json()


def _list(client, code="TEST-1"):
    row = _post(client, f"/api/projects/{code}/procurement-lists", {
        "name": "身份回归清单", "notes": None,
    })
    return f"/api/projects/{code}/procurement-lists/{row['id']}", row


def _line(client, path, name):
    return _post(client, f"{path}/lines", {**_line_payload(), "name": name})


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
def test_deleted_line_identity_cannot_target_replacement_from_stale_page(business, method):
    owner, _, _ = business
    path, _ = _list(owner)
    original = _line(owner, path, "旧清单项 A")
    old_path = f"{path}/lines/{original['id']}"
    assert owner.delete(f"{old_path}?expected_revision=1").status_code == 204
    replacement = _line(owner, path, "新清单项 B")
    if method == "PUT":
        response = owner.put(old_path, json={
            **_line_payload(), "name": "旧页面提交 A", "expected_revision": 1,
        })
    else:
        response = owner.delete(f"{old_path}?expected_revision=1")
    assert response.status_code in (404, 409), response.text
    assert replacement['id'] != original['id']
    assert [row['name'] for row in owner.get(path).json()['lines']] == ["新清单项 B"]


def test_deleted_line_history_remains_scoped_to_original_project(business):
    owner, _, _ = business
    first_path, _ = _list(owner)
    first = _line(owner, first_path, "旧清单 A 的物料")
    assert owner.delete(f"{first_path}/lines/{first['id']}?expected_revision=1").status_code == 204
    buyer, _, _ = member(business, ["projects.view", "procurement.lines.view"])
    try:
        second_path, second_list = _list(owner, "TEST-2")
        second = _line(owner, second_path, "新清单 B 物料")
        old_history = buyer.get(f"/api/operation-history/procurement_line/{first['id']}")
        assert old_history.status_code == 200, old_history.text
        assert "旧清单 A 的物料" in old_history.text
        assert buyer.get(f"/api/operation-history/procurement_line/{second['id']}").status_code == 403
        for resource, identifier in (("procurement_line", second['id']),
                                     ("procurement_list", second_list['id'])):
            history = owner.get(f"/api/operation-history/{resource}/{identifier}")
            assert history.status_code == 200, history.text
            assert "旧清单 A 的物料" not in history.text
    finally:
        buyer.close()


def test_copy_allocates_new_line_ids_after_previous_copy_is_deleted(business):
    owner, _, db = business
    path, _ = _list(owner)
    line = _line(owner, path, "复制源")
    _post(owner, f"{path}/lines/{line['id']}/confirm", {"expected_revision": 1}, status=200)
    revision = owner.get(path).json()['revision']
    first = _post(owner, f"{path}/copy-as-draft", {"expected_revision": revision})
    first_line = first['lines'][0]
    assert owner.delete(
        f"/api/projects/TEST-1/procurement-lists/{first['id']}/lines/{first_line['id']}?expected_revision=1"
    ).status_code == 204
    key = str(uuid4())
    second = _post(owner, f"{path}/copy-as-draft", {"expected_revision": revision}, key=key)
    repeated = _post(owner, f"{path}/copy-as-draft", {"expected_revision": revision}, key=key)
    assert second['lines'][0]['id'] > first_line['id']
    assert repeated['id'] == second['id']
    assert db.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 2


def test_import_allocates_new_ids_after_deleted_import_and_replay_is_stable(business):
    owner, _, db = business
    previous = None
    for name in ("首次导入", "再次导入"):
        content = _workbook_bytes([[1, "电气", name, None, None, None, "1", "件", "1", "2"]])
        preview = owner.post(
            "/api/projects/TEST-1/procurement-imports/preview",
            headers={"Idempotency-Key": str(uuid4())},
            files={"file": ("import.xlsx", content)},
        )
        assert preview.status_code == 201, preview.text
        path = f"/api/projects/TEST-1/procurement-imports/{preview.json()['id']}/confirm"
        key = str(uuid4())
        payload = {"list_name": name, "expected_revision": 1}
        result = _post(owner, path, payload, key=key)
        repeated = _post(owner, path, payload, key=key)
        line = result['procurement_list']['lines'][0]
        assert repeated['procurement_list']['lines'][0]['id'] == line['id']
        if previous is not None:
            assert line['id'] > previous
        previous = line['id']
        list_id = result['procurement_list']['id']
        assert owner.delete(
            f"/api/projects/TEST-1/procurement-lists/{list_id}/lines/{line['id']}?expected_revision=1"
        ).status_code == 204
    assert db.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0


def test_order_line_replacement_keeps_distinct_history_and_amounts(business):
    owner, _, _ = business
    path, _ = _list(owner)
    line = _line(owner, path, "采购单物料")
    _post(owner, f"{path}/lines/{line['id']}/confirm", {"expected_revision": 1}, status=200)
    payload = {
        "order_no": "ID-SAFETY", "supplier_company_id": 1,
        "ordered_on": "2026-11-01", "expected_delivery_on": None,
        "notes": None, "document_version_ids": [], "tax_rate_bps": 1300,
        "lines": [{"procurement_line_id": line['id'], "quantity": "1.000",
                   "unit_cost_cents": 1000, "overage_reason": None}],
    }
    order = _post(owner, "/api/projects/TEST-1/purchase-orders", payload)
    first_id = order['lines'][0]['id']
    updated = owner.put(f"/api/projects/TEST-1/purchase-orders/{order['id']}", json={
        **payload, "expected_revision": order['revision'], "notes": "更新备注",
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()['lines'][0]['id'] > first_id
    assert updated.json()['ordered_amount_cents'] == 1130
    history = owner.get(f"/api/operation-history/purchase_order_line/{first_id}").json()['items']
    assert history[0]['changes']['id'] == {"before": first_id, "after": None}
    another = _post(owner, "/api/projects/TEST-1/purchase-orders", {
        **payload, "order_no": "ID-SAFETY-2",
    })
    assert another['lines'][0]['id'] > updated.json()['lines'][0]['id']


def test_quote_preserves_all_user_text_as_literal_cells(business):
    owner, _, db = business
    db.execute("UPDATE companies SET name='=1+4' WHERE id=1")
    path, _ = _list(owner)
    fields = {key: "=1+1" for key in ("category", "name", "specification", "brand", "model", "unit")}
    line = _post(owner, f"{path}/lines", {**_line_payload(), **fields})
    _post(owner, f"{path}/lines/{line['id']}/confirm", {"expected_revision": 1}, status=200)
    quote = _post(owner, f"{path}/quote-exports", {
        "title": "=1+2", "notes": "=1+3", "customer_company_id": 1,
    })
    downloaded = owner.get(quote['download_url'])
    assert downloaded.status_code == 200, downloaded.text
    workbook = load_workbook(BytesIO(downloaded.content), data_only=False)
    try:
        expected = {"B1": "=1+2", "B2": "=1+4", "B3": "=1+3",
                    **{cell: "=1+1" for cell in ("B6", "C6", "D6", "E6", "F6", "H6")}}
        for coordinate, value in expected.items():
            cell = workbook.active[coordinate]
            assert cell.value == value
            assert cell.data_type == 's', coordinate
        assert workbook.active['A6'].value == 1
        assert workbook.active['J6'].value == '75.00'
    finally:
        workbook.close()
