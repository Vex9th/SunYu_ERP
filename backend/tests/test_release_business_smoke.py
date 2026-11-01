from __future__ import annotations

import runpy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.tests.account_support import make_access_app


def test_release_business_smoke_survives_restart_and_refuses_existing_data(tmp_path: Path) -> None:
    script = runpy.run_path(str(Path(__file__).parents[2] / ".github/scripts/release_smoke.py"))
    config = tmp_path / "config.json"
    with TestClient(create_app(config_path=config), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        state = script["seed"](client)
        script["verify"](client, state)
        with pytest.raises(AssertionError, match="409"):
            script["seed"](client)
    with TestClient(create_app(config_path=config), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as restarted:
        script["verify"](restarted, state)


def test_release_upgrade_requires_legacy_password_and_creates_real_owner(tmp_path: Path) -> None:
    script = runpy.run_path(str(Path(__file__).parents[2] / ".github/scripts/release_smoke.py"))
    harness = make_access_app(tmp_path)
    client = harness.client_with_legacy_cookie()
    state = {"password": "wrong-password", "username": None}
    with pytest.raises(AssertionError, match="401"):
        script["migrate_owner"](client, state)
    assert client.get("/api/auth/session").json()["bootstrap_required"]
    state["password"] = "123456"
    script["migrate_owner"](client, state)
    script["login"](client, state)
    session = client.get("/api/auth/session").json()
    assert session["authenticated"] and session["user"]["is_owner"]
    assert state["username"] == "release_owner" and state["password"] != "123456"
    with harness.connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 1
