from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from backend.tests.features.test_procurement import _line_payload
from backend.tests.features.test_procurement_extensions import _build_harness


def post(client, url, payload, *, key=None):
    return client.post(url, json=payload, headers={"Idempotency-Key": key or str(uuid4())})


def two_lines(client, project_code):
    root = f"/api/projects/{project_code}/procurement-lists"
    created = post(client, root, {"name": "独立确认清单", "notes": None})
    assert created.status_code == 201, created.text
    url = f"{root}/{created.json()['id']}"
    lines = []
    for sequence, name in [(1, "物料 A"), (2, "物料 B")]:
        response = post(client, f"{url}/lines", {**_line_payload(), "sequence_no": sequence, "name": name})
        assert response.status_code == 201, response.text
        lines.append(response.json())
    return url, lines


def confirm_line(client, url, line):
    response = post(client, f"{url}/lines/{line['id']}/confirm", {"expected_revision": line['revision']})
    assert response.status_code == 200, response.text
    return response.json()


def create_order(client, harness, line):
    response = post(client, f"/api/projects/{harness.project_code}/purchase-orders", {
        "order_no": "PO-LINES", "supplier_company_id": harness.supplier_company_id,
        "ordered_on": "2026-10-31", "expected_delivery_on": None, "notes": None,
        "document_version_ids": [], "lines": [{"procurement_line_id": line['id'],
        "quantity": "1.000", "unit_cost_cents": 1000, "overage_reason": None}],
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_confirmation_is_independent_and_partial_list_remains_editable(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a, b) = two_lines(client, harness.project_code)
        a = confirm_line(client, url, a)
        assert a['confirmation_status'] == 'confirmed'
        assert a['revision'] == 2
        detail = client.get(url).json()
        assert detail['status'] == 'draft'
        assert detail['confirmed_line_count'] == 1
        assert detail['lines'][1]['revision'] == b['revision']
        changed = client.put(f"{url}/lines/{b['id']}", json={**_line_payload(), "sequence_no": 2,
            "name": "独立修改 B", "expected_revision": b['revision']})
        assert changed.status_code == 200, changed.text
        confirm_line(client, url, changed.json())
        assert client.get(url).json()['status'] == 'confirmed'
        added = post(client, f"{url}/lines", {**_line_payload(), "sequence_no": 3})
        assert added.status_code == 201, added.text
        assert client.get(url).json()['status'] == 'draft'
        options = client.get(f"/api/projects/{harness.project_code}/procurement-options").json()
        assert {line['id'] for line in options['lines']} == {a['id'], b['id']}


def test_reopen_requires_reason_revision_and_preserves_sibling(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a, b) = two_lines(client, harness.project_code)
        a = confirm_line(client, url, a)
        action = f"{url}/lines/{a['id']}/reopen"
        assert post(client, action, {"expected_revision": a['revision'], "reason": " "}).status_code == 422
        stale = post(client, action, {"expected_revision": 1, "reason": "调整规格"})
        assert stale.status_code == 409
        assert stale.json()['current_revision'] == a['revision']
        key = str(uuid4())
        response = post(client, action, {"expected_revision": a['revision'], "reason": "调整规格"}, key=key)
        replay = post(client, action, {"expected_revision": a['revision'], "reason": "调整规格"}, key=key)
        assert response.status_code == replay.status_code == 200
        assert response.json() == replay.json()
        assert response.json()['confirmation_status'] == 'draft'
        assert response.json()['confirmed_at'] is None
        assert client.get(url).json()['lines'][1]['revision'] == b['revision']


@pytest.mark.parametrize('order_status', ['draft', 'cancelled'])
def test_any_order_reference_locks_only_referenced_line(tmp_path: Path, order_status: str):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a, b) = two_lines(client, harness.project_code)
        a = confirm_line(client, url, a)
        order = create_order(client, harness, a)
        if order_status == 'cancelled':
            with harness.connection() as connection:
                connection.execute("UPDATE purchase_orders SET status='cancelled', cancelled_at=?, cancel_reason='测试取消' WHERE id=?", ('2026-10-31', order['id']))
        response = post(client, f"{url}/lines/{a['id']}/reopen", {"expected_revision": a['revision'], "reason": "调整"})
        assert response.status_code == 409, response.text
        assert response.json()['error_code'] == 'PROCUREMENT_LINE_REFERENCED'
        detail = client.get(url).json()
        assert detail['lines'][0]['can_reopen'] is False
        assert '采购单' in detail['lines'][0]['edit_block_reason']
        assert detail['lines'][1]['edit_block_reason'] is None
        assert client.delete(f"{url}/lines/{b['id']}?expected_revision={b['revision']}").status_code == 204


def test_confirm_order_rechecks_line_confirmation(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a, _) = two_lines(client, harness.project_code)
        a = confirm_line(client, url, a)
        order = create_order(client, harness, a)
        with harness.connection() as connection:
            connection.execute("UPDATE procurement_lines SET confirmation_status='draft', confirmed_at=NULL WHERE id=?", (a['id'],))
        response = post(client, f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/confirm", {"expected_revision": order['revision']})
        assert response.status_code == 422, response.text
        with harness.connection() as connection:
            assert connection.execute("SELECT status FROM purchase_orders WHERE id=?", (order['id'],)).fetchone()[0] == 'draft'


def test_delete_checks_line_revision(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a, _) = two_lines(client, harness.project_code)
        stale = client.delete(f"{url}/lines/{a['id']}?expected_revision=9")
        assert stale.status_code == 409, stale.text
        assert client.get(url).json()['line_count'] == 2


def test_removing_line_from_draft_order_preserves_historical_reference_lock(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url, (a,b) = two_lines(client, harness.project_code)
        a = confirm_line(client,url,a)
        b = confirm_line(client,url,b)
        order = create_order(client,harness,a)
        changed = client.put(f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}",json={
            'expected_revision':order['revision'], 'order_no':order['order_no'],
            'supplier_company_id':harness.supplier_company_id,'ordered_on':'2026-10-31',
            'expected_delivery_on':None,'notes':None,'document_version_ids':[],
            'lines':[{'procurement_line_id':b['id'],'quantity':'1.000','unit_cost_cents':1000,'overage_reason':None}],
        })
        assert changed.status_code == 200,changed.text
        reopen = post(client,f"{url}/lines/{a['id']}/reopen",{'expected_revision':a['revision'],'reason':'已从草稿删除'})
        assert reopen.status_code == 409,reopen.text
        assert reopen.json()['error_code'] == 'PROCUREMENT_LINE_REFERENCED'


def test_inventory_history_alone_blocks_reopen_without_locking_sibling(tmp_path: Path):
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        url,(a,_b) = two_lines(client,harness.project_code)
        a = confirm_line(client,url,a)
        with harness.connection() as connection:
            connection.execute("""INSERT INTO inventory_items
                (id,name,unit,create_idempotency_key,create_request_hash,created_at,updated_at)
                VALUES (1,'物料 A','PCS','stock','hash','2026-10-31','2026-10-31')""")
            connection.execute("""INSERT INTO inventory_movements
                (inventory_item_id,procurement_line_id,movement_type,quantity_delta_milli,
                 value_delta_cents,quantity_after_milli,value_after_cents,source_type,source_id,occurred_on,created_at)
                VALUES (1,?,'opening',1000,0,1000,0,'opening',1,'2026-10-31','2026-10-31')""",(a['id'],))
        response = post(client,f"{url}/lines/{a['id']}/reopen",{'expected_revision':a['revision'],'reason':'调整'})
        assert response.status_code == 409,response.text
        lines = client.get(url).json()['lines']
        assert '库存历史' in lines[0]['edit_block_reason']
        assert lines[1]['edit_block_reason'] is None
