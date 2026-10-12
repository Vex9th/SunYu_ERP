from __future__ import annotations

import hashlib
import io
import json
import stat
import time
import zipfile
from contextlib import closing
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from backend.app.core.security import SESSION_COOKIE_NAME, create_session_token
from backend.app.main import create_app
from updater.manifest import PackageError, stage_package
from updater.service import UpdateError, UpdateService
from updater.storage import component_path, read_installation, read_json, write_json


def make_package(*, component="frontend", version="1.3.1", files=None, **extra):
    files = files or {"index.html": b"new frontend", "assets/app.js": b"new script"}
    manifest = {
        "format": 1,
        "application": "SunYu_ERP",
        "component": component,
        "version": version,
        "api_version": 1,
        "runtime_version": 1,
        "files": {
            name: hashlib.sha256(body).hexdigest() for name, body in files.items()
        },
        **extra,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, body in files.items():
            archive.writestr("payload/" + name, body)
    return output.getvalue()


def installation(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    write_json(
        root / "installation.json",
        {
            "format": 1,
            "backend": "1.3.0",
            "frontend": "1.3.0",
            "api_version": 1,
            "runtime_version": 1,
        },
    )
    directory = component_path(root, "frontend", "1.3.0")
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text("old frontend")
    (directory / "assets/app.js").write_text("old script")
    return root


def wait_job(service, expected):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        job = service.status()["job"]
        if job and job["status"] in expected:
            return job
        time.sleep(0.01)
    raise AssertionError(service.status())


@pytest.mark.parametrize(
    "name",
    [
        "../escape",
        "/absolute",
        "a/../../escape",
        "a\\escape",
        "a:stream",
        "NUL.txt",
        "a/CON",
        "trailing.",
        "trailing ",
    ],
)
def test_package_rejects_windows_and_posix_unsafe_paths(tmp_path, name):
    root = installation(tmp_path)
    with pytest.raises(PackageError):
        stage_package(root, make_package(files={name: b"bad"}))
    assert not component_path(root, "frontend", "1.3.1").exists()


@pytest.mark.parametrize(
    "change",
    [
        {"runtime_version": 2},
        {"api_version": 2},
        {"application": "another"},
        {"version": "../bad"},
        {"format": True},
    ],
)
def test_package_rejects_incompatible_manifest(tmp_path, change):
    with pytest.raises(PackageError):
        stage_package(installation(tmp_path), make_package(**change))


def test_package_rejects_hash_mismatch_and_undeclared_duplicate_and_links(tmp_path):
    root = installation(tmp_path)
    for variant in ["hash", "extra", "duplicate", "link", "case"]:
        content = io.BytesIO(make_package())
        with zipfile.ZipFile(content, "a") as archive:
            if variant == "hash":
                info = archive.getinfo("payload/index.html")
                # Corrupt only the stored body: CRC/hash verification must fail.
                offset = info.header_offset + 30 + len(info.filename)
            elif variant == "extra":
                archive.writestr("payload/extra.js", "undeclared")
            elif variant == "duplicate":
                with pytest.warns(UserWarning):
                    archive.writestr("payload/index.html", "duplicate")
            elif variant == "case":
                archive.writestr("payload/INDEX.html", "case collision")
            else:
                link = zipfile.ZipInfo("payload/link")
                link.create_system = 3
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(link, "index.html")
        data = bytearray(content.getvalue())
        if variant == "hash":
            data[offset] ^= 1
        with pytest.raises(PackageError):
            stage_package(root, bytes(data))
    assert not component_path(root, "frontend", "1.3.1").exists()


def test_package_stages_immutable_version_and_retains_old_resources(tmp_path):
    root = installation(tmp_path)
    manifest = stage_package(root, make_package())
    assert manifest["version"] == "1.3.1"
    assert (
        component_path(root, "frontend", "1.3.1") / "index.html"
    ).read_text() == "new frontend"
    assert read_installation(root)["frontend"] == "1.3.0"
    with pytest.raises(PackageError, match="exists|存在"):
        stage_package(root, make_package())


def test_service_frontend_install_and_backend_pending_handoff(tmp_path):
    service = UpdateService(installation(tmp_path))
    service.start_import(make_package())
    ready = wait_job(service, {"ready", "failed"})
    assert ready["status"] == "ready"
    service.start_install("frontend")
    assert wait_job(service, {"success", "failed"})["status"] == "success"
    assert read_installation(tmp_path)["frontend"] == "1.3.1"
    service.start_import(
        make_package(
            component="backend",
            files={
                "backend/app/main.py": b"code",
                "backend/migrations/001.sql": b"SQL",
            },
        )
    )
    assert wait_job(service, {"ready", "failed"})["status"] == "ready"
    job = service.start_install("backend")
    deadline = time.monotonic() + 3
    while (
        not (tmp_path / ".updates/pending.json").exists()
        and time.monotonic() < deadline
    ):
        time.sleep(0.01)
    pending = read_json(tmp_path / ".updates/pending.json", {})
    assert pending == {"id": job["id"], "component": "backend", "version": "1.3.1"}
    assert read_installation(tmp_path)["backend"] == "1.3.0"
    assert UpdateService(tmp_path).status()["job"]["status"] == "installing"


def test_service_busy_network_failure_and_restart_recovery(tmp_path):
    entered, release = Event(), Event()

    def fetch(url, limit):
        entered.set()
        release.wait(3)
        raise OSError("offline")

    service = UpdateService(installation(tmp_path), fetch=fetch)
    service.start_check()
    assert entered.wait(2)
    with pytest.raises(UpdateError, match="进行|busy"):
        service.start_import(make_package())
    release.set()
    assert wait_job(service, {"failed"})["message"]
    assert read_installation(tmp_path)["frontend"] == "1.3.0"
    write_json(
        tmp_path / ".updates/job.json",
        {
            "id": "old",
            "status": "downloading",
            "component": "frontend",
            "version": "1.3.1",
            "message": "",
        },
    )
    assert UpdateService(tmp_path).status()["job"]["status"] == "failed"


def test_service_checks_official_catalog_then_downloads_verified_zip(tmp_path):
    package = make_package()
    prefix = "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.3.1/"
    catalog = {
        "format": 1,
        "version": "1.3.1",
        "notes": "说明",
        "components": {
            "frontend": {
                "version": "1.3.1",
                "url": prefix + "frontend.zip",
                "sha256": hashlib.sha256(package).hexdigest(),
            }
        },
    }
    release = {
        "assets": [
            {
                "name": "update-manifest.json",
                "browser_download_url": prefix + "update-manifest.json",
            }
        ]
    }
    responses = {
        "https://api.github.com/repos/Vex9th/SunYu_ERP/releases/latest": json.dumps(
            release
        ).encode(),
        prefix + "update-manifest.json": json.dumps(catalog).encode(),
        prefix + "frontend.zip": package,
    }
    service = UpdateService(
        installation(tmp_path), fetch=lambda url, limit: responses[url]
    )
    service.start_check()
    assert wait_job(service, {"success", "failed"})["status"] == "success"
    assert service.status()["latest"] == {
        k: v for k, v in catalog.items() if k != "format"
    }
    service.start_download("frontend")
    assert wait_job(service, {"ready", "failed"})["status"] == "ready"
    assert read_installation(tmp_path)["frontend"] == "1.3.0"


def client_for(root, monkeypatch, *, host="127.0.0.1", modular=True, supervised="1"):
    if supervised is None:
        monkeypatch.delenv("SUNYU_SUPERVISED", raising=False)
    else:
        monkeypatch.setenv("SUNYU_SUPERVISED", supervised)
    write_json(
        root / "config.json",
        {"data_dir": "Data", "session_secret": "test-secret-at-least-thirty-two-bytes"},
    )
    app = create_app(
        config_path=root / "config.json", update_root=root if modular else None
    )
    peer = None if host is None else (host, 32123)
    client = TestClient(app, client=peer, base_url="http://127.0.0.1:8765")
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_session_token("test-secret-at-least-thirty-two-bytes"),
    )
    return client


def test_update_api_requires_login_and_actual_loopback_and_same_origin(
    tmp_path, monkeypatch
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch, host="192.168.1.8") as client:
        assert client.get("/api/system/updates").json()["can_install"] is False
        headers = {"origin": "http://127.0.0.1:8765", "x-forwarded-for": "127.0.0.1"}
        assert (
            client.patch(
                "/api/system/updates/preferences",
                json={"auto_check": False},
                headers=headers,
            ).status_code
            == 403
        )
    with client_for(tmp_path, monkeypatch) as client:
        assert (
            client.patch(
                "/api/system/updates/preferences",
                json={"auto_check": False},
                headers={"origin": "http://evil.test"},
            ).status_code
            == 403
        )
        assert (
            client.patch(
                "/api/system/updates/preferences", json={"auto_check": False}
            ).status_code
            == 403
        )
        assert (
            client.patch(
                "/api/system/updates/preferences",
                json={"auto_check": False},
                headers={"origin": "http://127.0.0.1:8765"},
            ).status_code
            == 200
        )
        client.cookies.clear()
        assert client.get("/api/system/updates").status_code == 401


def test_development_status_is_available_and_unsupported(tmp_path, monkeypatch):
    with client_for(tmp_path, monkeypatch, modular=False) as client:
        status = client.get("/api/system/updates").json()
        assert status["supported"] is False
        assert status["can_install"] is False
        assert status["install_block_reason"] == "unsupported_runtime"
        assert status["job"] is None


@pytest.mark.parametrize(
    "peer,host,supervised,reason,recovery",
    [
        ("127.0.0.1", "127.0.0.1:8765", None, "not_supervised", "SunYu_ERP.exe"),
        ("127.0.0.1", "127.0.0.1:8765", "0", "not_supervised", "SunYu_ERP.exe"),
        (None, "127.0.0.1:8765", "1", "client_unavailable", "直接访问"),
        ("192.168.1.8", "127.0.0.1:8765", "1", "non_loopback_peer", "127.0.0.1"),
        ("127.0.0.1", "192.168.1.8:8765", "1", "non_loopback_host", "127.0.0.1"),
    ],
)
def test_update_status_explains_install_block_and_mutations_give_recovery(
    tmp_path, monkeypatch, peer, host, supervised, reason, recovery
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch, host=peer, supervised=supervised) as client:
        headers = {
            "host": host,
            "origin": f"http://{host}",
            "forwarded": "for=127.0.0.1;host=127.0.0.1:8765",
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-host": "127.0.0.1:8765",
        }
        response = client.get("/api/system/updates", headers=headers)
        assert response.status_code == 200
        state = response.json()
        assert state["supported"] is True
        assert state["can_install"] is False
        assert state["install_block_reason"] == reason
        rejected = client.patch(
            "/api/system/updates/preferences",
            json={"auto_check": False},
            headers=headers,
        )
        assert rejected.status_code == 403
        assert recovery in rejected.json()["detail"]
        assert "登录" not in rejected.json()["detail"]
        assert client.app.state.update_service.status()["preferences"]["auto_check"] is True


@pytest.mark.parametrize(
    "peer,host",
    [
        ("127.0.0.1", "127.0.0.1:8765"),
        ("127.0.0.1", "localhost:8765"),
        ("::1", "[::1]:8765"),
    ],
)
def test_update_local_status_and_mutation_have_no_install_block(
    tmp_path, monkeypatch, peer, host
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch, host=peer) as client:
        headers = {"host": host, "origin": f"http://{host}"}
        state = client.get("/api/system/updates", headers=headers).json()
        assert state["can_install"] is True
        assert state["install_block_reason"] is None
        response = client.patch(
            "/api/system/updates/preferences",
            json={"auto_check": False},
            headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["can_install"] is True
        assert response.json()["install_block_reason"] is None
        assert response.json()["preferences"]["auto_check"] is False


def test_dynamic_frontend_switch_old_resource_and_maintenance(tmp_path, monkeypatch):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch) as client:
        assert client.get("/").text == "old frontend"
        assert "no-store" in client.get("/").headers["cache-control"]
        stage_package(tmp_path, make_package())
        value = read_installation(tmp_path)
        value["frontend"] = "1.3.1"
        write_json(tmp_path / "installation.json", value)
        assert client.get("/").text == "new frontend"
        assert (
            client.get("/projects/P001", headers={"accept": "text/html"}).text
            == "new frontend"
        )
        assert client.get("/__frontend/1.3.0/assets/app.js").text == "old script"
        assert client.get("/__frontend/1.3.1/assets/app.js").text == "new script"
        assert client.get("/__frontend/1.3.1/unknown.js").status_code == 404
        (tmp_path / ".updates/maintenance").touch()
        assert (
            client.post("/api/auth/setup", json={"password": "123456"}).status_code
            == 503
        )
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/system/updates").status_code == 200


def test_install_returns_before_slow_verification_and_preserves_failure(
    tmp_path, monkeypatch
):
    from updater import service as module

    service = UpdateService(installation(tmp_path))
    service.start_import(make_package())
    assert wait_job(service, {"ready", "failed"})["status"] == "ready"
    entered, release = Event(), Event()

    def slow_verify(*args):
        entered.set()
        release.wait(2)
        raise PackageError("modified staged file")

    monkeypatch.setattr(module, "verify_staged", slow_verify)
    began = time.monotonic()
    job = service.start_install("frontend")
    assert time.monotonic() - began < 0.5
    assert entered.wait(1)
    assert job["status"] == "installing"
    release.set()
    assert wait_job(service, {"failed"})["message"] == "modified staged file"
    assert read_installation(tmp_path)["frontend"] == "1.3.0"


def test_verification_rejects_added_staged_code_and_metadata_collision(tmp_path):
    from updater.manifest import verify_staged

    root = installation(tmp_path)
    stage_package(root, make_package())
    (component_path(root, "frontend", "1.3.1") / "extra.js").write_text("tampered")
    with pytest.raises(PackageError):
        verify_staged(root, "frontend", "1.3.1")
    with pytest.raises(PackageError):
        stage_package(
            root,
            make_package(
                version="1.3.2",
                files={"index.html": b"html", ".update-manifest.json": b"bad"},
            ),
        )


def test_backend_install_handoff_preserves_active_task_until_supervisor_finishes(
    tmp_path,
):
    service = UpdateService(installation(tmp_path))
    service.start_import(
        make_package(
            component="backend",
            files={
                "backend/app/main.py": b"code",
                "backend/migrations/001.sql": b"SQL",
            },
        )
    )
    assert wait_job(service, {"ready", "failed"})["status"] == "ready"
    service.start_install("backend")
    deadline = time.monotonic() + 3
    while (
        not (tmp_path / ".updates/pending.json").exists()
        and time.monotonic() < deadline
    ):
        time.sleep(0.01)
    assert read_json(tmp_path / ".updates/pending.json")["component"] == "backend"
    with pytest.raises(UpdateError):
        service.start_check()


def test_official_catalog_rejects_arbitrary_urls(tmp_path):
    from updater.service import validate_catalog

    for url in [
        "https://evil.test/update.zip",
        "http://github.com/Vex9th/SunYu_ERP/releases/download/v1/file.zip",
        "https://github.com/another/repo/releases/download/v1/file.zip",
        "https://user@github.com/Vex9th/SunYu_ERP/releases/download/v1/file.zip",
    ]:
        with pytest.raises(UpdateError):
            validate_catalog(
                {
                    "format": 1,
                    "version": "1.3.1",
                    "components": {
                        "frontend": {"version": "1.3.1", "url": url, "sha256": "a" * 64}
                    },
                }
            )


def test_offline_import_http_installs_only_after_explicit_install(
    tmp_path, monkeypatch
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch) as client:
        headers = {"origin": "http://127.0.0.1:8765"}
        response = client.post(
            "/api/system/updates/import",
            files={"file": ("frontend.zip", make_package(), "application/zip")},
            headers=headers,
        )
        assert response.status_code == 202
        service = client.app.state.update_service
        assert wait_job(service, {"ready", "failed"})["status"] == "ready"
        assert client.get("/").text == "old frontend"
        response = client.post(
            "/api/system/updates/install",
            json={"component": "frontend"},
            headers=headers,
        )
        assert response.status_code == 202
        assert wait_job(service, {"success", "failed"})["status"] == "success"
        assert client.get("/").text == "new frontend"


def test_scheduled_backup_does_not_begin_during_maintenance(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    from backend.app.core.database import connect_database

    installation(tmp_path)
    runners = []

    class Scheduler:
        def __init__(self, **kwargs):
            runners.append(kwargs["runner"])

        def start(self):
            pass

        def stop(self):
            pass

    app = create_app(
        config_path=tmp_path / "config.json",
        update_root=tmp_path,
        scheduler_factory=Scheduler,
    )
    with TestClient(app):
        (tmp_path / ".updates/maintenance").touch()
        with (
            closing(connect_database(tmp_path / "Data/iapm.sqlite")) as connection,
            pytest.raises(RuntimeError, match="维护"),
        ):
            runners[0](connection, app.state.settings.get(), datetime.now(timezone.utc))
        assert not list(tmp_path.glob("Backups/*.zip"))


def test_backend_validation_interrupted_before_pending_can_be_retried(tmp_path):
    installation(tmp_path)
    write_json(
        tmp_path / ".updates/job.json",
        {
            "id": "interrupted",
            "component": "backend",
            "version": "1.3.1",
            "status": "installing",
            "message": "",
        },
    )
    service = UpdateService(tmp_path)
    assert service.status()["job"]["status"] == "failed"


def test_expected_package_identity_rejected_before_publishing_version(tmp_path):
    root = installation(tmp_path)
    with pytest.raises(PackageError, match="identity"):
        stage_package(
            root, make_package(), expected_component="backend", expected_version="1.3.1"
        )
    assert not component_path(root, "frontend", "1.3.1").exists()


@pytest.mark.parametrize("component", [[], {}, None, "anything"])
def test_update_api_rejects_invalid_component_without_internal_error(
    tmp_path, monkeypatch, component
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch) as client:
        response = client.post(
            "/api/system/updates/download",
            json={"component": component},
            headers={"origin": "http://127.0.0.1:8765"},
        )
        assert response.status_code == 409


def test_import_can_recover_identical_version_staged_before_crash(tmp_path):
    root = installation(tmp_path)
    stage_package(root, make_package())
    service = UpdateService(root)
    service.start_import(make_package())
    assert wait_job(service, {"ready", "failed"})["status"] == "ready"
    service.start_install("frontend")
    assert wait_job(service, {"success", "failed"})["status"] == "success"


def test_import_cannot_replace_existing_version_with_different_content(tmp_path):
    root = installation(tmp_path)
    stage_package(root, make_package())
    service = UpdateService(root)
    service.start_import(make_package(files={"index.html": b"different"}))
    assert wait_job(service, {"ready", "failed"})["status"] == "failed"
    assert (
        component_path(root, "frontend", "1.3.1") / "index.html"
    ).read_text() == "new frontend"


@pytest.mark.parametrize(
    "route,method",
    [
        ("download", "post"),
        ("install", "post"),
        ("import", "post"),
        ("preferences", "patch"),
    ],
)
def test_all_update_mutations_reject_remote_clients(
    tmp_path, monkeypatch, route, method
):
    installation(tmp_path)
    with client_for(tmp_path, monkeypatch, host="203.0.113.10") as client:
        response = getattr(client, method)(
            "/api/system/updates/" + route,
            json={"component": "frontend"},
            headers={
                "origin": "http://127.0.0.1:8765",
                "forwarded": "for=127.0.0.1",
                "x-forwarded-for": "127.0.0.1",
            },
        )
        assert response.status_code == 403
        assert client.app.state.update_service.status()["job"] is None


def test_modular_shutdown_keeps_waiting_for_active_backup(tmp_path):
    installation(tmp_path)

    class SlowScheduler:
        is_alive = True
        stop_calls = 0

        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

        def stop(self):
            self.stop_calls += 1
            if self.stop_calls == 1:
                raise RuntimeError("Backup scheduler did not stop")
            self.is_alive = False

    app = create_app(
        config_path=tmp_path / "config.json",
        update_root=tmp_path,
        scheduler_factory=SlowScheduler,
    )
    with TestClient(app):
        pass
    assert app.state.backup_scheduler.stop_calls == 2
