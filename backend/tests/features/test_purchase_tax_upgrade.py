from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from uuid import uuid4

from backend.app.core.migrations import apply_migrations
from backend.app.features.api_common import save_idempotent_response
from backend.tests.features.test_company_ledger import NOW, _order, _supplier_fact
from backend.tests.features.test_procurement_extensions import (
    PROJECT_ROOT,
    _build_harness,
)


def test_tax_upgrade_preserves_historical_facts_and_old_idempotent_response(
    tmp_path: Path,
) -> None:
    migrations = PROJECT_ROOT / "backend" / "migrations"
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    for path in migrations.glob("*.sql"):
        if path.name[:3] <= "022":
            shutil.copy2(path, legacy_migrations / path.name)
    harness = _build_harness(tmp_path, migrations_dir=legacy_migrations)
    endpoint = f"/api/projects/{harness.project_code}/purchase-orders"
    key = str(uuid4())
    with harness.connection() as connection:
        project_id = connection.execute(
            "SELECT id FROM projects WHERE project_code = ?",
            (harness.project_code,),
        ).fetchone()[0]
        historical = _order(
            connection, project_id, harness.supplier_company_id,
            "历史采购单", "confirmed", [(1, 1500), (333, 1000)],
        )
        _supplier_fact(connection, "supplier_payments", historical, 100)
        _supplier_fact(connection, "supplier_invoices", historical, 200)
        draft = _order(
            connection, project_id, harness.supplier_company_id,
            "LEGACY_001", "draft", [(400, 1000)],
        )
        line = connection.execute(
            "SELECT * FROM purchase_order_lines WHERE purchase_order_id = ?",
            (draft,),
        ).fetchone()
        payload = {
            "order_no": "LEGACY_001",
            "supplier_company_id": harness.supplier_company_id,
            "ordered_on": "2026-10-10",
            "expected_delivery_on": None,
            "lines": [{
                "procurement_line_id": line["procurement_line_id"],
                "quantity": "1.000", "unit_cost_cents": 400,
                "overage_reason": None,
            }],
            "notes": None, "document_version_ids": [],
        }
        # 022 版本请求的规范值。不能调用新版标准化函数来生成预期 hash。
        legacy_normalized = {
            **payload,
            "lines": [{
                "procurement_line_id": line["procurement_line_id"],
                "quantity_milli": 1000, "unit_cost_cents": 400,
                "overage_reason": None,
            }],
        }
        legacy_hash = hashlib.sha256(json.dumps(
            legacy_normalized, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest()
        cached_response = {
            "id": draft, "project_code": harness.project_code,
            "order_no": "LEGACY_001",
            "supplier_company_id": harness.supplier_company_id,
            "supplier_company_name": "供应商公司",
            "ordered_on": "2026-10-10", "expected_delivery_on": None,
            "notes": None, "status": "draft", "cancelled_at": None,
            "cancel_reason": None, "ordered_amount_cents": 400,
            "paid_amount_cents": 0, "invoiced_amount_cents": 0,
            "received_amount_cents": 0, "document_version_ids": [],
            "revision": 1,
            "lines": [{
                "id": line["id"], "purchase_order_id": draft,
                **payload["lines"][0], "received_quantity": "0.000",
                "line_amount_cents": 400,
            }],
            "supplier_payments": [], "supplier_invoices": [],
            "goods_receipts": [], "created_at": NOW, "updated_at": NOW,
        }
        save_idempotent_response(
            connection, scope=f"POST:{endpoint}", key=key,
            request_hash=legacy_hash, response=cached_response,
            response_status=201, resource_type="purchase_order",
            resource_id=draft, created_at=NOW,
        )
        snapshots = {}
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'"
        ):
            table = row[0]
            columns = [item[1] for item in connection.execute(
                f'PRAGMA table_info("{table}")'
            )]
            query = 'SELECT ' + ', '.join(f'"{col}"' for col in columns)
            query += f' FROM "{table}"'
            snapshots[query] = [tuple(item) for item in connection.execute(query)]

        assert apply_migrations(connection, migrations) == ["023_purchase_order_tax"]
        assert apply_migrations(connection, migrations) == []
        for query, rows in snapshots.items():
            assert [tuple(item) for item in connection.execute(query)] == rows
        assert connection.execute(
            "SELECT tax_rate_bps FROM purchase_orders WHERE id = ?", (historical,)
        ).fetchone()[0] is None
        assert list(connection.execute(
            "SELECT tax_amount_cents FROM purchase_order_lines WHERE tax_amount_cents != 0"
        )) == []

    with harness.client() as client:
        replay = client.post(endpoint, headers={"Idempotency-Key": key}, json=payload)
        assert replay.status_code == 201, replay.text
        assert replay.json() == cached_response
        changed = client.post(
            endpoint, headers={"Idempotency-Key": key},
            json={**payload, "tax_rate_bps": 1300},
        )
        assert changed.status_code == 409, changed.text
        assert changed.headers["X-Error-Code"] == "IDEMPOTENCY_KEY_REUSED"
        detail = client.get(f"{endpoint}/{historical}")
        assert detail.status_code == 200, detail.text
        result = detail.json()
        assert result["tax_rate_bps"] is None
        assert result["net_amount_cents"] == result["ordered_amount_cents"] == 335
        assert result["tax_amount_cents"] == 0
        assert result["paid_amount_cents"] == 100
        assert result["invoiced_amount_cents"] == 200
        assert [line["line_amount_cents"] for line in result["lines"]] == [2, 333]
