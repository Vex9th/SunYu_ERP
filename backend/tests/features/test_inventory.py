from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core.config import Settings
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.features import inventory

PROJECT_ROOT = Path(__file__).resolve().parents[3]
NOW = datetime(2026, 8, 29, 1, 30, tzinfo=timezone.utc)


@dataclass(frozen=True)
class InventoryHarness:
    app: FastAPI
    database_path: Path
    settings: Settings

    @contextmanager
    def client(self) -> Iterator[TestClient]:
        with TestClient(self.app) as client:
            client.cookies.set(
                SESSION_COOKIE_NAME,
                create_session_token(self.settings.session_secret),
            )
            yield client


def test_inventory_router_factory_exists() -> None:
    assert callable(inventory.create_inventory_router)


def _build_harness(tmp_path: Path) -> InventoryHarness:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, PROJECT_ROOT / "backend" / "migrations")
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
        session_secret="inventory-test-session-secret-32-bytes",
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
        inventory.create_inventory_router(
            get_connection,
            get_settings,
            clock=lambda: NOW,
        )
    )
    return InventoryHarness(app, database_path, settings)


def _item_payload() -> dict[str, object]:
    return {
        "brand": "施耐德",
        "name": "接触器",
        "model": "LC1D09",
        "specification": "AC220V",
        "unit": "PCS",
        "opening_quantity": "2.000",
        "opening_unit_cost_cents": 100,
        "notes": None,
    }


def test_manual_item_opening_balance_and_adjustments_use_immutable_movements(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        create_headers = {"Idempotency-Key": "40000000-0000-4000-8000-000000000001"}
        created = client.post(
            "/api/inventory/items",
            headers=create_headers,
            json=_item_payload(),
        )
        replay = client.post(
            "/api/inventory/items",
            headers=create_headers,
            json=_item_payload(),
        )
        assert created.status_code == replay.status_code == 201
        assert created.json()["id"] == replay.json()["id"]
        assert created.json()["quantity"] == "2.000"
        assert created.json()["inventory_value_cents"] == 200

        adjustment_headers = {"Idempotency-Key": "40000000-0000-4000-8000-000000000002"}
        adjusted = client.post(
            "/api/inventory/adjustments",
            headers=adjustment_headers,
            json={
                "item_id": created.json()["id"],
                "quantity_delta": "1.000",
                "unit_cost_cents": 200,
                "reason": "盘盈",
                "occurred_on": "2026-08-29",
            },
        )
        repeated = client.post(
            "/api/inventory/adjustments",
            headers=adjustment_headers,
            json={
                "item_id": created.json()["id"],
                "quantity_delta": "1.000",
                "unit_cost_cents": 200,
                "reason": "盘盈",
                "occurred_on": "2026-08-29",
            },
        )
        assert adjusted.status_code == repeated.status_code == 201
        assert adjusted.json()["id"] == repeated.json()["id"]

        replay_after_adjustment = client.post(
            "/api/inventory/items",
            headers=create_headers,
            json=_item_payload(),
        )
        assert replay_after_adjustment.status_code == 201
        assert replay_after_adjustment.json() == created.json()

        conflicting_replay = client.post(
            "/api/inventory/items",
            headers=create_headers,
            json={**_item_payload(), "notes": "不同请求"},
        )
        assert conflicting_replay.status_code == 409
        assert conflicting_replay.json() == {
            "detail": "Idempotency key reused",
            "error_code": "IDEMPOTENCY_KEY_REUSED",
            "field_errors": {},
            "current_revision": None,
        }

        listing = client.get("/api/inventory/items")
        item = listing.json()["items"][0]
        assert item["quantity"] == "3.000"
        assert item["inventory_value_cents"] == 400
        assert item["average_unit_cost_cents"] == 133

        movements = client.get(f"/api/inventory/items/{created.json()['id']}/movements")
        assert [entry["movement_type"] for entry in movements.json()["items"]] == [
            "adjustment",
            "opening",
        ]

    connection = connect_database(harness.database_path)
    try:
        movement_id = connection.execute(
            "SELECT id FROM inventory_movements ORDER BY id LIMIT 1"
        ).fetchone()[0]
        for statement in (
            "UPDATE inventory_movements SET reason = 'tampered' WHERE id = ?",
            "DELETE FROM inventory_movements WHERE id = ?",
        ):
            try:
                connection.execute(statement, (movement_id,))
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError("inventory movement was mutable")
    finally:
        connection.close()


def test_adjustment_cannot_make_inventory_negative_and_rolls_back(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        created = client.post(
            "/api/inventory/items",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000001"},
            json=_item_payload(),
        )
        failed = client.post(
            "/api/inventory/adjustments",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000002"},
            json={
                "item_id": created.json()["id"],
                "quantity_delta": "-3.000",
                "unit_cost_cents": None,
                "reason": "盘亏",
                "occurred_on": "2026-08-29",
            },
        )
        assert failed.status_code == 409
        assert failed.json()["detail"] == "Insufficient inventory"
        detail = client.get(f"/api/inventory/items/{created.json()['id']}")
        assert detail.json()["quantity"] == "2.000"
        assert len(detail.json()["movements"]) == 1


def test_opening_balance_rejects_value_outside_sqlite_integer_range(
    tmp_path: Path,
) -> None:
    harness = _build_harness(tmp_path)
    with harness.client() as client:
        response = client.post(
            "/api/inventory/items",
            headers={"Idempotency-Key": "50000000-0000-4000-8000-000000000003"},
            json={
                **_item_payload(),
                "opening_quantity": "999999999.999",
                "opening_unit_cost_cents": 9_000_000_000_000,
            },
        )

        assert response.status_code == 422
        assert response.json() == {
            "detail": "Invalid inventory payload",
            "error_code": "VALIDATION_ERROR",
            "field_errors": {},
            "current_revision": None,
        }
        assert client.get("/api/inventory/items").json()["total"] == 0
