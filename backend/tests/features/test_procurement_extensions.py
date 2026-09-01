from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from starlette.datastructures import UploadFile

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.core.storage_paths import project_code_identity
from backend.app.features import procurement, procurement_extensions
from backend.app.features.api_common import ApiError

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 31, 2, 0, tzinfo=timezone.utc)


@dataclass(frozen=True)
class Harness:
    app: FastAPI
    database_path: Path
    settings: Settings
    project_code: str
    other_project_code: str
    customer_company_id: int
    supplier_company_id: int
    document_version_id: int

    @contextmanager
    def client(self) -> Iterator[TestClient]:
        with TestClient(self.app) as client:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
            yield client

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = connect_database(self.database_path)
        try:
            yield connection
        finally:
            connection.close()


def _insert_company(connection: sqlite3.Connection, name: str) -> int:
    cursor = connection.execute(
        """
        INSERT INTO companies
            (name, taxpayer_id, registered_address, registered_phone,
             bank_name, bank_account, notes, created_at, updated_at)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        """,
        (name, NOW.isoformat(), NOW.isoformat()),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def _insert_project(
    connection: sqlite3.Connection,
    company_id: int,
    project_code: str,
) -> None:
    connection.execute(
        """
        INSERT INTO projects
            (project_code, project_code_key, company_id, name, description,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
        """,
        (
            project_code,
            project_code_identity(project_code),
            company_id,
            f"{project_code} 测试项目",
            NOW.isoformat(),
            NOW.isoformat(),
        ),
    )


def _insert_document_version(
    connection: sqlite3.Connection,
    project_code: str,
) -> int:
    document = connection.execute(
        """
        INSERT INTO documents
            (project_code, category, logical_name, notes, archive_reason,
             archived_at, revision, created_at, updated_at)
        VALUES (?, 'procurement', '供应商发票', NULL, NULL, NULL, 1, ?, ?)
        """,
        (project_code, NOW.isoformat(), NOW.isoformat()),
    )
    assert document.lastrowid is not None
    version = connection.execute(
        """
        INSERT INTO document_versions
            (document_id, version_number, original_filename, content_type,
             stored_relative_path, size_bytes, sha256, notes, created_at)
        VALUES (?, 1, 'invoice.pdf', 'application/pdf', ?, 1, ?, NULL, ?)
        """,
        (
            int(document.lastrowid),
            f"{project_code}/{document.lastrowid}/invoice.pdf",
            "0" * 64,
            NOW.isoformat(),
        ),
    )
    assert version.lastrowid is not None
    return int(version.lastrowid)


def _build_harness(tmp_path: Path) -> Harness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
        customer_id = _insert_company(connection, "客户公司")
        supplier_id = _insert_company(connection, "供应商公司")
        _insert_project(connection, customer_id, "P-2026-001")
        _insert_project(connection, customer_id, "P-2026-002")
        document_version_id = _insert_document_version(connection, "P-2026-001")
    finally:
        connection.close()

    settings = Settings(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        backup_dir=None,
        backup_interval_hours=24,
        backup_retention_days=30,
        host="127.0.0.1",
        port=8765,
        session_secret="procurement-extension-session-secret",
    )

    def get_connection() -> Iterator[sqlite3.Connection]:
        owned = connect_database(database_path)
        try:
            yield owned
        finally:
            owned.close()

    def get_settings() -> Settings:
        return settings

    app = FastAPI()
    app.include_router(
        procurement.create_procurement_router(
            get_connection,
            get_settings,
            clock=lambda: NOW,
        )
    )
    app.include_router(
        procurement_extensions.create_procurement_extensions_router(
            get_connection,
            get_settings,
            clock=lambda: NOW,
        )
    )
    return Harness(
        app,
        database_path,
        settings,
        "P-2026-001",
        "P-2026-002",
        customer_id,
        supplier_id,
        document_version_id,
    )


def _line_payload(*, sequence_no: int = 1, name: str = "接触器") -> dict[str, object]:
    return {
        "sequence_no": sequence_no,
        "category": "电气",
        "name": name,
        "specification": "AC220V",
        "brand": "施耐德",
        "model": "LC1D09",
        "quantity": "5.000",
        "unit": "PCS",
        "unit_cost_cents": 1000,
        "quoted_unit_price_cents": 1500,
    }


def _create_confirmed_list(
    client: TestClient,
    project_code: str,
    *,
    key_prefix: str = "10000000",
) -> dict[str, object]:
    created = client.post(
        f"/api/projects/{project_code}/procurement-lists",
        headers={"Idempotency-Key": f"{key_prefix}-0000-4000-8000-000000000001"},
        json={"name": "采购清单", "notes": None},
    )
    assert created.status_code == 201, created.text
    procurement_list = created.json()
    line = client.post(
        f"/api/projects/{project_code}/procurement-lists/{procurement_list['id']}/lines",
        headers={"Idempotency-Key": f"{key_prefix}-0000-4000-8000-000000000002"},
        json=_line_payload(),
    )
    assert line.status_code == 201, line.text
    confirmed = client.post(
        f"/api/projects/{project_code}/procurement-lists/{procurement_list['id']}/confirm",
        headers={"Idempotency-Key": f"{key_prefix}-0000-4000-8000-000000000003"},
        json={"expected_revision": line.json()["list_revision"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def _create_confirmed_order(
    client: TestClient,
    harness: Harness,
) -> dict[str, object]:
    procurement_list = _create_confirmed_list(client, harness.project_code)
    order = client.post(
        f"/api/projects/{harness.project_code}/purchase-orders",
        headers={"Idempotency-Key": "20000000-0000-4000-8000-000000000001"},
        json={
            "order_no": "PO-001",
            "supplier_company_id": harness.supplier_company_id,
            "ordered_on": "2026-08-31",
            "expected_delivery_on": None,
            "lines": [
                {
                    "procurement_line_id": procurement_list["lines"][0]["id"],
                    "quantity": "5.000",
                    "unit_cost_cents": 1000,
                    "overage_reason": None,
                }
            ],
            "notes": None,
            "document_version_ids": [],
        },
    )
    assert order.status_code == 201, order.text
    confirmed = client.post(
        f"/api/projects/{harness.project_code}/purchase-orders/{order.json()['id']}/confirm",
        headers={"Idempotency-Key": "20000000-0000-4000-8000-000000000002"},
        json={"expected_revision": order.json()["revision"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    return confirmed.json()


def _workbook_bytes(rows: list[list[object]]) -> bytes:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(
        [
            "序号",
            "大类",
            "名称",
            "规格",
            "品牌",
            "型号",
            "数量",
            "单位",
            "成本单价（元）",
            "报价单价（元）",
        ]
    )
    for row in rows:
        worksheet.append(row)
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def _replace_zip_member(content: bytes, name: str, replacement: bytes) -> bytes:
    output = BytesIO()
    with ZipFile(BytesIO(content)) as source, ZipFile(
        output, "w", compression=ZIP_DEFLATED
    ) as target:
        for member in source.infolist():
            target.writestr(
                member,
                replacement if member.filename == name else source.read(member),
            )
    return output.getvalue()


def _compressed_archive(member_count: int, member_size: int) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for index in range(member_count):
            archive.writestr(f"xl/payload-{index}.xml", b"A" * member_size)
    return output.getvalue()


def test_import_preview_is_read_only_and_confirm_is_atomic_canonical_idempotent(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO inventory_items
                (brand, name, model, specification, unit, notes,
                 quantity_milli, inventory_value_cents, revision,
                 create_idempotency_key, create_request_hash,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?, ?, ?)
            """,
            (
                " 施耐德 ",
                "接触器",
                "lc1d09",
                "AC220V",
                "pcs",
                "import-match-key",
                "import-match-hash",
                NOW.isoformat(),
                NOW.isoformat(),
            ),
        )
        assert cursor.lastrowid is not None
        matching_inventory_id = cursor.lastrowid
    content = _workbook_bytes(
        [
            [1, "电气", "接触器", "AC220V", "施耐德", "LC1D09", "5.000", "PCS", "10.00", "15.00"],
            [2, "辅材", "线槽", None, None, None, "2.500", "M", "3.25", "5.50"],
        ]
    )
    with harness.client() as client:
        preview_headers = {
            "Idempotency-Key": "30000000-0000-4000-8000-000000000010"
        }
        preview = client.post(
            f"/api/projects/{harness.project_code.lower()}/procurement-imports/preview",
            headers=preview_headers,
            files={
                "file": (
                    "采购清单.xlsx",
                    content,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        assert preview.status_code == 201, preview.text
        body = preview.json()
        assert body["project_code"] == harness.project_code
        assert body["status"] == "preview"
        assert body["revision"] == 1
        assert body["errors"] == []
        assert body["rows"] == [
            _line_payload(),
            {
                "sequence_no": 2,
                "category": "辅材",
                "name": "线槽",
                "specification": None,
                "brand": None,
                "model": None,
                "quantity": "2.500",
                "unit": "M",
                "unit_cost_cents": 325,
                "quoted_unit_price_cents": 550,
            },
        ]
        with harness.connection() as connection:
            assert connection.execute("SELECT COUNT(*) FROM procurement_lists").fetchone()[0] == 0
            assert connection.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0

        headers = {"Idempotency-Key": "30000000-0000-4000-8000-000000000001"}
        payload = {"list_name": " Excel 导入 ", "expected_revision": 1}
        confirmed = client.post(
            f"/api/projects/{harness.project_code.lower()}/procurement-imports/{body['id']}/confirm",
            headers=headers,
            json=payload,
        )
        duplicate = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "30000000-0000-4000-8000-000000000011"
            },
            files={"file": ("同一份清单.xlsx", content)},
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["error_code"] == "PROCUREMENT_IMPORT_ALREADY_CONFIRMED"
        with harness.connection() as connection:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?, archive_reason = ?
                WHERE project_code_key = ?
                """,
                (
                    NOW.isoformat(),
                    "测试归档",
                    project_code_identity(harness.project_code),
                ),
            )
        preview_replay = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers=preview_headers,
            files={
                "file": (
                    "采购清单.xlsx",
                    content,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
        preview_key_reuse = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers=preview_headers,
            files={"file": ("另一份.xlsx", _workbook_bytes([[1, "电气", "不同物料", None, None, None, "1", "PCS", "1", "2"]]))},
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/{body['id']}/confirm",
            headers=headers,
            json=payload,
        )

    assert confirmed.status_code == replay.status_code == 201
    assert confirmed.json() == replay.json()
    assert preview_replay.status_code == 201
    assert preview_replay.json() == preview.json()
    assert preview_key_reuse.status_code == 409
    assert preview_key_reuse.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    imported_list = confirmed.json()["procurement_list"]
    assert imported_list["name"] == "Excel 导入"
    assert imported_list["status"] == "draft"
    assert imported_list["line_count"] == 2
    assert imported_list["lines"][0]["inventory_item_id"] == matching_inventory_id
    assert imported_list["lines"][1]["inventory_item_id"] is None
    with harness.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM procurement_lists").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 2


def test_import_reports_cell_errors_enforces_limits_and_never_partially_confirms(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    invalid = _workbook_bytes(
        [[1, "电气", None, "AC220V", None, None, "abc", "PCS", "-1.00", "15.001"]]
    )
    with harness.client() as client:
        anonymous = TestClient(harness.app).post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            files={"file": ("bad.xlsx", b"not-xlsx")},
        )
        assert anonymous.status_code == 401

        too_large = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "31000000-0000-4000-8000-000000000001"
            },
            files={"file": ("huge.xlsx", b"x" * (20 * 1024 * 1024 + 1))},
        )
        assert too_large.status_code == 422

        preview = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "31000000-0000-4000-8000-000000000002"
            },
            files={"file": ("invalid.xlsx", invalid)},
        )
        assert preview.status_code == 201, preview.text
        errors = preview.json()["errors"]
        assert {(item["row"], item["column"], item["field"]) for item in errors} == {
            (2, 3, "name"),
            (2, 7, "quantity"),
            (2, 9, "unit_cost_cents"),
            (2, 10, "quoted_unit_price_cents"),
        }
        confirm = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/{preview.json()['id']}/confirm",
            headers={"Idempotency-Key": "30000000-0000-4000-8000-000000000002"},
            json={"list_name": "不得创建", "expected_revision": 1},
        )
    assert confirm.status_code == 409
    assert confirm.json()["error_code"] == "PROCUREMENT_IMPORT_HAS_ERRORS"
    with harness.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM procurement_lists").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0

    too_many_rows = [[index, "电气", "物料", None, None, None, "1", "PCS", "1", "2"] for index in range(1, 10_002)]
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "31000000-0000-4000-8000-000000000003"
            },
            files={"file": ("too-many.xlsx", _workbook_bytes(too_many_rows))},
        )
    assert response.status_code == 422


def test_import_reports_duplicate_normalized_business_rows_and_blocks_confirm(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    content = _workbook_bytes(
        [
            [
                1,
                "电气",
                "接触器",
                "AC220V",
                "施耐德",
                "LC1D09",
                "5.000",
                "PCS",
                "10.00",
                "15.00",
            ],
            [
                2,
                " 电气 ",
                "接触器",
                "AC220V",
                "施耐德",
                "LC1D09",
                "5",
                " PCS ",
                "10",
                "15",
            ],
        ]
    )
    with harness.client() as client:
        preview = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "31000000-0000-4000-8000-000000000004"
            },
            files={"file": ("duplicate-lines.xlsx", content)},
        )
        assert preview.status_code == 201, preview.text
        assert preview.json()["rows"] == [_line_payload()]
        assert preview.json()["errors"] == [
            {
                "row": 3,
                "column": 0,
                "field": "row",
                "message": "业务字段重复",
            }
        ]

        confirm = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/"
            f"{preview.json()['id']}/confirm",
            headers={
                "Idempotency-Key": "31000000-0000-4000-8000-000000000005"
            },
            json={"list_name": "不得创建", "expected_revision": 1},
        )

    assert confirm.status_code == 409
    assert confirm.json()["error_code"] == "PROCUREMENT_IMPORT_HAS_ERRORS"
    with harness.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM procurement_lists").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM procurement_lines").fetchone()[0] == 0


