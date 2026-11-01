import sqlite3
from pathlib import Path

import pytest

from backend.app.core.access import Principal
from backend.app.core.database import connect_database, transaction
from backend.app.core.migrations import apply_migrations
from backend.app.features.operation_history import (
    append_operation_event,
    bind_operation_context,
)


@pytest.fixture
def connection(tmp_path):
    db = connect_database(tmp_path / "fixture.sqlite")
    apply_migrations(db, Path(__file__).resolve().parents[2] / "migrations")
    yield db
    db.close()


@pytest.fixture
def actor():
    return Principal(
        1, "buyer", "采购张姐", True, None, None, frozenset(), frozenset(), 1
    )


def test_history_rolls_back_with_business(connection, actor):
    with pytest.raises(RuntimeError), transaction(connection):
        append_operation_event(
            connection,
            principal=actor,
            request_id="fixture",
            action="companies.create",
            resource_type="company",
            resource_id=1,
            project_ids=(),
            summary="新建公司",
            reason=None,
            changes={},
            occurred_at="2026-11-01T01:00:00Z",
        )
        raise RuntimeError("rollback")
    assert (
        connection.execute("SELECT COUNT(*) FROM operation_events").fetchone()[0] == 0
    )


def test_history_is_immutable_and_deduplicated(connection, actor):
    with transaction(connection):
        for _ in range(2):
            append_operation_event(
                connection,
                principal=actor,
                request_id="fixture",
                action="companies.create",
                resource_type="company",
                resource_id=1,
                project_ids=(),
                summary="新建公司",
                reason=None,
                changes={},
                occurred_at="2026-11-01T01:00:00Z",
            )
    assert (
        connection.execute("SELECT COUNT(*) FROM operation_events").fetchone()[0] == 1
    )
    assert (
        connection.execute("SELECT actor_name FROM operation_events").fetchone()[0]
        == "采购张姐"
    )
    for statement in (
        'UPDATE operation_events SET actor_name="其他人"',
        "DELETE FROM operation_events",
    ):
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(statement)


def test_history_rejects_passwords(connection, actor):
    with transaction(connection), pytest.raises(ValueError):
        append_operation_event(
            connection,
            principal=actor,
            request_id="fixture",
            action="accounts.create",
            resource_type="account",
            resource_id=1,
            project_ids=(),
            summary="新建账号",
            reason=None,
            changes={"password": "secret"},
            occurred_at="2026-11-01T01:00:00Z",
        )


def test_connection_audit_tracks_real_write_in_same_transaction(connection, actor):
    bind_operation_context(
        connection,
        principal=actor,
        request_id="fixture",
        action="companies.create",
        project_ids=(),
        reason=None,
    )
    with transaction(connection):
        connection.execute(
            "INSERT INTO companies(name,created_at,updated_at) VALUES('合成供应商','2026-11-01','2026-11-01')"
        )
    event = connection.execute("SELECT * FROM operation_events").fetchone()
    assert event["actor_name"] == "采购张姐" and event["resource_type"] == "company"
    assert event["action"] == "companies.create"
    with pytest.raises(RuntimeError), transaction(connection):
        connection.execute(
            "INSERT INTO companies(name,created_at,updated_at) VALUES('回滚公司','2026-11-01','2026-11-01')"
        )
        raise RuntimeError("rollback")
    assert (
        connection.execute("SELECT COUNT(*) FROM operation_events").fetchone()[0] == 1
    )


def test_history_merges_intermediate_sql_changes_and_failure_is_atomic(
    connection, actor
):
    connection.execute(
        "INSERT INTO companies(id,name,created_at,updated_at) VALUES(1,'原名称','2026-11-01','2026-11-01')"
    )
    bind_operation_context(
        connection,
        principal=actor,
        request_id="multi",
        action="companies.edit",
        project_ids=(),
        reason=None,
    )
    with transaction(connection):
        connection.execute("UPDATE companies SET name='中间名称' WHERE id=1")
        connection.execute("UPDATE companies SET name='最终名称' WHERE id=1")
    import json

    rows = connection.execute("SELECT * FROM operation_events").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0]["changes_json"])["name"] == {
        "before": "原名称",
        "after": "最终名称",
    }
    connection.execute(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON operation_events BEGIN SELECT RAISE(ABORT,'injected audit failure'); END"
    )
    bind_operation_context(
        connection,
        principal=actor,
        request_id="fail",
        action="companies.edit",
        project_ids=(),
        reason=None,
    )
    with pytest.raises(sqlite3.IntegrityError), transaction(connection):
        connection.execute("UPDATE companies SET name='不能保存' WHERE id=1")
    assert (
        connection.execute("SELECT name FROM companies WHERE id=1").fetchone()[0]
        == "最终名称"
    )


def test_shared_inventory_balance_and_price_permissions_are_independent():
    from backend.app.features.access_policy import redact_fields

    price_only = Principal(
        2,
        "buyer",
        "采购",
        False,
        1,
        "采购组",
        frozenset({"inventory.view", "sensitive.procurement_prices"}),
        frozenset({1}),
        1,
    )
    balance_only = Principal(
        3,
        "warehouse",
        "仓管",
        False,
        2,
        "仓库组",
        frozenset({"inventory.view", "inventory.shared.view"}),
        frozenset({1}),
        1,
    )
    changes = {
        "quantity_after_milli": {"before": 4000, "after": 5000},
        "value_after_cents": {"before": 400, "after": 500},
        "quantity_delta_milli": {"before": None, "after": 1000},
    }
    private = redact_fields(changes, price_only, "inventory.view", "inventory_movement")
    assert (
        private["quantity_after_milli"] is None and private["value_after_cents"] is None
    )
    assert private["quantity_delta_milli"]["after"] == 1000
    visible = redact_fields(
        changes, balance_only, "inventory.view", "inventory_movement"
    )
    assert visible["quantity_after_milli"]["after"] == 5000
    assert visible["value_after_cents"] is None


def test_backup_phase_records_captured_user_or_explicit_system_actor(connection, actor):
    from backend.app.features.operation_history import SystemActor, bind_backup_actor

    bind_backup_actor(connection, actor, "manual-backup")
    connection.execute(
        "INSERT INTO backup_runs(id,started_at,status,target_path) VALUES(1,'2026-11-01','running','private-path')"
    )
    connection.execute(
        "UPDATE backup_runs SET status='success',finished_at='2026-11-01' WHERE id=1"
    )
    bind_backup_actor(connection, SystemActor(), "automatic-backup")
    connection.execute(
        "INSERT INTO backup_runs(id,started_at,status,target_path) VALUES(2,'2026-11-01','running','private-path')"
    )
    rows = connection.execute(
        "SELECT actor_name,actor_kind,summary,changes_json FROM operation_events ORDER BY id"
    ).fetchall()
    assert [(r["actor_name"], r["actor_kind"]) for r in rows] == [
        ("采购张姐", "user"),
        ("采购张姐", "user"),
        ("系统自动", "system"),
    ]
    assert rows[1]["summary"] == "备份完成"
    assert all("private-path" not in r["changes_json"] for r in rows)
