"""只在新建目录验证真实 Windows 包的旧数据升级、热更新和故障回退。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import runpy
import shutil
import socket
import sqlite3
import subprocess
import time
import zipfile
from pathlib import Path

import httpx

BUSINESS = runpy.run_path(str(Path(__file__).with_name("release_smoke.py")))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def snapshot(path: Path) -> dict:
    with sqlite3.connect(path) as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {table: list(connection.execute(f'SELECT * FROM "{table}"')) for table in tables}


def make_package(component: str, version: str, files: dict[str, bytes]) -> bytes:
    manifest = {"format": 1, "application": "SunYu_ERP", "component": component,
                "version": version, "api_version": 1, "runtime_version": 1,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, data in files.items():
            archive.writestr("payload/" + name, data)
    return output.getvalue()


def wait_health(client: httpx.Client, process: subprocess.Popen, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ERP exited before ready: {process.returncode}")
        try:
            response = client.get("/api/health")
            if response.status_code == 200 and response.json().get("status") == "ok":
                return response.json()
        except httpx.TransportError:
            pass
        time.sleep(0.3)
    raise RuntimeError("ERP health timeout")


def wait_job(client: httpx.Client, expected: str, timeout=120):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            response = client.get("/api/system/updates")
            if response.status_code == 200:
                value = response.json()
                last = value["job"]
                if last and last["status"] == expected:
                    return value
                if last and last["status"] in {"failed", "manual_recovery"} and expected != "failed":
                    raise RuntimeError(str(last))
        except httpx.TransportError:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Update job timeout: expected {expected}, got {last}")


def import_and_install(client, data: bytes, component: str):
    response = client.post("/api/system/updates/import", files={"file": ("update.zip", data, "application/zip")})
    assert response.status_code == 202, response.text
    wait_job(client, "ready")
    response = client.post("/api/system/updates/install", json={"component": component})
    assert response.status_code == 202, response.text


def stop(process: subprocess.Popen, root: Path, *, legacy=False):
    if process.poll() is not None:
        return
    if legacy and os.name == "nt":
        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], check=True, capture_output=True)
    elif legacy:
        process.terminate()
    else:
        (root / ".updates/stop").touch()
    process.wait(timeout=100)


def run(package_dir: Path, output: Path, legacy_zip: Path | None = None):
    output.mkdir(parents=True, exist_ok=False)
    root = output / "SunYu ERP 中文安装"
    root.mkdir()
    port = free_port()
    report = {"port": port, "legacy_upgrade": legacy_zip is not None}
    config_path = root / "config.json"
    config_path.write_text(json.dumps({"host": "127.0.0.1", "port": port, "data_dir": "Data", "backup_enabled": False}), encoding="utf-8")
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=15, trust_env=False,
                          headers={"Origin": f"http://127.0.0.1:{port}"})
    process = None
    streams = []

    def launch(label):
        stream = (output / f"{label}.log").open("wb")
        streams.append(stream)
        return subprocess.Popen([str(root / "SunYu_ERP.exe")], cwd=root, stdout=stream, stderr=subprocess.STDOUT)

    try:
        if legacy_zip:
            # legacy_zip is our previously verified release artifact, not an HTTP upload.
            with zipfile.ZipFile(legacy_zip) as archive:
                assert "SunYu_ERP.exe" in archive.namelist()
                (root / "SunYu_ERP.exe").write_bytes(archive.read("SunYu_ERP.exe"))
        else:
            shutil.copytree(package_dir, root, dirs_exist_ok=True)
        process = launch("initial")
        wait_health(client, process)
        state = BUSINESS["seed"](client)
        BUSINESS["verify"](client, state)
        proof = root / "Data/Projects/upgrade-proof.txt"
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_bytes(b"keep original project attachment\n")
        stop(process, root, legacy=legacy_zip is not None)
        before = snapshot(root / "Data/iapm.sqlite")
        config_before = config_path.read_bytes()
        if legacy_zip:
            shutil.copytree(package_dir, root, dirs_exist_ok=True)
        process = launch("modular")
        health = wait_health(client, process)
        BUSINESS["verify"](client, state)
        initial_pid = health["pid"]
        original_version = health["backend_version"]
        report["initial_version"] = original_version
        assert snapshot(root / "Data/iapm.sqlite") == before
        status = client.get("/api/system/updates").json()
        assert status["can_install"] and status["supported"], status
        # Isolated test version numbers never ship in the delivered package.
        frontend_version, backend_version, broken_version = "99.0.1", "99.0.2", "99.0.3"
        frontend = make_package("frontend", frontend_version, {
            "index.html": f'<html><body>frontend-update-proof<script src="/__frontend/{frontend_version}/proof.js"></script></body></html>'.encode(),
            "proof.js": b"window.updateProof = true;",
        })
        import_and_install(client, frontend, "frontend")
        wait_job(client, "success")
        assert client.get("/api/health").json()["pid"] == initial_pid
        assert "frontend-update-proof" in client.get("/").text
        assert client.get(f"/__frontend/{frontend_version}/proof.js").status_code == 200
        assert client.get(f"/__frontend/{original_version}/index.html").status_code == 200
        report["frontend_update_without_restart"] = True
        backend_root = package_dir / "releases/backend" / original_version
        files = {p.relative_to(backend_root).as_posix(): p.read_bytes() for p in backend_root.rglob("*")
                 if p.is_file() and p.suffix in {".py", ".sql"} and "__pycache__" not in p.parts}
        import_and_install(client, make_package("backend", backend_version, files), "backend")
        wait_job(client, "success")
        health = client.get("/api/health").json()
        assert health["backend_version"] == backend_version and health["pid"] != initial_pid
        BUSINESS["verify"](client, state)
        assert snapshot(root / "Data/iapm.sqlite") == before
        assert config_path.read_bytes() == config_before
        assert proof.read_bytes() == b"keep original project attachment\n"
        report["backend_upgrade_preserves_all_rows_config_attachments"] = True
        broken = {**files, "backend/app/main.py": b'raise RuntimeError("intentional update smoke failure")\n'}
        import_and_install(client, make_package("backend", broken_version, broken), "backend")
        failed = wait_job(client, "failed")
        assert failed["current"]["backend"] == backend_version
        BUSINESS["verify"](client, state)
        assert snapshot(root / "Data/iapm.sqlite") == before
        assert config_path.read_bytes() == config_before
        assert len(list((root / ".updates/backups").iterdir())) == 2
        report["failed_backend_update_rolled_back_without_data_change"] = True
        stop(process, root)
        assert process.returncode == 0, process.returncode
        report["graceful_exit"] = True
        with socket.socket() as probe:
            assert probe.connect_ex(("127.0.0.1", port)) != 0
        report["port_released"] = True
        (output / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
    finally:
        if process is not None:
            stop(process, root)
        client.close()
        for stream in streams:
            stream.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--legacy-zip", type=Path)
    arguments = parser.parse_args()
    run(arguments.package_dir.resolve(), arguments.output.resolve(), arguments.legacy_zip)
