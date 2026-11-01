from io import BytesIO
from uuid import uuid4

import pytest

from backend.tests.features.test_business_access import business as _business
from backend.tests.features.test_business_access import member
from backend.tests.features.test_procurement_extensions import _line_payload

business = _business

def _post(client, path, payload, *, status=201, key=None):
    response = client.post(path, json=payload, headers={'Idempotency-Key': key or str(uuid4())})
    assert response.status_code == status, response.text
    return response.json()


def _history(client, resource, identifier):
    response = client.get(f'/api/operation-history/{resource}/{identifier}?limit=50')
    assert response.status_code == 200, response.text
    return response.json()['items']


def _create_lines(client):
    procurement_list = _post(client, '/api/projects/TEST-1/procurement-lists', {
        'name': '合成逐项采购清单', 'notes': None,
    })
    base = f"/api/projects/TEST-1/procurement-lists/{procurement_list['id']}/lines"
    a = _post(client, base, _line_payload(name='审计物料 A'))
    b = _post(client, base, _line_payload(sequence_no=2, name='审计物料 B'))
    a = _post(client, f"{base}/{a['id']}/confirm", {'expected_revision': a['revision']}, status=200)
    return base, a, b


def _order_payload(line_id, order_no):
    return {
        'order_no': order_no, 'supplier_company_id': 1, 'ordered_on': '2026-11-01',
        'expected_delivery_on': None, 'notes': None, 'document_version_ids': [],
        'lines': [{'procurement_line_id': line_id, 'quantity': '5.000',
                   'unit_cost_cents': 1000, 'overage_reason': None}],
    }


def test_real_procurement_flow_records_actors_reasons_and_idempotent_child_history(business):
    owner, _, database = business
    permissions = ['projects.view', 'companies.view', 'sensitive.procurement_prices',
        *[f'procurement.lines.{action}' for action in ('view', 'create', 'confirm', 'reopen')],
        *[f'procurement.orders.{action}' for action in ('view', 'create', 'confirm', 'cancel')],
        *[f'procurement.{module}.{action}' for module in ('receipts', 'payments', 'invoices')
          for action in ('view', 'register', 'reverse')]]
    buyer, _, group = member(business, permissions)
    base, a, b = _create_lines(buyer)
    assert a['activity_summary']['last_actor'] == '采购张姐'
    b = _post(buyer, f"{base}/{b['id']}/confirm", {'expected_revision': b['revision']}, status=200)
    reopened = _post(buyer, f"{base}/{b['id']}/reopen", {
        'expected_revision': b['revision'], 'reason': '调整未采购项规格',
    }, status=200)
    assert reopened['confirmation_status'] == 'draft'
    line_events = _history(buyer, 'procurement_line', b['id'])
    assert line_events[0]['action'] == 'procurement.lines.reopen'
    assert line_events[0]['reason'] == '调整未采购项规格'
    assert line_events[0]['actor_name'] == '采购张姐'

    orders_path = '/api/projects/TEST-1/purchase-orders'
    order = _post(buyer, orders_path, _order_payload(a['id'], 'AUDIT-ORDER-1'))
    order_path = f"{orders_path}/{order['id']}"
    order = _post(owner, f'{order_path}/confirm', {'expected_revision': order['revision']}, status=200)
    assert order['activity_summary']['last_actor'] == '主账号'
    order_line = order['lines'][0]['id']
    blocked = buyer.post(f"{base}/{a['id']}/reopen", json={
        'expected_revision': a['revision'], 'reason': '已引用不可更改',
    }, headers={'Idempotency-Key': str(uuid4())})
    assert blocked.status_code == 409
    assert not any(event['action'] == 'procurement.lines.reopen' for event in _history(buyer, 'procurement_line', a['id']))

    receipt = _post(buyer, f'{order_path}/goods-receipts', {
        'received_on': '2026-11-01', 'warehouse_name': '合成仓库', 'notes': None,
        'lines': [{'purchase_order_line_id': order_line, 'quantity': '5.000'}],
    })
    allocation = [{'purchase_order_line_id': order_line, 'amount_cents': 5000}]
    payment_payload = {'paid_on': '2026-11-01', 'amount_cents': 5000,
        'payment_method': '银行转账', 'reference_no': 'AUDIT-PAY', 'notes': None,
        'allocations': allocation}
    payment_key = str(uuid4())
    payment = _post(buyer, f'{order_path}/supplier-payments', payment_payload, key=payment_key)
    event_count = database.execute('SELECT COUNT(*) FROM operation_events').fetchone()[0]
    replay = _post(buyer, f'{order_path}/supplier-payments', payment_payload, key=payment_key)
    assert replay['id'] == payment['id']
    assert database.execute('SELECT COUNT(*) FROM operation_events').fetchone()[0] == event_count
    invoice = _post(buyer, f'{order_path}/supplier-invoices', {
        'invoice_no': 'AUDIT-INVOICE', 'invoiced_on': '2026-11-01', 'amount_cents': 5000,
        'allocations': allocation, 'document_version_ids': [],
    })
    events = _history(buyer, 'purchase_order', order['id'])
    expected_actors = {'procurement.orders.create': '采购张姐', 'procurement.orders.confirm': '主账号',
        'procurement.receipts.register': '采购张姐', 'procurement.payments.register': '采购张姐',
        'procurement.invoices.register': '采购张姐'}
    for action, actor in expected_actors.items():
        matches = [event for event in events if event['action'] == action]
        assert matches, (action, events)
        assert all(event['actor_name'] == actor for event in matches)

    for module, record, reason in (
        ('supplier-invoices', invoice, '合成发票重开'),
        ('supplier-payments', payment, '合成付款撤销'),
        ('goods-receipts', receipt, '合成到货退回'),
    ):
        _post(buyer, f"/api/projects/TEST-1/{module}/{record['id']}/reverse", {
            'expected_revision': record['revision'], 'reason': reason,
        }, status=200)
    events = _history(buyer, 'purchase_order', order['id'])
    assert {'合成发票重开', '合成付款撤销', '合成到货退回'} <= {event['reason'] for event in events}
    assert all(event['actor_name'] == '采购张姐' for event in events if event['action'].endswith('.reverse'))
    item = database.execute('SELECT quantity_milli, inventory_value_cents FROM inventory_items').fetchone()
    assert tuple(item) == (0, 0)

    draft = _post(buyer, orders_path, _order_payload(a['id'], 'AUDIT-CANCEL-2'))
    _post(owner, f"{orders_path}/{draft['id']}/cancel", {
        'expected_revision': draft['revision'], 'reason': '合成需求取消',
    }, status=200)
    cancelled = [event for event in _history(buyer, 'purchase_order', draft['id'])
                 if event['action'] == 'procurement.orders.cancel']
    assert cancelled and all(event['actor_name'] == '主账号' and event['reason'] == '合成需求取消' for event in cancelled)

    account = next(row for row in owner.get('/api/accounts').json() if row['username'] == 'buyer')
    renamed = owner.patch(f"/api/accounts/{account['id']}", json={
        'expected_revision': account['revision'], 'display_name': '改名后的采购员',
    })
    assert renamed.status_code == 200, renamed.text
    historic = _history(owner, 'purchase_order', order['id'])
    assert all(event['actor_name'] == '采购张姐' for event in historic
               if event['action'] in expected_actors and expected_actors[event['action']] == '采购张姐')
    group = next(row for row in owner.get('/api/workgroups').json() if row['id'] == group['id'])
    restricted = owner.put(f"/api/workgroups/{group['id']}/access", json={
        'expected_revision': group['revision'], 'project_ids': [1],
        'permission_keys': [key for key in permissions
            if not key.startswith(('procurement.receipts.', 'procurement.payments.', 'procurement.invoices.'))],
    })
    assert restricted.status_code == 200, restricted.text
    response = buyer.get(order_path)
    assert response.status_code == 200, response.text
    hidden = response.json()
    for key in ('goods_receipts', 'supplier_payments', 'supplier_invoices'):
        assert hidden[key] == []
    assert hidden['paid_amount_cents'] is None
    assert hidden['invoiced_amount_cents'] is None
    assert hidden['received_amount_cents'] is None
    assert hidden['lines'][0]['received_quantity'] is None
    assert not any(event['action'].startswith(('procurement.receipts.', 'procurement.payments.', 'procurement.invoices.'))
                   for event in _history(buyer, 'purchase_order', order['id']))


