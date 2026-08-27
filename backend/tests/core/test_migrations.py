from __future__ import annotations

import sqlite3
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from importlib import import_module
from pathlib import Path
from threading import Barrier
from typing import cast

import pytest

from backend.app.core.database import connect_database

ApplyMigrations = Callable[[sqlite3.Connection, Path], list[str]]


def _apply_migrations() -> ApplyMigrations:
    module = import_module("backend.app.core.migrations")
    return module.apply_migrations


def _migration_error() -> type[Exception]:
    module = import_module("backend.app.core.migrations")
    return module.MigrationError


def _write_migration(directory: Path, name: str, sql: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    migration_path = directory / name
    migration_path.write_text(sql, encoding="utf-8")
    return migration_path


def _ledger_sql() -> str:
    return """
        CREATE TABLE schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    """


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def test_applies_migrations_in_filename_order_and_records_utc_time(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "002_second.sql",
        "INSERT INTO migration_order VALUES ('second');",
    )
    _write_migration(
        migrations_dir,
        "001_first.sql",
        _ledger_sql()
        + """
            -- A semicolon inside a string is not a statement boundary.
            CREATE TABLE migration_order (step TEXT NOT NULL);
            INSERT INTO migration_order VALUES ('first;step');
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        applied = _apply_migrations()(connection, migrations_dir)

        assert applied == ["001_first", "002_second"]
        assert [
            row["step"]
            for row in connection.execute(
                "SELECT step FROM migration_order ORDER BY rowid"
            )
        ] == ["first;step", "second"]
        ledger_rows = connection.execute(
            "SELECT version, applied_at FROM schema_migrations ORDER BY version"
        ).fetchall()
        assert [row["version"] for row in ledger_rows] == [
            "001_first",
            "002_second",
        ]
        for row in ledger_rows:
            applied_at = datetime.fromisoformat(row["applied_at"])
            assert applied_at.utcoffset() == timezone.utc.utcoffset(applied_at)
    finally:
        connection.close()


def test_repeated_run_skips_versions_already_in_ledger(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_counter.sql",
        _ledger_sql()
        + """
            CREATE TABLE counters (value INTEGER NOT NULL);
            INSERT INTO counters VALUES (1);
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert _apply_migrations()(connection, migrations_dir) == ["001_counter"]
        assert _apply_migrations()(connection, migrations_dir) == []
        assert connection.execute("SELECT COUNT(*) FROM counters").fetchone()[0] == 1
    finally:
        connection.close()


def test_failed_migration_rolls_back_its_whole_script_and_version(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_base.sql",
        _ledger_sql() + "CREATE TABLE retained (value TEXT NOT NULL);",
    )
    _write_migration(
        migrations_dir,
        "002_broken.sql",
        """
            CREATE TABLE must_rollback (value TEXT NOT NULL);
            INSERT INTO must_rollback VALUES ('partial');
            INSERT INTO table_that_does_not_exist VALUES ('failure');
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="002_broken"):
            _apply_migrations()(connection, migrations_dir)

        assert not connection.in_transaction
        assert _table_exists(connection, "retained")
        assert not _table_exists(connection, "must_rollback")
        assert [
            row["version"]
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )
        ] == ["001_base"]
    finally:
        connection.close()


def test_foundation_migration_creates_required_tables_and_constraints(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[3]
    migrations_dir = project_root / "backend" / "migrations"
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert _apply_migrations()(connection, migrations_dir) == ["001_foundation"]
        assert {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        } >= {
            "schema_migrations",
            "system_settings",
            "auth_secret",
            "backup_runs",
        }

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO auth_secret VALUES (2, 'hash', '2026-01-01T00:00:00Z')"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO backup_runs
                    (started_at, status, target_path)
                VALUES ('2026-01-01T00:00:00Z', 'unknown', '/backup')
                """
            )
    finally:
        connection.close()


def test_existing_ledger_version_is_not_executed_again(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_existing.sql",
        _ledger_sql() + "CREATE TABLE should_not_exist (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        connection.execute(_ledger_sql())
        connection.execute(
            "INSERT INTO schema_migrations VALUES (?, ?)",
            ("001_existing", "2026-01-01T00:00:00+00:00"),
        )

        assert _apply_migrations()(connection, migrations_dir) == []
        assert not _table_exists(connection, "should_not_exist")
    finally:
        connection.close()


@pytest.mark.parametrize("kind", ["missing", "file"])
def test_requires_existing_migration_directory(tmp_path: Path, kind: str) -> None:
    migrations_dir = tmp_path / "migrations"
    if kind == "file":
        migrations_dir.write_text("not a directory", encoding="utf-8")
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="migration directory"):
            _apply_migrations()(connection, migrations_dir)
    finally:
        connection.close()


def test_requires_at_least_one_sql_migration(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    (migrations_dir / "README.txt").write_text("no migrations", encoding="utf-8")
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="no SQL migrations"):
            _apply_migrations()(connection, migrations_dir)
    finally:
        connection.close()


def test_incomplete_sql_is_rejected_without_partial_schema(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_incomplete.sql",
        _ledger_sql()
        + """
            CREATE TABLE must_rollback (value TEXT NOT NULL);
            CREATE TABLE unfinished (
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="incomplete SQL"):
            _apply_migrations()(connection, migrations_dir)

        assert not _table_exists(connection, "schema_migrations")
        assert not _table_exists(connection, "must_rollback")
    finally:
        connection.close()


def test_ledger_version_missing_from_directory_is_reported_as_drift(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "001_current.sql", _ledger_sql())
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        connection.execute(_ledger_sql())
        connection.execute(
            "INSERT INTO schema_migrations VALUES (?, ?)",
            ("000_removed", "2026-01-01T00:00:00+00:00"),
        )

        with pytest.raises(_migration_error(), match="migration drift.*000_removed"):
            _apply_migrations()(connection, migrations_dir)
    finally:
        connection.close()


def test_applied_versions_must_be_a_continuous_filename_prefix(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_added_later.sql",
        "CREATE TABLE must_not_exist (value TEXT);",
    )
    _write_migration(migrations_dir, "002_existing.sql", "SELECT 1;")
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        connection.execute(_ledger_sql())
        connection.execute(
            "INSERT INTO schema_migrations VALUES (?, ?)",
            ("002_existing", "2026-01-01T00:00:00+00:00"),
        )

        with pytest.raises(_migration_error(), match="migration drift"):
            _apply_migrations()(connection, migrations_dir)

        assert not _table_exists(connection, "must_not_exist")
        assert [
            row["version"]
            for row in connection.execute("SELECT version FROM schema_migrations")
        ] == ["002_existing"]
    finally:
        connection.close()


def test_migration_must_create_ledger_before_version_is_recorded(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_without_ledger.sql",
        "CREATE TABLE incomplete_foundation (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="schema_migrations"):
            _apply_migrations()(connection, migrations_dir)

        assert not _table_exists(connection, "incomplete_foundation")
    finally:
        connection.close()


def test_rejects_case_insensitive_duplicate_versions_when_supported(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    lower = _write_migration(migrations_dir, "001_base.sql", _ledger_sql())
    upper = _write_migration(migrations_dir, "001_BASE.SQL", _ledger_sql())
    if lower.samefile(upper):
        pytest.skip("filesystem is case-insensitive")
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="duplicate migration version"):
            _apply_migrations()(connection, migrations_dir)
    finally:
        connection.close()


def test_rejects_running_inside_an_existing_transaction(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "001_base.sql", _ledger_sql())
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        connection.execute("BEGIN")
        with pytest.raises(_migration_error(), match="active transaction"):
            _apply_migrations()(connection, migrations_dir)
    finally:
        connection.rollback()
        connection.close()


@pytest.mark.parametrize(
    "transaction_sql",
    ["BEGIN;", "COMMIT;", "END;", "ROLLBACK;", "SAVEPOINT nested;", "RELEASE nested;"],
)
def test_rejects_transaction_control_before_executing_migration(
    tmp_path: Path,
    transaction_sql: str,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_unsafe.sql",
        _ledger_sql()
        + transaction_sql
        + "CREATE TABLE must_not_exist (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="transaction control"):
            _apply_migrations()(connection, migrations_dir)

        assert not connection.in_transaction
        assert not _table_exists(connection, "schema_migrations")
        assert not _table_exists(connection, "must_not_exist")
    finally:
        connection.close()


@pytest.mark.parametrize("transaction_sql", ["BEGIN;", "COMMIT;", "ROLLBACK;"])
def test_rejects_bom_prefixed_transaction_control_before_any_statement(
    tmp_path: Path,
    transaction_sql: str,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_unsafe.sql",
        _ledger_sql()
        + """
            CREATE TABLE leaked (value TEXT NOT NULL);
            INSERT INTO leaked VALUES ('must not persist');
        """
        + "\ufeff"
        + transaction_sql
        + """
            INSERT INTO table_that_does_not_exist VALUES ('failure');
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="transaction control"):
            _apply_migrations()(connection, migrations_dir)

        assert not connection.in_transaction
        assert not _table_exists(connection, "schema_migrations")
        assert not _table_exists(connection, "leaked")
    finally:
        connection.close()


def test_allows_trigger_body_transaction_keywords(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_trigger.sql",
        _ledger_sql()
        + """
            CREATE TABLE source_events (value TEXT NOT NULL);
            CREATE TABLE audit_events (value TEXT NOT NULL);
            CREATE TRIGGER record_source_event
            AFTER INSERT ON source_events
            BEGIN
                INSERT INTO audit_events VALUES (NEW.value);
            END;
            INSERT INTO source_events VALUES ('recorded');
        """,
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert _apply_migrations()(connection, migrations_dir) == ["001_trigger"]
        assert connection.execute("SELECT value FROM audit_events").fetchone()[0] == (
            "recorded"
        )
    finally:
        connection.close()


def test_allows_single_bom_at_start_of_script(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_bom.sql",
        "\ufeff" + _ledger_sql() + "CREATE TABLE bom_supported (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        assert _apply_migrations()(connection, migrations_dir) == ["001_bom"]
        assert _table_exists(connection, "bom_supported")
    finally:
        connection.close()


def test_rejects_bom_outside_start_before_executing_migration(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_invalid_bom.sql",
        _ledger_sql() + "\ufeffCREATE TABLE must_not_exist (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        with pytest.raises(_migration_error(), match="BOM.*start"):
            _apply_migrations()(connection, migrations_dir)

        assert not _table_exists(connection, "schema_migrations")
        assert not _table_exists(connection, "must_not_exist")
    finally:
        connection.close()


def test_concurrent_runners_apply_each_version_only_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_once.sql",
        _ledger_sql()
        + """
            CREATE TABLE execution_log (value TEXT NOT NULL);
            INSERT INTO execution_log VALUES ('once');
        """,
    )
    database_path = tmp_path / "erp.sqlite3"
    initialized = connect_database(database_path)
    initialized.close()

    module = import_module("backend.app.core.migrations")
    original_read = module._read_applied_versions
    initial_reads = Barrier(2)

    def synchronize_initial_reads(connection: sqlite3.Connection) -> set[str]:
        versions = original_read(connection)
        if not connection.in_transaction:
            initial_reads.wait(timeout=5)
        return versions

    monkeypatch.setattr(module, "_read_applied_versions", synchronize_initial_reads)

    def run_migrations() -> list[str]:
        connection = connect_database(database_path)
        try:
            return module.apply_migrations(connection, migrations_dir)
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run_migrations) for _ in range(2)]
        results = [future.result(timeout=10) for future in futures]

    assert sorted(results) == [[], ["001_once"]]
    observer = connect_database(database_path)
    try:
        assert observer.execute("SELECT COUNT(*) FROM execution_log").fetchone()[0] == 1
        assert observer.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == 1
    finally:
        observer.close()


def test_begin_immediate_lock_error_has_migration_context(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "001_locked.sql", _ledger_sql())
    database_path = tmp_path / "erp.sqlite3"
    holder = connect_database(database_path)
    contender = connect_database(database_path)
    try:
        holder.execute("BEGIN IMMEDIATE")
        contender.execute("PRAGMA busy_timeout=0")

        with pytest.raises(
            _migration_error(),
            match="001_locked.*BEGIN IMMEDIATE",
        ) as raised:
            _apply_migrations()(contender, migrations_dir)

        assert isinstance(raised.value.__cause__, sqlite3.OperationalError)
        assert "locked" in str(raised.value.__cause__)
        assert not contender.in_transaction
    finally:
        holder.rollback()
        contender.close()
        holder.close()


class _RollbackFailingConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    @property
    def in_transaction(self) -> bool:
        return self.connection.in_transaction

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        return self.connection.execute(sql, parameters)

    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        raise RuntimeError("injected rollback failure")


class _InterruptingConnection:
    def __init__(
        self,
        connection: sqlite3.Connection,
        interrupt_after: str,
        *,
        fail_rollback: bool = False,
    ) -> None:
        self.connection = connection
        self.interrupt_after = interrupt_after
        self.fail_rollback = fail_rollback
        self.failure = KeyboardInterrupt(f"interrupted after {interrupt_after}")
        self.interrupted = False

    @property
    def in_transaction(self) -> bool:
        return self.connection.in_transaction

    def execute(self, sql: str, parameters: object = ()) -> sqlite3.Cursor:
        cursor = self.connection.execute(sql, parameters)
        normalized_sql = sql.lstrip().upper()
        should_interrupt = (
            self.interrupt_after == "begin" and normalized_sql == "BEGIN IMMEDIATE"
        ) or (
            self.interrupt_after == "first_ddl"
            and normalized_sql.startswith("CREATE TABLE SCHEMA_MIGRATIONS")
        )
        if should_interrupt and not self.interrupted:
            self.interrupted = True
            raise self.failure
        return cursor

    def commit(self) -> None:
        self.connection.commit()

    def rollback(self) -> None:
        if self.fail_rollback:
            raise RuntimeError("injected interrupt rollback failure")
        self.connection.rollback()


def test_rollback_failure_preserves_original_migration_cause(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_broken.sql",
        _ledger_sql()
        + "INSERT INTO table_that_does_not_exist VALUES ('original failure');",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    proxy = cast(sqlite3.Connection, _RollbackFailingConnection(connection))
    try:
        with pytest.raises(_migration_error()) as raised:
            _apply_migrations()(proxy, migrations_dir)

        assert "001_broken" in str(raised.value)
        assert "table_that_does_not_exist" in str(raised.value)
        assert "rollback" in str(raised.value)
        assert "injected rollback failure" in str(raised.value)
        assert isinstance(raised.value.__cause__, sqlite3.OperationalError)
        assert "table_that_does_not_exist" in str(raised.value.__cause__)
    finally:
        connection.rollback()
        connection.close()


def test_keyboard_interrupt_after_begin_rolls_back_and_keeps_original_type(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "001_interrupted.sql", _ledger_sql())
    connection = connect_database(tmp_path / "erp.sqlite3")
    adapter = _InterruptingConnection(connection, "begin")
    proxy = cast(sqlite3.Connection, adapter)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            _apply_migrations()(proxy, migrations_dir)

        assert raised.value is adapter.failure
        assert not connection.in_transaction
        assert not _table_exists(connection, "schema_migrations")
    finally:
        connection.rollback()
        connection.close()


def test_keyboard_interrupt_after_first_ddl_rolls_back_schema(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(
        migrations_dir,
        "001_interrupted.sql",
        _ledger_sql() + "CREATE TABLE must_not_exist (value TEXT);",
    )
    connection = connect_database(tmp_path / "erp.sqlite3")
    adapter = _InterruptingConnection(connection, "first_ddl")
    proxy = cast(sqlite3.Connection, adapter)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            _apply_migrations()(proxy, migrations_dir)

        assert raised.value is adapter.failure
        assert not connection.in_transaction
        assert not _table_exists(connection, "schema_migrations")
        assert not _table_exists(connection, "must_not_exist")
    finally:
        connection.rollback()
        connection.close()


def test_keyboard_interrupt_keeps_type_when_rollback_also_fails(
    tmp_path: Path,
) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "001_interrupted.sql", _ledger_sql())
    connection = connect_database(tmp_path / "erp.sqlite3")
    adapter = _InterruptingConnection(connection, "begin", fail_rollback=True)
    proxy = cast(sqlite3.Connection, adapter)
    try:
        with pytest.raises(KeyboardInterrupt) as raised:
            _apply_migrations()(proxy, migrations_dir)

        assert raised.value is adapter.failure
        assert any(
            "rollback failed: injected interrupt rollback failure" in note
            for note in raised.value.__notes__
        )
    finally:
        connection.rollback()
        connection.close()
