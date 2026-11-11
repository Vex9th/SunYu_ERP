from uuid import uuid4

from backend.tests.features.test_business_access import business as _business
from backend.tests.features.test_business_access import member
from backend.tests.features.test_procurement_extensions import _workbook_bytes

business = _business
PERMISSIONS = ["projects.view", "procurement.lines.view", "procurement.lines.import",
               "procurement.lines.create"]


def _workbook():
    return _workbook_bytes([
        [1, "电气", "权限回归物料", None, None, None, "1", "PCS", "999.99", "1234.56"],
    ])


def _preview(client, key=None, content=None):
    return client.post(
        "/api/projects/TEST-1/procurement-imports/preview",
        headers={"Idempotency-Key": key or str(uuid4())},
        files={"file": ("import.xlsx", content or _workbook())},
    )


def _confirm(client, import_id):
    return client.post(
        f"/api/projects/TEST-1/procurement-imports/{import_id}/confirm",
        headers={"Idempotency-Key": str(uuid4())},
        json={"list_name": "价格权限回归", "expected_revision": 1},
    )


def test_unpriced_import_permission_cannot_preview_or_confirm_prices(business):
    owner, _, db = business
    buyer, _, _ = member(business, PERMISSIONS)
    try:
        denied = _preview(buyer)
        assert denied.status_code == 403, denied.text
        assert db.execute("SELECT COUNT(*) FROM procurement_imports").fetchone()[0] == 0
        preview = _preview(owner)
        assert preview.status_code == 201, preview.text
        denied = _confirm(buyer, preview.json()['id'])
        assert denied.status_code == 403, denied.text
        assert db.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0
    finally:
        buyer.close()


def test_price_permission_is_rechecked_after_preview_and_on_replay(business):
    owner, _, db = business
    buyer, _, group = member(business, [*PERMISSIONS, "sensitive.procurement_prices"])
    try:
        key = str(uuid4())
        content = _workbook()
        preview = _preview(buyer, key, content)
        assert preview.status_code == 201, preview.text
        assert preview.json()['rows'][0]['unit_cost_cents'] == 99999
        current = next(row for row in owner.get('/api/workgroups').json() if row['id'] == group['id'])
        changed = owner.put(f"/api/workgroups/{group['id']}/access", json={
            "expected_revision": current['revision'], "project_ids": [1],
            "permission_keys": PERMISSIONS,
        })
        assert changed.status_code == 200, changed.text
        assert _confirm(buyer, preview.json()['id']).status_code == 403
        replay = _preview(buyer, key, content)
        assert replay.status_code == 403, replay.text
        assert db.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0
        assert db.execute("SELECT status FROM procurement_imports").fetchone()[0] == 'preview'
    finally:
        buyer.close()
