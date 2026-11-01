import shutil
from pathlib import Path

from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.tests.features.test_procurement import (
    NOW,
    PROJECT_ROOT,
    _insert_company,
    _insert_project,
)


def test_v025_upgrade_preserves_original_facts_and_backfills_line_and_quote_snapshots(tmp_path: Path):
    migrations = tmp_path / 'migrations'
    migrations.mkdir()
    for path in (PROJECT_ROOT / 'backend/migrations').glob('*.sql'):
        if path.name[:3] <= '025':
            shutil.copyfile(path, migrations / path.name)
    connection = connect_database(tmp_path / 'legacy.sqlite3')
    try:
        apply_migrations(connection, migrations)
        company = _insert_company(connection, '历史客户')
        _insert_project(connection, company, 'P-LEGACY')
        project_id = connection.execute('SELECT id FROM projects').fetchone()[0]
        stamp = NOW.isoformat()
        for identifier, state in [(1, 'draft'), (2, 'confirmed')]:
            connection.execute('''INSERT INTO procurement_lists
                (id,project_id,name,status,confirmed_at,create_idempotency_key,create_request_hash,created_at,updated_at)
                VALUES (?,?,?, ?,?,?, 'hash',?,?)''',
                (identifier, project_id, state, state, stamp if state == 'confirmed' else None, f'list-{identifier}',stamp,stamp))
            connection.execute('''INSERT INTO procurement_lines
                (id,procurement_list_id,sequence_no,category,name,quantity_milli,unit,unit_cost_cents,
                quoted_unit_price_cents,create_idempotency_key,create_request_hash,created_at,updated_at)
                VALUES (?,?,1,'电气','历史物料',1234,'件',102,255,?,'hash',?,?)''',
                (identifier,identifier,f'line-{identifier}',stamp,stamp))
        connection.execute('''INSERT INTO purchase_orders
            (id,project_id,order_no,supplier_company_id,ordered_on,status,cancelled_at,cancel_reason,
            create_idempotency_key,create_request_hash,created_at,updated_at)
            VALUES (1,?,'PO-HISTORY',?,'2026-10-31','cancelled',?,'撤销','order','hash',?,?)''',
            (project_id,company,stamp,stamp,stamp))
        connection.execute('''INSERT INTO purchase_order_lines
            (purchase_order_id,procurement_line_id,quantity_milli,unit_cost_cents,tax_amount_cents,created_at)
            VALUES (1,2,1000,102,13,?)''', (stamp,))
        connection.execute('''INSERT INTO inventory_items
            (id,name,unit,create_idempotency_key,create_request_hash,created_at,updated_at)
            VALUES (1,'历史物料','件','inventory','hash',?,?)''', (stamp,stamp))
        connection.execute('''INSERT INTO inventory_movements
            (inventory_item_id,project_id,procurement_line_id,movement_type,quantity_delta_milli,
            value_delta_cents,quantity_after_milli,value_after_cents,source_type,source_id,occurred_on,created_at)
            VALUES (1,?,2,'opening',1000,102,1000,102,'test',1,'2026-10-31',?)''',(project_id,stamp))
        connection.execute('''INSERT INTO quote_exports
            (project_id,procurement_list_id,title,customer_company_id,idempotency_key,request_hash,created_at)
            VALUES (?,2,'历史报价',?,'quote','hash',?)''',(project_id,company,stamp))
        tables = ['procurement_lists', 'procurement_lines', 'purchase_orders', 'purchase_order_lines', 'inventory_movements', 'quote_exports']
        previous = {table: [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY id')] for table in tables}
        apply_migrations(connection, PROJECT_ROOT / 'backend/migrations')
        for table, original in previous.items():
            upgraded = [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY id')]
            assert [{key: row[key] for key in old} for old,row in zip(original, upgraded, strict=True)] == original
        lines = connection.execute('SELECT confirmation_status,confirmed_at FROM procurement_lines ORDER BY id').fetchall()
        assert [tuple(row) for row in lines] == [('draft',None), ('confirmed',stamp)]
        snapshot = connection.execute('SELECT * FROM quote_export_lines').fetchone()
        assert snapshot['procurement_line_id'] == 2
        assert snapshot['quantity_milli'] == 1234
        assert snapshot['quoted_unit_price_cents'] == 255
        assert connection.execute('SELECT customer_company_name_snapshot FROM quote_exports').fetchone()[0] == '历史客户'
        assert apply_migrations(connection, PROJECT_ROOT / 'backend/migrations') == []
    finally:
        connection.close()
