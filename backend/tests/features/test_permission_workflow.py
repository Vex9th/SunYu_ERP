from backend.app.features.permission_catalog import (
    permission_catalog,
    validate_permission_keys,
)
from backend.tests.features.test_business_access import business as _business
from backend.tests.features.test_business_access import member
from backend.tests.features.test_procurement_activity import (
    _create_lines,
    _order_payload,
    _post,
)

business = _business


def expanded(keys):
    catalog = {item['key']: item for item in permission_catalog()}
    selected = set(keys)
    pending = list(keys)
    while pending:
        item = catalog[pending.pop()]
        for key in item['dependencies'] + item.get('workflow_dependencies', []):
            if key not in selected:
                selected.add(key)
                pending.append(key)
    return selected


def test_purchase_actions_include_navigation_pickers_and_price_access():
    actions = {'procurement.orders.create', 'procurement.orders.edit', 'procurement.orders.confirm',
               'procurement.receipts.register', 'procurement.payments.register', 'procurement.invoices.register'}
    result = expanded(actions)
    assert {'projects.view', 'companies.view', 'procurement.lines.view', 'procurement.orders.view',
            'procurement.receipts.view', 'procurement.payments.view', 'procurement.invoices.view',
            'sensitive.procurement_prices'} <= result
    assert not {'inventory.shared.manage', 'companies.edit', 'sensitive.company_banking',
                'sensitive.salary_costs', 'sensitive.profit_summary'} & result
    assert validate_permission_keys(sorted(result)) == sorted(result)


def test_receipt_only_and_inventory_issue_do_not_grant_price_or_stock_management():
    assert {'projects.view', 'procurement.orders.view'} <= expanded({'procurement.receipts.register'})
    issue = expanded({'inventory.manage'})
    assert 'projects.view' in issue
    assert not {'sensitive.procurement_prices', 'inventory.shared.manage'} & issue
    shared = expanded({'inventory.shared.manage'})
    assert {'inventory.view', 'inventory.shared.view', 'sensitive.procurement_prices'} <= shared


def test_existing_api_grants_remain_valid_without_automatic_privilege_changes():
    keys = ['procurement.orders.view', 'procurement.orders.create']
    assert validate_permission_keys(keys) == sorted(keys)


def test_owner_repairs_old_group_and_member_completes_allowed_purchase_flow(business):
    owner, _, db = business
    actions = {'procurement.orders.create', 'procurement.orders.edit', 'procurement.orders.confirm',
               'procurement.receipts.register', 'procurement.payments.register', 'procurement.invoices.register'}
    old = actions | {'procurement.orders.view', 'procurement.receipts.view',
                     'procurement.payments.view', 'procurement.invoices.view', 'inventory.view'}
    buyer, _, group = member(business, sorted(old))
    try:
        initial = buyer.get('/api/auth/session').json()
        assert 'procurement.orders.create' in initial['permissions']
        assert 'projects.view' not in initial['permissions']
        assert buyer.get('/api/projects/TEST-1/dashboard').status_code == 403
        # 主账号看见依赖后保存；读取目录/登录本身不会改变旧权限。
        keys = sorted(expanded(old))
        changed = owner.put(f"/api/workgroups/{group['id']}/access", json={
            'expected_revision': group['revision'] + 1, 'permission_keys': keys, 'project_ids': [1],
        })
        assert changed.status_code == 200, changed.text
        assert set(buyer.get('/api/auth/session').json()['permissions']) == set(keys)
        assert buyer.get('/api/projects/TEST-1/dashboard').status_code == 200
        assert buyer.get('/api/projects/TEST-2/dashboard').status_code == 403
        assert buyer.get('/api/companies').status_code == 200
        _, line, _ = _create_lines(owner)
        path = '/api/projects/TEST-1/purchase-orders'
        payload = _order_payload(line['id'], 'WORKFLOW-1')
        order = _post(buyer, path, payload)
        path += f"/{order['id']}"
        edited = buyer.put(path, json={**payload, 'expected_revision': order['revision']})
        assert edited.status_code == 200, edited.text
        order = _post(buyer, path + '/confirm', {'expected_revision': edited.json()['revision']}, status=200)
        order_line = order['lines'][0]['id']
        _post(buyer, path + '/goods-receipts', {'received_on':'2026-11-11','warehouse_name':'合成仓库','notes':None,
              'lines':[{'purchase_order_line_id':order_line,'quantity':'5.000'}]})
        allocation = [{'purchase_order_line_id':order_line,'amount_cents':5000}]
        _post(buyer, path + '/supplier-payments', {'paid_on':'2026-11-11','amount_cents':5000,
              'payment_method':'银行转账','reference_no':None,'notes':None,'allocations':allocation})
        _post(buyer, path + '/supplier-invoices', {'invoice_no':'WORKFLOW-INV-1','invoiced_on':'2026-11-11',
              'amount_cents':5000,'allocations':allocation,'document_version_ids':[]})
        assert db.execute('SELECT quantity_milli FROM inventory_items').fetchone()[0] == 5000
        assert buyer.post('/api/inventory/adjustments', json={}).status_code == 403
    finally:
        buyer.close()
