from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Barrier, Event, Lock
from typing import Any

import pytest
from argon2.exceptions import InvalidHashError
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.core import security
from backend.app.core.database import connect_database
from backend.app.core.migrations import apply_migrations
from backend.app.features import auth


@dataclass
class MutableClock:
    value: float = 1_800_000_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


@dataclass
class AuthHarness:
    app: FastAPI
    database_path: Path
    session_secret: str
    clock: MutableClock

    def client(self, host: str = "testclient") -> TestClient:
        return TestClient(self.app, client=(host, 50000))


def _migrations_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "migrations"


def _initialize_database(database_path: Path) -> None:
    connection = connect_database(database_path)
    try:
        apply_migrations(connection, _migrations_dir())
    finally:
        connection.close()


def _build_harness(
    tmp_path: Path,
    *,
    dependency_barrier: Barrier | None = None,
) -> AuthHarness:
    database_path = tmp_path / "erp.sqlite3"
    _initialize_database(database_path)
    session_secret = "test-session-secret-with-at-least-32-bytes"
    clock = MutableClock()
    limiter = auth.FailedLoginLimiter(clock=clock)
    barrier_lock = Lock()
    barrier_uses = 0

    def get_connection() -> Iterator[sqlite3.Connection]:
        nonlocal barrier_uses
        connection = connect_database(database_path)
        try:
            should_wait = False
            if dependency_barrier is not None:
                with barrier_lock:
                    if barrier_uses < dependency_barrier.parties:
                        barrier_uses += 1
                        should_wait = True
            if should_wait:
                dependency_barrier.wait(timeout=10)
            yield connection
        finally:
            connection.close()

    def get_session_secret() -> str:
        return session_secret

    app = FastAPI()
    app.include_router(
        auth.create_auth_router(
            get_connection,
            get_session_secret,
            limiter=limiter,
        )
    )
    return AuthHarness(app, database_path, session_secret, clock)


@pytest.fixture
def harness(tmp_path: Path) -> AuthHarness:
    return _build_harness(tmp_path)


def _seed_password(database_path: Path, password: str = "123456") -> str:
    password_hash = security.hash_password(password)
    connection = connect_database(database_path)
    try:
        connection.execute(
            """
            INSERT INTO auth_secret (singleton_id, password_hash, updated_at)
            VALUES (1, ?, '2026-08-28T00:00:00+00:00')
            """,
            (password_hash,),
        )
    finally:
        connection.close()
    return password_hash


@pytest.mark.parametrize(
    "password",
    [
        "",
        "12345",
        "1234567",
        "12345a",
        " 123456",
        "123456 ",
        "１２３４５６",
        "١٢٣٤٥٦",
        123456,
        True,
        None,
        ["123456"],
        {"password": "123456"},
    ],
)
def test_security_rejects_every_non_ascii_six_digit_password(password: Any) -> None:
    with pytest.raises((TypeError, ValueError), match="six ASCII digits"):
        security.validate_password(password)


@pytest.mark.parametrize(
    "password",
    [
        "",
        "12345",
        "1234567",
        "12345a",
        " 123456",
        "123456 ",
        "１２３４５６",
        "١٢٣٤٥٦",
        123456,
        True,
        None,
        ["123456"],
        {"nested": "123456"},
    ],
)
def test_setup_returns_422_for_invalid_password_payload(
    harness: AuthHarness,
    password: Any,
) -> None:
    with harness.client() as client:
        response = client.post("/api/auth/setup", json={"password": password})

    assert response.status_code == 422


def test_validation_error_does_not_echo_password(harness: AuthHarness) -> None:
    submitted_password = "12345a"

    with harness.client() as client:
        response = client.post(
            "/api/auth/setup",
            json={"password": submitted_password},
        )

    assert response.status_code == 422
    assert submitted_password not in response.text