def test_quote_original_requires_price_access_even_with_export_permission(business, monkeypatch):
    owner, _, database = business
    _, line, _ = _create_lines(owner)
    export = _post(owner, f"/api/projects/TEST-1/procurement-lists/{line['procurement_list_id']}/quote-exports", {
        'title': '合成含价报价', 'customer_company_id': 1, 'notes': None,
    })
    downloaded = owner.get(export['download_url'])
    assert downloaded.status_code == 200
    download_events = [event for event in _history(owner, 'quote_export', export['id'])
                       if event['summary'] == '请求下载报价']
    assert len(download_events) == 1
    assert download_events[0]['actor_name'] == '主账号'
    viewer, _, _ = member(business, ['projects.view', 'companies.view',
        'procurement.lines.view', 'procurement.lines.export'])
    assert viewer.get('/api/projects/TEST-1/quote-exports').status_code == 200
    assert viewer.get(export['download_url']).status_code == 403
    denied = viewer.post(f"/api/projects/TEST-1/procurement-lists/{line['procurement_list_id']}/quote-exports", json={
        'title': '不允许生成', 'customer_company_id': 1, 'notes': None,
    }, headers={'Idempotency-Key': str(uuid4())})
    assert denied.status_code == 403
    assert owner.get('/api/projects/TEST-1/quote-exports/999999/download').status_code == 404
    from backend.app.features import procurement_extensions

    def fail_workbook(*args):
        raise RuntimeError('synthetic workbook failure')

    monkeypatch.setattr(procurement_extensions, '_quote_workbook', fail_workbook)
    with pytest.raises(RuntimeError, match='synthetic workbook failure'):
        owner.get(export['download_url'])
    opened = []

    def track_stream(content):
        stream = BytesIO(content)
        opened.append(stream)
        return stream

    def fail_audit(*args, **kwargs):
        raise RuntimeError('synthetic quote audit failure')

    monkeypatch.setattr(procurement_extensions, '_quote_workbook', lambda *args: downloaded.content)
    monkeypatch.setattr(procurement_extensions, 'BytesIO', track_stream)
    monkeypatch.setattr(procurement_extensions, 'append_operation_event', fail_audit)
    with pytest.raises(RuntimeError, match='synthetic quote audit failure'):
        owner.get(export['download_url'])
    assert len(opened) == 1 and opened[0].closed
    assert database.execute("SELECT COUNT(*) FROM operation_events WHERE summary='请求下载报价'").fetchone()[0] == 1
