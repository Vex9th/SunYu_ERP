import json
import shutil
from pathlib import Path

import pytest

from backend.app.core.database import connect_database, transaction_immediate
from backend.app.core.migrations import apply_migrations
from backend.tests.features.test_procurement_extensions import _build_harness

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _legacy_database(tmp_path):
    legacy = tmp_path / "migrations"
    legacy.mkdir()
    for path in MIGRATIONS.glob("*.sql"):
        if path.name[:3] <= "028":
            shutil.copyfile(path, legacy / path.name)
    return _build_harness(tmp_path, migrations_dir=legacy)


def _cached_response(db, resource, identifier, response):
    db.execute(
        """INSERT INTO idempotency_requests
        (scope,idempotency_key,request_sha256,response_status,response_json,
         resource_type,resource_id,created_at) VALUES(?,?,?,201,?,?,?,'2026-11-01')""",
        (resource, resource, "0" * 64, json.dumps(response), resource, identifier),
    )


@pytest.mark.parametrize("source", ["audit", "snapshot", "cached_line", "cached_copy", "cached_import"])
def test_upgrade_reserves_deleted_procurement_line_ids_without_changing_history(tmp_path, source):
    harness = _legacy_database(tmp_path)
    with harness.connection() as db:
        if source == "audit":
            db.execute("""INSERT INTO operation_events
                (request_id,action,resource_type,resource_id,actor_kind,actor_name,summary,occurred_at)
                VALUES('old','procurement.lines.delete','procurement_line','70','system','旧版本','删除','2026-11-01')""")
        elif source == "snapshot":
            db.execute("""INSERT INTO procurement_lists
                (id,project_id,name,create_idempotency_key,create_request_hash,created_at,updated_at)
                VALUES(1,1,'历史清单','list','hash','2026-11-01','2026-11-01')""")
            db.execute("""INSERT INTO quote_exports
                (id,project_id,procurement_list_id,title,customer_company_id,idempotency_key,request_hash,created_at)
                VALUES(1,1,1,'历史报价',1,'quote','hash','2026-11-01')""")
            db.execute("""INSERT INTO quote_export_lines
                (quote_export_id,procurement_line_id,sequence_no,category,name,quantity_milli,unit,quoted_unit_price_cents)
                VALUES(1,70,1,'电气','旧物料',1000,'件',100)""")
        elif source == "cached_line":
            _cached_response(db, "procurement_line", 70, {"id": 70})
        elif source == "cached_copy":
            _cached_response(db, "procurement_list", 1, {"id": 1, "lines": [{"id": 70}]})
        else:
            _cached_response(db, "procurement_import", 1, {"procurement_list": {"lines": [{"id": 70}]}})
        before = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("operation_events", "quote_exports", "quote_export_lines", "idempotency_requests")
        }
        apply_migrations(db, MIGRATIONS)
        from backend.app.core.entity_ids import next_entity_id

        with transaction_immediate(db):
            assert next_entity_id(db, "procurement_lines") == 71
        for table, rows in before.items():
            assert [tuple(row) for row in db.execute(f"SELECT * FROM {table}")] == rows
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("source", ["audit", "cached_order"])
def test_upgrade_reserves_deleted_purchase_order_line_ids(tmp_path, source):
    harness = _legacy_database(tmp_path)
    with harness.connection() as db:
        if source == "audit":
            db.execute("""INSERT INTO operation_events
                (request_id,action,resource_type,resource_id,actor_kind,actor_name,summary,occurred_at)
                VALUES('old','procurement.orders.edit','purchase_order_line','80','system','旧版本','修改','2026-11-01')""")
        else:
            _cached_response(db, "purchase_order", 1, {"id": 1, "lines": [{"id": 80}]})
        apply_migrations(db, MIGRATIONS)
        from backend.app.core.entity_ids import next_entity_id

        with transaction_immediate(db):
            assert next_entity_id(db, "purchase_order_lines") == 81


def test_allocator_persists_restart_includes_raw_inserts_and_rolls_back(tmp_path):
    harness = _build_harness(tmp_path)
    from backend.app.core.entity_ids import next_entity_id

    with harness.connection() as db:
        db.execute("""INSERT INTO procurement_lists
            (id,project_id,name,create_idempotency_key,create_request_hash,created_at,updated_at)
            VALUES(1,1,'清单','list','hash','2026-11-01','2026-11-01')""")
        db.execute("""INSERT INTO procurement_lines
            (id,procurement_list_id,sequence_no,category,name,quantity_milli,unit,
             unit_cost_cents,quoted_unit_price_cents,create_idempotency_key,create_request_hash,created_at,updated_at)
            VALUES(100,1,1,'电气','原始插入',1000,'件',100,100,'line','hash','2026-11-01','2026-11-01')""")
        with transaction_immediate(db):
            assert next_entity_id(db, "procurement_lines") == 101
        db.execute("DELETE FROM procurement_lines")
    reopened = connect_database(harness.database_path)
    try:
        with pytest.raises(RuntimeError), transaction_immediate(reopened):
            assert next_entity_id(reopened, "procurement_lines") == 102
            raise RuntimeError("synthetic rollback")
        with transaction_immediate(reopened):
            assert next_entity_id(reopened, "procurement_lines") == 102
        with pytest.raises(RuntimeError, match="transaction"):
            next_entity_id(reopened, "procurement_lines")
        with transaction_immediate(reopened), pytest.raises(ValueError):
            next_entity_id(reopened, "projects; DROP TABLE accounts")
        reopened.execute("UPDATE entity_id_sequences SET last_id=9223372036854775807 WHERE table_name='procurement_lines'")
        with transaction_immediate(reopened), pytest.raises(OverflowError):
            next_entity_id(reopened, "procurement_lines")
    finally:
        reopened.close()