def test_password_hash_is_not_plaintext_and_verifies() -> None:
    password_hash = security.hash_password("123456")

    assert password_hash != "123456"
    assert "123456" not in password_hash
    assert password_hash.startswith("$argon2")
    assert security.verify_password(password_hash, "123456") is True
    assert security.verify_password(password_hash, "654321") is False


def test_setup_stores_hash_once_and_returns_204(harness: AuthHarness) -> None:
    with harness.client() as client:
        first = client.post("/api/auth/setup", json={"password": "123456"})
        second = client.post("/api/auth/setup", json={"password": "654321"})

    assert first.status_code == 204
    assert first.content == b""
    assert second.status_code == 409
    connection = connect_database(harness.database_path)
    try:
        row = connection.execute(
            "SELECT singleton_id, password_hash, updated_at FROM auth_secret"
        ).fetchone()
        assert row["singleton_id"] == 1
        assert row["password_hash"] != "123456"
        assert security.verify_password(row["password_hash"], "123456")
        assert not security.verify_password(row["password_hash"], "654321")
        assert row["updated_at"].endswith("+00:00")
    finally:
        connection.close()


def test_concurrent_setup_allows_only_one_insert(tmp_path: Path) -> None:
    harness = _build_harness(tmp_path, dependency_barrier=Barrier(2))

    def setup(password: str) -> int:
        with harness.client() as client:
            return client.post(
                "/api/auth/setup",
                json={"password": password},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = sorted(executor.map(setup, ["123456", "654321"]))

    assert statuses == [204, 409]
    connection = connect_database(harness.database_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM auth_secret").fetchone()[0] == 1
    finally:
        connection.close()


def test_login_before_setup_returns_409(harness: AuthHarness) -> None:
    with harness.client() as client:
        response = client.post("/api/auth/login", json={"password": "123456"})

    assert response.status_code == 409
    assert "set-cookie" not in response.headers


def test_wrong_password_returns_uniform_401_without_cookie(
    harness: AuthHarness,
) -> None:
    password_hash = _seed_password(harness.database_path)

    with harness.client() as client:
        response = client.post("/api/auth/login", json={"password": "654321"})

    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    response_text = response.text
    assert "654321" not in response_text
    assert password_hash not in response_text


def test_correct_login_sets_hardened_lan_cookie(harness: AuthHarness) -> None:
    password_hash = _seed_password(harness.database_path)

    with harness.client() as client:
        response = client.post("/api/auth/login", json={"password": "123456"})

    assert response.status_code == 204
    assert response.content == b""
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{security.SESSION_COOKIE_NAME}=")
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert "Path=/" in cookie
    assert f"Max-Age={security.SESSION_MAX_AGE_SECONDS}" in cookie
    assert "Secure" not in cookie
    assert "123456" not in cookie
    assert password_hash not in cookie


def test_session_reports_false_without_cookie(harness: AuthHarness) -> None:
    with harness.client() as client:
        response = client.get("/api/auth/session")

    assert response.status_code == 200
    assert response.json() == {
        "authenticated": False,
        "password_configured": False,
    }


def test_session_reports_true_for_valid_login_cookie(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client() as client:
        assert client.post(
            "/api/auth/login",
            json={"password": "123456"},
        ).status_code == 204
        response = client.get("/api/auth/session")

    assert response.status_code == 200
    assert response.json() == {
        "authenticated": True,
        "password_configured": True,
    }


@pytest.mark.parametrize("mutation", ["append", "replace"])
def test_session_rejects_tampered_cookie(
    harness: AuthHarness,
    mutation: str,
) -> None:
    token = security.create_session_token(harness.session_secret)
    if mutation == "append":
        token = f"{token}tampered"
    else:
        token = f"x{token[1:]}"

    with harness.client() as client:
        client.cookies.set(security.SESSION_COOKIE_NAME, token)
        response = client.get("/api/auth/session")

    assert response.json() == {
        "authenticated": False,
        "password_configured": False,
    }


def test_session_rejects_expired_cookie_without_sleep(harness: AuthHarness) -> None:
    token = security.create_session_token(
        harness.session_secret,
        clock=lambda: time.time() - security.SESSION_MAX_AGE_SECONDS - 1,
    )

    with harness.client() as client:
        client.cookies.set(security.SESSION_COOKIE_NAME, token)
        response = client.get("/api/auth/session")

    assert response.json() == {
        "authenticated": False,
        "password_configured": False,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"v": 1},
        {"v": 1, "authenticated": False},
        {"v": 2, "authenticated": True},
        {"v": True, "authenticated": True},
        {"v": 1, "authenticated": 1},
        {"v": 1.0, "authenticated": True},
        {"v": 1, "authenticated": True, "extra": "field"},
        [1, True],
        "authenticated",
    ],
)
def test_session_rejects_signed_but_wrong_payload(
    harness: AuthHarness,
    payload: Any,
) -> None:
    serializer = security.create_session_serializer(harness.session_secret)
    token = serializer.dumps(payload)

    with harness.client() as client:
        client.cookies.set(security.SESSION_COOKIE_NAME, token)
        response = client.get("/api/auth/session")

    assert response.json() == {
        "authenticated": False,
        "password_configured": False,
    }


def test_logout_clears_cookie_and_session(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client() as client:
        client.post("/api/auth/login", json={"password": "123456"})
        response = client.post("/api/auth/logout")
        session = client.get("/api/auth/session")

    assert response.status_code == 204
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{security.SESSION_COOKIE_NAME}=")
    assert "Max-Age=0" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert "Path=/" in cookie
    assert "Secure" not in cookie
    assert session.json() == {
        "authenticated": False,
        "password_configured": True,
    }


def test_sixth_failed_login_is_rate_limited(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client() as client:
        statuses = [
            client.post(
                "/api/auth/login",
                json={"password": "654321"},
            ).status_code
            for _ in range(6)
        ]

    assert statuses == [401, 401, 401, 401, 401, 429]


def test_rate_limit_window_recovers_without_sleep(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client() as client:
        for _ in range(5):
            assert client.post(
                "/api/auth/login",
                json={"password": "654321"},
            ).status_code == 401
        harness.clock.advance(301)
        recovered = client.post(
            "/api/auth/login",
            json={"password": "654321"},
        )

    assert recovered.status_code == 401


def test_successful_login_clears_failure_history(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client() as client:
        for _ in range(4):
            assert client.post(
                "/api/auth/login",
                json={"password": "654321"},
            ).status_code == 401
        assert client.post(
            "/api/auth/login",
            json={"password": "123456"},
        ).status_code == 204
        statuses = [
            client.post(
                "/api/auth/login",
                json={"password": "654321"},
            ).status_code
            for _ in range(6)
        ]

    assert statuses == [401, 401, 401, 401, 401, 429]


def test_rate_limit_is_isolated_by_request_client_host(harness: AuthHarness) -> None:
    _seed_password(harness.database_path)

    with harness.client("192.0.2.1") as first, harness.client("192.0.2.2") as second:
        for _ in range(5):
            assert first.post(
                "/api/auth/login",
                json={"password": "654321"},
                headers={"X-Forwarded-For": "192.0.2.2"},
            ).status_code == 401
        assert first.post(
            "/api/auth/login",
            json={"password": "654321"},
        ).status_code == 429
        assert second.post(
            "/api/auth/login",
            json={"password": "654321"},
        ).status_code == 401


def test_corrupt_hash_fails_fast_instead_of_becoming_wrong_password(
    harness: AuthHarness,
) -> None:
    connection = connect_database(harness.database_path)
    try:
        connection.execute(
            """
            INSERT INTO auth_secret (singleton_id, password_hash, updated_at)
            VALUES (1, 'not-an-argon2-hash', '2026-08-28T00:00:00+00:00')
            """
        )
    finally:
        connection.close()

    with harness.client() as client, pytest.raises(InvalidHashError):
        client.post("/api/auth/login", json={"password": "123456"})


def test_verifier_failure_releases_attempt_reservation(
    harness: AuthHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_password(harness.database_path)
    verification_calls = 0

    def fail_once_then_match(password_hash: object, password: object) -> bool:
        nonlocal verification_calls
        verification_calls += 1
        if verification_calls == 1:
            raise InvalidHashError("corrupt hash")
        return True

    monkeypatch.setattr(auth, "verify_password", fail_once_then_match)

    with harness.client() as client:
        with pytest.raises(InvalidHashError, match="corrupt hash"):
            client.post("/api/auth/login", json={"password": "123456"})
        retry = client.post("/api/auth/login", json={"password": "123456"})

    assert retry.status_code == 204
    assert verification_calls == 2


def test_concurrent_logins_reserve_only_five_verifier_slots(
    harness: AuthHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_password(harness.database_path)
    first_five_entered = Event()
    release_first_five = Event()
    counter_lock = Lock()
    verification_calls = 0

    def controlled_verify(password_hash: object, password: object) -> bool:
        nonlocal verification_calls
        with counter_lock:
            verification_calls += 1
            call_number = verification_calls
            if call_number == 5:
                first_five_entered.set()
        if call_number <= 5 and not release_first_five.wait(timeout=10):
            raise TimeoutError("test did not release verifier")
        return password == "123456"

    monkeypatch.setattr(auth, "verify_password", controlled_verify)

    def login(password: str) -> int:
        with harness.client("192.0.2.50") as client:
            return client.post(
                "/api/auth/login",
                json={"password": password},
            ).status_code

    with ThreadPoolExecutor(max_workers=16) as executor:
        first_five = [executor.submit(login, "654321") for _ in range(5)]
        assert first_five_entered.wait(timeout=10)
        correct_guess = executor.submit(login, "123456")
        try:
            correct_status = correct_guess.result(timeout=10)
            later_wrong = [executor.submit(login, "654321") for _ in range(10)]
            later_statuses = [future.result(timeout=10) for future in later_wrong]
        finally:
            release_first_five.set()
        first_statuses = [future.result(timeout=10) for future in first_five]

    assert correct_status == 429
    assert verification_calls == 5
    assert first_statuses == [401] * 5
    assert later_statuses == [429] * 10


def test_router_dependency_owns_connection_lifetime(tmp_path: Path) -> None:
    database_path = tmp_path / "erp.sqlite3"
    _initialize_database(database_path)
    connection = sqlite3.connect(
        database_path,
        isolation_level=None,
        check_same_thread=False,
    )
    connection.row_factory = sqlite3.Row

    def get_connection() -> sqlite3.Connection:
        return connection

    app = FastAPI()
    app.include_router(
        auth.create_auth_router(
            get_connection,
            lambda: "test-session-secret-with-at-least-32-bytes",
        )
    )
    try:
        with TestClient(app) as client:
            assert client.get("/api/auth/session").status_code == 200
        assert connection.execute("SELECT 1").fetchone()[0] == 1
    finally:
        connection.close()


def test_limiter_atomically_reserves_only_five_simultaneous_attempts() -> None:
    clock = MutableClock()
    limiter = auth.FailedLoginLimiter(clock=clock)
    barrier = Barrier(16)

    def try_start_attempt(_: int) -> bool:
        barrier.wait(timeout=10)
        return limiter.try_start_attempt("192.0.2.10")

    with ThreadPoolExecutor(max_workers=16) as executor:
        reservations = list(executor.map(try_start_attempt, range(16)))

    assert reservations.count(True) == 5
    assert reservations.count(False) == 11
    for _ in range(5):
        limiter.finish_failure("192.0.2.10")
    assert limiter.try_start_attempt("192.0.2.10") is False