def test_import_rejects_formula_malformed_ooxml_and_zip_bombs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = _build_harness(tmp_path)
    formula = _workbook_bytes(
        [[1, "电气", "公式物料", None, None, None, "=1+1", "PCS", "1", "2"]]
    )
    malformed = _replace_zip_member(
        _workbook_bytes(
            [[1, "电气", "畸形物料", None, None, None, "1", "PCS", "1", "2"]]
        ),
        "xl/worksheets/sheet1.xml",
        b"<worksheet><broken>",
    )
    with harness.client() as client:
        formula_response = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "32000000-0000-4000-8000-000000000001"
            },
            files={"file": ("formula.xlsx", formula)},
        )
        assert formula_response.status_code == 201
        assert formula_response.json()["rows"] == []
        assert [error["field"] for error in formula_response.json()["errors"]] == [
            "quantity"
        ]

        malformed_response = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "32000000-0000-4000-8000-000000000002"
            },
            files={"file": ("malformed.xlsx", malformed)},
        )
        assert malformed_response.status_code == 422
        assert malformed_response.json()["error_code"] == "VALIDATION_ERROR"

        def must_not_parse(_: BytesIO, **__: object) -> Workbook:
            raise AssertionError("unsafe archive reached openpyxl")

        monkeypatch.setattr(procurement_extensions, "load_workbook", must_not_parse)
        ratio_bomb = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "32000000-0000-4000-8000-000000000003"
            },
            files={"file": ("ratio-bomb.xlsx", _compressed_archive(1, 2_000_000))},
        )
        assert ratio_bomb.status_code == 422
        member_bomb = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "32000000-0000-4000-8000-000000000004"
            },
            files={"file": ("member-bomb.xlsx", _compressed_archive(300, 1))},
        )
        assert member_bomb.status_code == 422


