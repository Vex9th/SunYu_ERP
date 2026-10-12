from __future__ import annotations

import runpy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app


def test_release_business_smoke_survives_restart_and_refuses_existing_data(tmp_path: Path) -> None:
    script = runpy.run_path(str(Path(__file__).parents[2] / ".github/scripts/release_smoke.py"))
    config = tmp_path / "config.json"
    with TestClient(create_app(config_path=config)) as client:
        state = script["seed"](client)
        script["verify"](client, state)
        with pytest.raises(AssertionError, match="409"):
            script["seed"](client)
    with TestClient(create_app(config_path=config)) as restarted:
        script["verify"](restarted, state)
