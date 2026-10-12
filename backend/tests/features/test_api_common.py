from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient


def test_api_error_route_serializes_the_frozen_error_contract() -> None:
    from backend.app.features.api_common import ApiError, ApiErrorRoute

    app = FastAPI()
    router = APIRouter(route_class=ApiErrorRoute)

    @router.get("/conflict")
    def conflict() -> None:
        raise ApiError(
            409,
            "Resource was modified",
            "REVISION_CONFLICT",
            field_errors={"expected_revision": ["is stale"]},
            current_revision=3,
            headers={"X-Error-Code": "REVISION_CONFLICT"},
        )

    app.include_router(router)

    with TestClient(app) as client:
        response = client.get("/conflict")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Resource was modified",
        "error_code": "REVISION_CONFLICT",
        "field_errors": {"expected_revision": ["is stale"]},
        "current_revision": 3,
    }
    assert response.headers["X-Error-Code"] == "REVISION_CONFLICT"
