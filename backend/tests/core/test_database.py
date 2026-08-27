from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.app.core.database import connect_database, transaction


def test_file_connection_applies_required_sqlite_settings(
    tmp_path: Path,
) -> None:
    connection = connect_database(tmp_path / "erp.sqlite3")
    try:
        connection.execute("CREATE TABLE probe (value TEXT NOT NULL)")
        connection.execute("INSERT INTO probe VALUES ('configured')")
        row = connection.execute("SELECT value FROM probe").fetchone()

        assert connection.isolation_level is None
        assert connection.row_factory is sqlite3.Row
        assert isinstance(row, sqlite3.Row)
        assert row["value"] == "configured"
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    finally:
        connection.close()


def test_transaction_commits_successful_changes(tmp_path: Path) -> None:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    try:
        connection.execute("CREATE TABLE entries (value TEXT NOT NULL)")

        with transaction(connection):
            connection.execute("INSERT INTO entries VALUES ('committed')")

        assert not connection.in_transaction
    finally:
        connection.close()

    reopened = connect_database(database_path)
    try:
        assert reopened.execute("SELECT value FROM entries").fetchone()[0] == (
            "committed"
        )
    finally:
        reopened.close()


def test_transaction_rolls_back_and_reraises_original_exception(
    tmp_path: Path,
) -> None:
    connection = connect_database(tmp_path / "erp.sqlite3")
    failure = RuntimeError("write failed")
    try:
        connection.execute("CREATE TABLE entries (value TEXT NOT NULL)")

        with pytest.raises(RuntimeError) as raised, transaction(connection):
            connection.execute("INSERT INTO entries VALUES ('discarded')")
            raise failure

        assert raised.value is failure
        assert not connection.in_transaction
        assert connection.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0
    finally:
        connection.close()


def test_nested_transaction_fails_without_committing_outer_transaction(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "erp.sqlite3"
    connection = connect_database(database_path)
    observer = connect_database(database_path)
    try:
        connection.execute("CREATE TABLE entries (value TEXT NOT NULL)")

        with transaction(connection):
            connection.execute("INSERT INTO entries VALUES ('outer')")

            with pytest.raises(
                RuntimeError,
                match="Nested transactions",
            ), transaction(connection):
                pass

            assert connection.in_transaction
            assert observer.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0

        assert observer.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1
    finally:
        observer.close()
        connection.close()