def test_import_limits_asgi_receive_and_closes_every_multipart_upload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    boundary = b"procurement-boundary"
    prefix = (
        b"--"
        + boundary
        + b'\r\nContent-Disposition: form-data; name="file"; filename="large.xlsx"'
        + b"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    chunks = [prefix, *([b"x" * (1024 * 1024)] * 22), b"\r\n--" + boundary + b"--\r\n"]
    received = 0

    async def receive() -> dict[str, object]:
        nonlocal received
        if received >= len(chunks):
            return {"type": "http.disconnect"}
        body = chunks[received]
        received += 1
        return {
            "type": "http.request",
            "body": body,
            "more_body": received < len(chunks),
        }

    request = Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [
                (
                    b"content-type",
                    b"multipart/form-data; boundary=" + boundary,
                )
            ],
            "client": ("test", 123),
            "server": ("test", 80),
        },
        receive,
    )
    with pytest.raises(ApiError) as failure:
        asyncio.run(procurement_extensions._read_xlsx_upload(request))
    assert failure.value.status_code == 422
    assert received < len(chunks)

    harness = _build_harness(tmp_path)
    closed: list[str | None] = []
    original_close = UploadFile.close

    async def tracked_close(upload: UploadFile) -> None:
        closed.append(upload.filename)
        await original_close(upload)

    monkeypatch.setattr(UploadFile, "close", tracked_close)
    with harness.client() as client:
        response = client.post(
            f"/api/projects/{harness.project_code}/procurement-imports/preview",
            headers={
                "Idempotency-Key": "33000000-0000-4000-8000-000000000001"
            },
            files=[
                ("file", ("first.xlsx", _workbook_bytes([]))),
                ("extra", ("second.xlsx", _workbook_bytes([]))),
            ],
        )
    assert response.status_code == 422
    assert sorted(closed) == ["first.xlsx", "second.xlsx"]


