from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from argon2.exceptions import InvalidHashError

from backend.app.core.security import SESSION_COOKIE_NAME
from backend.tests.account_support import OWNER_PASSWORD, make_access_app


@pytest.fixture
def access_harness(tmp_path: Path):
    return make_access_app(tmp_path)


def test_shared_cookie_is_not_an_account_session(access_harness):
    client = access_harness.client_with_legacy_cookie()
    state = client.get("/api/auth/session").json()
    assert state["authenticated"] is False
    assert state["bootstrap_required"] is True
    assert client.get("/_test/principal").status_code == 401


def test_bootstrap_checks_old_pin_without_mutating_it(access_harness):
    old_hash = access_harness.seed_legacy_password()
    client = access_harness.client()
    payload = {
        "username": "Owner",
        "password": OWNER_PASSWORD,
        "display_name": "主账号",
    }
    assert client.post("/api/auth/bootstrap", json=payload).status_code == 401
    assert (
        client.post(
            "/api/auth/bootstrap", json={**payload, "legacy_password": "654321"}
        ).status_code
        == 401
    )
    response = client.post(
        "/api/auth/bootstrap", json={**payload, "legacy_password": "123456"}
    )
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["authenticated"] is True and state["bootstrap_required"] is False
    assert state["user"]["is_owner"] is True
    assert state["project_ids"] is None
    with access_harness.connection() as connection:
        assert (
            connection.execute("SELECT password_hash FROM auth_secret").fetchone()[0]
            == old_hash
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM accounts WHERE is_owner = 1"
            ).fetchone()[0]
            == 1
        )
        stored_sid = connection.execute(
            "SELECT sid_hash FROM account_sessions"
        ).fetchone()[0]
        assert len(stored_sid) == 64
        assert stored_sid not in client.cookies.get(SESSION_COOKIE_NAME)


@pytest.mark.parametrize(
    "host,headers",
    [
        ("192.0.2.1", {}),
        ("127.0.0.1", {"X-Forwarded-For": "127.0.0.1"}),
        ("127.0.0.1", {"Origin": "https://attacker.example"}),
    ],
)
def test_bootstrap_requires_local_direct_request(access_harness, host, headers):
    response = access_harness.client(host).post(
        "/api/auth/bootstrap",
        headers=headers,
        json={
            "username": "owner",
            "password": OWNER_PASSWORD,
            "display_name": "主账号",
        },
    )
    assert response.status_code == 403


def test_concurrent_bootstrap_creates_only_one_owner(access_harness):
    def bootstrap(index):
        return (
            access_harness.client()
            .post(
                "/api/auth/bootstrap",
                json={
                    "username": f"owner{index}",
                    "password": OWNER_PASSWORD,
                    "display_name": "主账号",
                },
            )
            .status_code
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = sorted(executor.map(bootstrap, [1, 2]))
    assert statuses == [200, 409]


def test_unicode_password_preserves_spaces_and_logout_revokes_cookie(access_harness):
    client = access_harness.client()
    password = "  空格密码🙂测试保留  "
    assert (
        client.post(
            "/api/auth/bootstrap",
            json={"username": "ｏｗｎｅｒ", "password": password, "display_name": ""},
        ).status_code
        == 200
    )
    token = client.cookies.get(SESSION_COOKIE_NAME)
    assert client.post("/api/auth/logout").status_code == 204
    client.cookies.set(SESSION_COOKIE_NAME, token)
    assert client.get("/_test/principal").status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"username": "OWNER", "password": password.strip()}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login", json={"username": "OWNER", "password": password}
        ).status_code
        == 204
    )


@pytest.mark.parametrize("password", ["short", "x" * 129, 12345678, True, None])
def test_bootstrap_validation_never_echoes_secret(access_harness, password):
    response = access_harness.client().post(
        "/api/auth/bootstrap",
        json={
            "username": "owner",
            "password": password,
            "display_name": "主账号",
        },
    )
    assert response.status_code == 422
    if isinstance(password, str):
        assert password not in response.text


def test_disabled_legacy_setup_does_not_create_shared_secret(access_harness):
    assert (
        access_harness.client()
        .post("/api/auth/setup", json={"password": "123456"})
        .status_code
        == 410
    )
    with access_harness.connection() as connection:
        assert connection.execute("SELECT count(*) FROM auth_secret").fetchone()[0] == 0


def test_corrupt_legacy_hash_is_not_reported_as_wrong_password(access_harness):
    with access_harness.connection() as connection:
        connection.execute(
            "INSERT INTO auth_secret VALUES (1, 'broken-hash', '2026-10-31')"
        )
    with pytest.raises(InvalidHashError):
        access_harness.client().post(
            "/api/auth/bootstrap",
            json={
                "username": "owner",
                "password": OWNER_PASSWORD,
                "legacy_password": "123456",
            },
        )


def test_unpaired_surrogate_password_is_rejected_without_server_error(access_harness):
    response = access_harness.client().post(
        "/api/auth/bootstrap",
        content='{"username":"owner","password":"passpass\\ud800"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