def test_draft_order_update_and_cancel_are_strict_revisioned_and_idempotent(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        procurement_list = _create_confirmed_list(client, harness.project_code)
        line_id = procurement_list["lines"][0]["id"]
        created = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders",
            headers={"Idempotency-Key": "40000000-0000-4000-8000-000000000001"},
            json={
                "order_no": " PO-EDIT ",
                "supplier_company_id": harness.supplier_company_id,
                "ordered_on": "2026-08-31",
                "expected_delivery_on": None,
                "lines": [{"procurement_line_id": line_id, "quantity": "2.000", "unit_cost_cents": 900, "overage_reason": None}],
                "notes": None,
                "document_version_ids": [],
            },
        )
        assert created.status_code == 201, created.text
        update_payload = {
            "order_no": "PO-UPDATED",
            "supplier_company_id": harness.supplier_company_id,
            "ordered_on": "2026-08-31",
            "expected_delivery_on": "2026-09-03",
            "lines": [{"procurement_line_id": line_id, "quantity": "3.000", "unit_cost_cents": 950, "overage_reason": None}],
            "notes": "改价",
            "document_version_ids": [],
            "expected_revision": created.json()["revision"],
        }
        updated = client.put(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}",
            json=update_payload,
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["order_no"] == "PO-UPDATED"
        assert updated.json()["lines"][0]["quantity"] == "3.000"
        stale = client.put(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}",
            json=update_payload,
        )
        assert stale.status_code == 409
        assert stale.json()["error_code"] == "REVISION_CONFLICT"
        extra = client.put(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}",
            json={**update_payload, "extra": True},
        )
        assert extra.status_code == 422
        cross_project = client.put(
            f"/api/projects/{harness.other_project_code}/purchase-orders/{created.json()['id']}",
            json={**update_payload, "expected_revision": updated.json()["revision"]},
        )
        assert cross_project.status_code == 404

        headers = {"Idempotency-Key": "40000000-0000-4000-8000-000000000002"}
        cancel_payload = {"reason": "需求取消", "expected_revision": updated.json()["revision"]}
        cancelled = client.post(
            f"/api/projects/{harness.project_code.lower()}/purchase-orders/{created.json()['id']}/cancel",
            headers=headers,
            json=cancel_payload,
        )
        assert cancelled.status_code == 200, cancelled.text
        with harness.connection() as connection:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?, archive_reason = ?
                WHERE project_code_key = ?
                """,
                (
                    NOW.isoformat(),
                    "测试归档",
                    project_code_identity(harness.project_code),
                ),
            )
        replay = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}/cancel",
            headers=headers,
            json=cancel_payload,
        )
        reused = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}/cancel",
            headers=headers,
            json={**cancel_payload, "reason": "另一原因"},
        )
    assert replay.status_code == 200
    assert replay.json() == cancelled.json()
    assert replay.json()["status"] == "cancelled"
    assert reused.status_code == 409
    assert reused.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
    with harness.client() as restarted_client:
        reloaded = restarted_client.get(
            f"/api/projects/{harness.project_code}/purchase-orders/{created.json()['id']}"
        )
    assert reloaded.status_code == 200
    assert reloaded.json()["cancel_reason"] == "需求取消"
    assert reloaded.json()["cancelled_at"] == NOW.isoformat()


def test_supplier_payments_and_invoices_are_exact_capped_and_reversible(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order = _create_confirmed_order(client, harness)
        line_id = order["lines"][0]["id"]
        payment_payload = {
            "paid_on": "2026-08-31",
            "amount_cents": 2000,
            "payment_method": "银行转账",
            "reference_no": "PAY-001",
            "allocations": [{"purchase_order_line_id": line_id, "amount_cents": 2000}],
            "notes": None,
        }
        payment_headers = {"Idempotency-Key": "50000000-0000-4000-8000-000000000001"}
        payment = client.post(
            f"/api/projects/{harness.project_code.lower()}/purchase-orders/{order['id']}/supplier-payments",
            headers=payment_headers,
            json=payment_payload,
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-payments",
            headers=payment_headers,
            json=payment_payload,
        )
        assert payment.status_code == replay.status_code == 201
        assert replay.json() == payment.json()
        assert payment.json()["allocations"] == payment_payload["allocations"]

        bad_sum = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-payments",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000002"},
            json={**payment_payload, "amount_cents": 1999},
        )
        assert bad_sum.status_code == 422
        over = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-payments",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000003"},
            json={**payment_payload, "amount_cents": 3001, "allocations": [{"purchase_order_line_id": line_id, "amount_cents": 3001}]},
        )
        assert over.status_code == 409
        assert over.json()["error_code"] == "PAYMENT_AMOUNT_EXCEEDED"
        wrong_order_line = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-payments",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000010"},
            json={
                **payment_payload,
                "amount_cents": 1,
                "allocations": [
                    {
                        "purchase_order_line_id": line_id + 999,
                        "amount_cents": 1,
                    }
                ],
            },
        )
        assert wrong_order_line.status_code == 422
        cancel_with_facts = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/cancel",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000011"},
            json={"reason": "已有付款", "expected_revision": order["revision"]},
        )
        assert cancel_with_facts.status_code == 409
        assert cancel_with_facts.json()["error_code"] == "PURCHASE_ORDER_HAS_ACTIVE_FACTS"

        reverse_headers = {"Idempotency-Key": "50000000-0000-4000-8000-000000000004"}
        reverse_payload = {"reason": "重复付款", "expected_revision": payment.json()["revision"]}
        reversed_payment = client.post(
            f"/api/projects/{harness.project_code.lower()}/supplier-payments/{payment.json()['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        reverse_replay = client.post(
            f"/api/projects/{harness.project_code}/supplier-payments/{payment.json()['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        assert reversed_payment.status_code == reverse_replay.status_code == 200
        assert reverse_replay.json() == reversed_payment.json()
        assert reversed_payment.json()["reversal_reason"] == "重复付款"
        assert reversed_payment.json()["reversed_at"] == NOW.isoformat()
        duplicate_reverse = client.post(
            f"/api/projects/{harness.project_code}/supplier-payments/{payment.json()['id']}/reverse",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000005"},
            json={"reason": "再次冲销", "expected_revision": reversed_payment.json()["revision"]},
        )
        assert duplicate_reverse.status_code == 409
        assert duplicate_reverse.json()["error_code"] == "SUPPLIER_PAYMENT_ALREADY_REVERSED"

        invoice_payload = {
            "invoice_no": "INV-001",
            "invoiced_on": "2026-08-31",
            "amount_cents": 5000,
            "allocations": [{"purchase_order_line_id": line_id, "amount_cents": 5000}],
            "document_version_ids": [harness.document_version_id],
        }
        invoice = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-invoices",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000006"},
            json=invoice_payload,
        )
        assert invoice.status_code == 201, invoice.text
        invoice_replay = client.post(
            f"/api/projects/{harness.project_code.lower()}/purchase-orders/{order['id']}/supplier-invoices",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000006"},
            json=invoice_payload,
        )
        assert invoice_replay.status_code == 201
        assert invoice_replay.json() == invoice.json()
        over_invoice = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-invoices",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000007"},
            json={**invoice_payload, "invoice_no": "INV-002", "amount_cents": 1, "allocations": [{"purchase_order_line_id": line_id, "amount_cents": 1}]},
        )
        assert over_invoice.status_code == 409
        assert over_invoice.json()["error_code"] == "INVOICE_AMOUNT_EXCEEDED"
        reversed_invoice = client.post(
            f"/api/projects/{harness.project_code}/supplier-invoices/{invoice.json()['id']}/reverse",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000008"},
            json={"reason": "发票作废", "expected_revision": invoice.json()["revision"]},
        )
        assert reversed_invoice.status_code == 200
        assert reversed_invoice.json()["status"] == "reversed"
        assert reversed_invoice.json()["document_version_ids"] == [
            harness.document_version_id
        ]
        assert reversed_invoice.json()["reversal_reason"] == "发票作废"
        assert reversed_invoice.json()["reversed_at"] == NOW.isoformat()
        reverse_replay = client.post(
            f"/api/projects/{harness.project_code.lower()}/supplier-invoices/{invoice.json()['id']}/reverse",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000008"},
            json={"reason": "发票作废", "expected_revision": invoice.json()["revision"]},
        )
        assert reverse_replay.status_code == 200
        assert reverse_replay.json() == reversed_invoice.json()
        duplicate_invoice_reverse = client.post(
            f"/api/projects/{harness.project_code}/supplier-invoices/{invoice.json()['id']}/reverse",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000009"},
            json={
                "reason": "再次冲销",
                "expected_revision": reversed_invoice.json()["revision"],
            },
        )
        assert duplicate_invoice_reverse.status_code == 409
        assert (
            duplicate_invoice_reverse.json()["error_code"]
            == "SUPPLIER_INVOICE_ALREADY_REVERSED"
        )


def test_authentication_replay_archive_and_cross_project_ordering(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order = _create_confirmed_order(client, harness)
        line_id = order["lines"][0]["id"]
        endpoint = (
            f"/api/projects/{harness.project_code.lower()}/purchase-orders/"
            f"{order['id']}/supplier-payments"
        )
        headers = {"Idempotency-Key": "52000000-0000-4000-8000-000000000001"}
        payload = {
            "paid_on": "2026-08-31",
            "amount_cents": 1000,
            "payment_method": "银行转账",
            "reference_no": None,
            "allocations": [
                {"purchase_order_line_id": line_id, "amount_cents": 1000}
            ],
            "notes": None,
        }
        with TestClient(harness.app) as anonymous:
            unauthenticated = anonymous.post(
                endpoint,
                headers=headers,
                content=b"{",
            )
        assert unauthenticated.status_code == 401

        created = client.post(endpoint, headers=headers, json=payload)
        assert created.status_code == 201, created.text
        with harness.connection() as connection:
            connection.execute(
                """
                UPDATE projects
                SET status = 'archived', archived_at = ?, archive_reason = ?
                WHERE project_code_key = ?
                """,
                (
                    NOW.isoformat(),
                    "测试归档",
                    project_code_identity(harness.project_code),
                ),
            )

        replay = client.post(
            endpoint.replace(harness.project_code.lower(), harness.project_code),
            headers=headers,
            json=payload,
        )
        assert replay.status_code == 201
        assert replay.json() == created.json()
        key_reuse = client.post(
            endpoint,
            headers=headers,
            json={**payload, "reference_no": "另一个流水号"},
        )
        assert key_reuse.status_code == 409
        assert key_reuse.json()["error_code"] == "IDEMPOTENCY_KEY_REUSED"
        blocked = client.post(
            endpoint,
            headers={"Idempotency-Key": "52000000-0000-4000-8000-000000000002"},
            json=payload,
        )
        assert blocked.status_code == 409
        assert blocked.json()["error_code"] == "PROJECT_ARCHIVED"

        cross_project = client.post(
            f"/api/projects/{harness.other_project_code}/supplier-payments/"
            f"{created.json()['id']}/reverse",
            headers={"Idempotency-Key": "52000000-0000-4000-8000-000000000003"},
            json={"reason": "错误项目", "expected_revision": created.json()["revision"]},
        )
        assert cross_project.status_code == 404


def test_goods_receipt_reverse_atomically_restores_order_and_inventory(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order = _create_confirmed_order(client, harness)
        order_line_id = order["lines"][0]["id"]
        receipt = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/goods-receipts",
            headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000001"},
            json={
                "received_on": "2026-08-31",
                "warehouse_name": "主仓",
                "lines": [{"purchase_order_line_id": order_line_id, "quantity": "2.000"}],
                "notes": None,
            },
        )
        assert receipt.status_code == 201, receipt.text
        reverse_headers = {"Idempotency-Key": "60000000-0000-4000-8000-000000000002"}
        reverse_payload = {"reason": "供应商退货", "expected_revision": receipt.json()["revision"]}
        reversed_receipt = client.post(
            f"/api/projects/{harness.project_code.lower()}/goods-receipts/{receipt.json()['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipt.json()['id']}/reverse",
            headers=reverse_headers,
            json=reverse_payload,
        )
        assert reversed_receipt.status_code == replay.status_code == 200
        assert replay.json() == reversed_receipt.json()
        assert reversed_receipt.json()["reversal_reason"] == "供应商退货"
        assert reversed_receipt.json()["reversed_at"] == NOW.isoformat()
        duplicate = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipt.json()['id']}/reverse",
            headers={"Idempotency-Key": "60000000-0000-4000-8000-000000000003"},
            json={"reason": "重复", "expected_revision": reversed_receipt.json()["revision"]},
        )
        assert duplicate.status_code == 409
        assert duplicate.json()["error_code"] == "GOODS_RECEIPT_ALREADY_REVERSED"

    with harness.connection() as connection:
        item = connection.execute("SELECT * FROM inventory_items").fetchone()
        assert item["quantity_milli"] == 0
        assert item["inventory_value_cents"] == 0
        order_line = connection.execute(
            "SELECT * FROM purchase_order_lines WHERE id = ?", (order_line_id,)
        ).fetchone()
        assert order_line["received_quantity_milli"] == 0
        order_row = connection.execute(
            "SELECT * FROM purchase_orders WHERE id = ?", (order["id"],)
        ).fetchone()
        assert order_row["status"] == "confirmed"
        movements = connection.execute(
            "SELECT * FROM inventory_movements ORDER BY id"
        ).fetchall()
        assert [row["quantity_delta_milli"] for row in movements] == [2000, -2000]
        assert [row["value_delta_cents"] for row in movements] == [2000, -2000]


def test_goods_receipt_reverse_rolls_back_when_inventory_would_be_negative(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order = _create_confirmed_order(client, harness)
        receipt = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/goods-receipts",
            headers={"Idempotency-Key": "61000000-0000-4000-8000-000000000001"},
            json={
                "received_on": "2026-08-31",
                "warehouse_name": "主仓",
                "lines": [{"purchase_order_line_id": order["lines"][0]["id"], "quantity": "2.000"}],
                "notes": None,
            },
        )
        assert receipt.status_code == 201
        with harness.connection() as connection:
            connection.execute(
                "UPDATE inventory_items SET quantity_milli = 1000, inventory_value_cents = 1000"
            )
        reverse = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipt.json()['id']}/reverse",
            headers={"Idempotency-Key": "61000000-0000-4000-8000-000000000002"},
            json={"reason": "供应商退货", "expected_revision": receipt.json()["revision"]},
        )
    assert reverse.status_code == 409
    assert reverse.json()["error_code"] == "RECEIPT_REVERSAL_INSUFFICIENT_INVENTORY"
    with harness.connection() as connection:
        assert connection.execute("SELECT status FROM goods_receipts").fetchone()[0] == "active"
        assert connection.execute("SELECT COUNT(*) FROM inventory_movements").fetchone()[0] == 1


def test_order_and_overview_reload_active_totals_and_persist_reversal_audit(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        order = _create_confirmed_order(client, harness)
        line_id = order["lines"][0]["id"]
        payment = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-payments",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000001"},
            json={
                "paid_on": "2026-08-31",
                "amount_cents": 1000,
                "payment_method": "银行转账",
                "reference_no": "PAY-AUDIT",
                "allocations": [
                    {"purchase_order_line_id": line_id, "amount_cents": 1000}
                ],
                "notes": None,
            },
        )
        assert payment.status_code == 201, payment.text
        invoice = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/supplier-invoices",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000002"},
            json={
                "invoice_no": "INV-AUDIT",
                "invoiced_on": "2026-08-31",
                "amount_cents": 1500,
                "allocations": [
                    {"purchase_order_line_id": line_id, "amount_cents": 1500}
                ],
                "document_version_ids": [harness.document_version_id],
            },
        )
        assert invoice.status_code == 201, invoice.text
        receipt = client.post(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}/goods-receipts",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000003"},
            json={
                "received_on": "2026-08-31",
                "warehouse_name": "主仓",
                "lines": [
                    {"purchase_order_line_id": line_id, "quantity": "2.000"}
                ],
                "notes": None,
            },
        )
        assert receipt.status_code == 201, receipt.text

        active_detail = client.get(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}"
        )
        assert active_detail.status_code == 200
        assert active_detail.json()["paid_amount_cents"] == 1000
        assert active_detail.json()["invoiced_amount_cents"] == 1500
        assert active_detail.json()["received_amount_cents"] == 2000
        assert active_detail.json()["supplier_payments"] == [payment.json()]
        assert active_detail.json()["supplier_invoices"] == [invoice.json()]
        assert active_detail.json()["goods_receipts"] == [receipt.json()]
        active_overview = client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        )
        assert active_overview.json()["procurement_paid_cents"] == 1000
        assert active_overview.json()["procurement_invoiced_cents"] == 1500
        assert active_overview.json()["procurement_received_cents"] == 2000

        reversed_payment = client.post(
            f"/api/projects/{harness.project_code}/supplier-payments/{payment.json()['id']}/reverse",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000004"},
            json={
                "reason": "付款退回",
                "expected_revision": payment.json()["revision"],
            },
        )
        reversed_invoice = client.post(
            f"/api/projects/{harness.project_code}/supplier-invoices/{invoice.json()['id']}/reverse",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000005"},
            json={
                "reason": "发票作废",
                "expected_revision": invoice.json()["revision"],
            },
        )
        reversed_receipt = client.post(
            f"/api/projects/{harness.project_code}/goods-receipts/{receipt.json()['id']}/reverse",
            headers={"Idempotency-Key": "80000000-0000-4000-8000-000000000006"},
            json={
                "reason": "到货退回",
                "expected_revision": receipt.json()["revision"],
            },
        )
        assert reversed_payment.status_code == 200
        assert reversed_invoice.status_code == 200
        assert reversed_receipt.status_code == 200

    with harness.client() as restarted_client:
        reloaded_detail = restarted_client.get(
            f"/api/projects/{harness.project_code}/purchase-orders/{order['id']}"
        )
        reloaded_overview = restarted_client.get(
            f"/api/projects/{harness.project_code}/procurement-overview"
        )
    assert reloaded_detail.status_code == 200
    assert reloaded_detail.json()["paid_amount_cents"] == 0
    assert reloaded_detail.json()["invoiced_amount_cents"] == 0
    assert reloaded_detail.json()["received_amount_cents"] == 0
    assert reloaded_detail.json()["supplier_payments"] == [reversed_payment.json()]
    assert reloaded_detail.json()["supplier_invoices"] == [reversed_invoice.json()]
    assert reloaded_detail.json()["goods_receipts"] == [reversed_receipt.json()]
    assert reloaded_overview.json()["procurement_paid_cents"] == 0
    assert reloaded_overview.json()["procurement_invoiced_cents"] == 0
    assert reloaded_overview.json()["procurement_received_cents"] == 0
    with harness.connection() as connection:
        assert connection.execute(
            """
            SELECT document_version_id FROM supplier_invoice_documents
            WHERE supplier_invoice_id = ?
            """,
            (invoice.json()["id"],),
        ).fetchone()[0] == harness.document_version_id
        assert dict(
            connection.execute(
                "SELECT reversal_reason, reversed_at FROM supplier_payments"
            ).fetchone()
        ) == {"reversal_reason": "付款退回", "reversed_at": NOW.isoformat()}
        assert dict(
            connection.execute(
                "SELECT reversal_reason, reversed_at FROM supplier_invoices"
            ).fetchone()
        ) == {"reversal_reason": "发票作废", "reversed_at": NOW.isoformat()}
        assert dict(
            connection.execute(
                "SELECT reversal_reason, reversed_at FROM goods_receipts"
            ).fetchone()
        ) == {"reversal_reason": "到货退回", "reversed_at": NOW.isoformat()}


def test_quote_export_uses_customer_only_dto_without_cost_or_hidden_content(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        procurement_list = _create_confirmed_list(client, harness.project_code)
        headers = {"Idempotency-Key": "70000000-0000-4000-8000-000000000001"}
        payload = {
            "title": " 项目报价单 ",
            "customer_company_id": harness.customer_company_id,
            "notes": "有效期 30 天",
        }
        created = client.post(
            f"/api/projects/{harness.project_code.lower()}/procurement-lists/{procurement_list['id']}/quote-exports",
            headers=headers,
            json=payload,
        )
        replay = client.post(
            f"/api/projects/{harness.project_code}/procurement-lists/{procurement_list['id']}/quote-exports",
            headers=headers,
            json=payload,
        )
        assert created.status_code == replay.status_code == 201
        assert replay.json() == created.json()
        cross_project = client.post(
            f"/api/projects/{harness.other_project_code}/procurement-lists/"
            f"{procurement_list['id']}/quote-exports",
            headers={"Idempotency-Key": "70000000-0000-4000-8000-000000000002"},
            json=payload,
        )
        assert cross_project.status_code == 404
        download = client.get(created.json()["download_url"])
        assert download.status_code == 200

    workbook = load_workbook(BytesIO(download.content), data_only=False)
    assert workbook.sheetnames == ["报价单"]
    worksheet = workbook["报价单"]
    assert worksheet.sheet_state == "visible"
    assert all(dimension.hidden is not True for dimension in worksheet.column_dimensions.values())
    assert worksheet["A1"].value == "标题"
    assert worksheet["B1"].value == "项目报价单"
    assert worksheet["A2"].value == "客户公司"
    assert worksheet["B2"].value == "客户公司"
    assert worksheet["A3"].value == "备注"
    assert worksheet["B3"].value == "有效期 30 天"
    assert [cell.value for cell in worksheet[5]] == [
        "序号",
        "大类",
        "名称",
        "规格",
        "品牌",
        "型号",
        "数量",
        "单位",
        "报价单价（元）",
        "报价金额（元）",
    ]
    assert [cell.value for cell in worksheet[6]] == [
        1,
        "电气",
        "接触器",
        "AC220V",
        "施耐德",
        "LC1D09",
        "5.000",
        "PCS",
        "15.00",
        "75.00",
    ]
    assert all(cell.data_type != "f" for row in worksheet.iter_rows() for cell in row)
    assert all(sheet.sheet_state == "visible" for sheet in workbook.worksheets)
