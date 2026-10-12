"""Windows 隔离夹具：验证官方 1.2.4 升至单 EXE 候选及故障恢复。"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import runpy
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
import zipfile
from contextlib import closing
from ctypes import wintypes
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
LEGACY_SHA = "bab84925b30d095e1cf5ea84230a9c5d9fcb581c6578695f154ebadc681eb531"
BUSINESS = runpy.run_path(str(ROOT / ".github/scripts/release_smoke.py"))
PACKAGE = runpy.run_path(str(ROOT / ".github/scripts/package_singlefile.py"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def process_image(pid: int) -> str:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
    ]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.value
    finally:
        kernel.CloseHandle(handle)


def wait_for(check, label: str, seconds: float = 120):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            return check()
        except (AssertionError, OSError, ValueError, httpx.HTTPError) as error:
            last = error
            time.sleep(0.15)
    raise AssertionError(f"{label}: {last}")


def extract(archive: Path, destination: Path, names: set[str]) -> None:
    destination.mkdir()
    with zipfile.ZipFile(archive) as package:
        assert set(package.namelist()) == names
        assert len(package.namelist()) == len(names)
        assert package.testzip() is None
        for name in names:
            assert not package.getinfo(name).is_dir()
            (destination / name).write_bytes(package.read(name))


def database_snapshot(database: Path) -> dict[str, str]:
    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        names = connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        result = {}
        for (name,) in names.fetchall():
            quoted = name.replace('"', '""')
            rows = connection.execute(f'SELECT * FROM "{quoted}"').fetchall()
            result[name] = hashlib.sha256(repr(sorted(map(repr, rows))).encode()).hexdigest()
        return result


def run(command: list[str], log: Path, *, cwd: Path | None = None, env=None) -> None:
    with log.open("xb") as output:
        subprocess.run(command, cwd=cwd, env=env, stdout=output,
                       stderr=subprocess.STDOUT, check=True)


class Harness:
    def __init__(self, args) -> None:
        self.args = args
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.root = self.output / "SunYu ERP 中文 安装"
        self.tools = self.output / "fixtures"
        self.tools.mkdir()
        self.report: dict = {"status": "running", "version": args.version, "checks": [],
                             "source": "official 1.2.4 plus controlled local candidate mapping"}
        self.logs = []
        self.children: list[subprocess.Popen] = []
        self.counter = 0
        self.port = 0
        self.client: httpx.Client | None = None

    def checked(self, message: str) -> None:
        self.report["checks"].append(message)
        print(f"PASS {message}", flush=True)
        self.save()

    def owned_processes(self) -> list[int]:
        script = (
            "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
            "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
            "$_.ExecutablePath.StartsWith($env:SUNYU_SMOKE_ROOT + '\\', "
            "[System.StringComparison]::OrdinalIgnoreCase) } | "
            "Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"
        )
        raw = subprocess.check_output(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
             base64.b64encode(script.encode("utf-16le")).decode("ascii")],
            env={**os.environ, "SUNYU_SMOKE_ROOT": str(self.root)}, text=True,
            encoding="utf-8", timeout=20,
        ).strip()
        value = json.loads(raw) if raw else []
        return value if isinstance(value, list) else [value]

    def save(self) -> None:
        (self.output / "verification-result.json").write_text(
            json.dumps(self.report, ensure_ascii=False, indent=2), encoding="utf-8")

    def spawn(self, executable: Path, args: list[str], label: str) -> subprocess.Popen:
        log = (self.output / f"{label}.log").open("xb")
        self.logs.append(log)
        process = subprocess.Popen([str(executable), *args], cwd=self.root,
                                   stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        self.children.append(process)
        return process

    def health(self, version: str | None = None):
        def probe():
            response = self.client.get("/api/health")
            response.raise_for_status()
            value = response.json()
            assert value["status"] == "ok"
            if version is not None:
                assert value["version"] == version
                assert isinstance(value["pid"], int) and value["pid"] > 0
            return value
        return wait_for(probe, f"health {version}")

    def job(self, job_id: str, terminal: str):
        def probe():
            value = json.loads((self.root / ".updates/status.json").read_text(encoding="utf-8"))
            assert value["job_id"] == job_id
            assert not value["busy"]
            assert value["phase"] == terminal, value
            return value
        return wait_for(probe, f"update job {job_id}: {terminal}", 180)

    def observe_worker(self, identifier: str) -> None:
        def probe():
            value = json.loads((self.root / ".updates/dispatch.json").read_text(encoding="utf-8"))
            assert value["job_id"] == identifier
            return {"ProcessId": value["pid"], "ExecutablePath": process_image(value["pid"])}
        process = wait_for(probe, "independent worker dispatch and executable identity", 20)
        expected = self.root / ".updates/work" / identifier / "update.exe"
        assert Path(process["ExecutablePath"]).resolve() == expected.resolve(), process
        assert process["ProcessId"] != self.first.pid
        self.report.setdefault("independent_workers", []).append(process)

    def update(self, manifest: Path, package: Path, terminal="success", duplicate=False,
               apply=True, observe=False, entry: Path | None = None):
        self.counter += 1
        identifier = uuid.uuid4().hex
        args = ["--root", str(self.root), "--apply" if apply else "--check",
                "--job-id", identifier, "--no-pause", "--test-manifest", str(manifest),
                "--test-package", str(package)]
        executable = entry or self.test_updater
        process = self.spawn(executable, args, f"update-{self.counter}")
        others = []
        if duplicate:
            others.append(self.spawn(executable, args, f"update-{self.counter}-duplicate"))
        if observe:
            self.observe_worker(identifier)
        codes = [process.wait(timeout=40), *(p.wait(timeout=40) for p in others)]
        assert 0 in codes and set(codes) <= {0, 2}, codes
        state = self.job(identifier, terminal)
        if terminal == "failed":
            assert state["error"]
        return state

    def build_updater(self, name: str, version: str, supplied: Path | None,
                      testing=False) -> Path:
        if supplied is not None:
            return supplied.resolve()
        output = self.tools / name
        command = ["go", "build", "-trimpath", f"-ldflags=-s -w -X main.version={version}"]
        if testing:
            command += ["-tags", "updatertest"]
        command += ["-o", str(output), "."]
        run(command, self.output / f"build-{name}.log", cwd=ROOT / "updater",
            env={**os.environ, "CGO_ENABLED": "0", "GOOS": "windows", "GOARCH": "amd64"})
        return output

    def prepare(self) -> None:
        candidate = self.args.candidate.resolve()
        self.candidate = candidate
        self.manifest = candidate / "update-manifest-singlefile.json"
        self.archive = candidate / "SunYu_ERP-windows-x64.zip"
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        assert manifest["version"] == self.args.version
        assert digest(self.archive) == manifest["archive"]["sha256"]
        assert digest(candidate / "update.exe") == manifest["files"]["update.exe"]
        for line in (candidate / "SHA256SUMS.txt").read_text(encoding="ascii").splitlines():
            expected, name = line.split("  ")
            assert digest(candidate / name) == expected
        with zipfile.ZipFile(self.archive) as archive:
            assert set(archive.namelist()) == set(PACKAGE["PACKAGE_FILES"])
            for name, expected in manifest["files"].items():
                assert hashlib.sha256(archive.read(name)).hexdigest() == expected
        assert digest(self.args.legacy) == LEGACY_SHA
        extract(self.args.legacy, self.root, set(PACKAGE["PACKAGE_FILES"]) - {"update.exe"})
        production_probe = subprocess.run(
            [str(candidate / "update.exe"), "--root", str(self.root), "--no-pause",
             "--test-manifest", str(self.manifest)], capture_output=True, timeout=10, check=False,
        )
        assert production_probe.returncode == 1
        assert not (self.root / ".updates").exists()
        self.checked("production updater rejects test-only source mapping flags before touching installation state")
        self.test_updater = self.build_updater("test-driver.exe", self.args.version,
                                               self.args.test_updater, testing=True)
        old_updater = self.build_updater("old-updater.exe", "1.2.4", self.args.old_updater)
        shutil.copyfile(old_updater, self.root / "update.exe")
        assert digest(self.root / "update.exe") != manifest["files"]["update.exe"]
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.config = json.dumps({"host": "127.0.0.1", "port": self.port,
                                  "data_dir": "客户数据/DATA", "backup_enabled": False,
                                  "session_secret": uuid.uuid4().hex}, ensure_ascii=False).encode()
        (self.root / "config.json").write_bytes(self.config)
        (self.root / ".singlefile-upgrade-fixture").write_text("synthetic upgrade fixture")
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=10,
                                   trust_env=False, headers={"Origin": f"http://127.0.0.1:{self.port}"})
        self.first = self.spawn(self.root / "SunYu_ERP.exe", [], "legacy-124")
        self.health()
        self.state = BUSINESS["seed"](self.client)
        BUSINESS["verify"](self.client, self.state)
        response = self.client.post("/api/projects/RELEASE-SMOKE/documents",
                                    headers={"Idempotency-Key": str(uuid.uuid4())},
                                    data={"category": "contract", "title": "升级测试合同"},
                                    files={"file": ("中文合同.pdf", b"%PDF-1.4\nfixture\n%%EOF", "application/pdf")})
        assert response.status_code == 201, response.text
        document = response.json()
        self.document_path = (f"/api/projects/RELEASE-SMOKE/documents/{document['id']}"
                              f"/versions/{document['versions'][0]['id']}/download")
        self.attachment = self.client.get(self.document_path).content
        self.cookie = dict(self.client.cookies)
        (self.root / ".updates").mkdir(exist_ok=True)
        (self.root / ".updates/customer-note.txt").write_text("preserve unknown file")
        self.checked("official 1.2.4 starts in a Chinese/space path and seeds verified business data and API attachment")

    def preserved(self) -> None:
        assert (self.root / "config.json").read_bytes() == self.config
        self.client.cookies.update(self.cookie)
        assert self.client.get("/api/auth/session").json()["authenticated"]
        response = self.client.get(self.document_path)
        assert response.status_code == 200 and response.content == self.attachment
        BUSINESS["verify"](self.client, self.state)
        assert (self.root / ".updates/customer-note.txt").read_text() == "preserve unknown file"

    def failure_package(self) -> tuple[Path, Path]:
        major, minor, patch = map(int, self.args.version.split("."))
        version = f"{major}.{minor}.{patch + 1}"
        updater = self.build_updater("failure-updater.exe", version, self.args.failure_updater)
        failed_exe = self.args.failure_exe
        if failed_exe is None:
            source = self.tools / "failure.py"
            source.write_text(
                "import json,sys\nfrom pathlib import Path\n"
                "root=Path(sys.executable).parent\n"
                "if (root/'.singlefile-upgrade-fixture').read_text() != 'synthetic upgrade fixture': raise SystemExit(43)\n"
                "config=json.loads((root/'config.json').read_text(encoding='utf-8'))\n"
                "(root/config['data_dir']/'iapm.sqlite').write_bytes(b'synthetic corrupt database')\n"
                "(root/'.failure-fixture-ran').write_text('yes')\nraise SystemExit(42)\n",
                encoding="utf-8")
            run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile",
                 "--distpath", str(self.tools / "bad-dist"), "--workpath", str(self.tools / "bad-build"),
                 "--specpath", str(self.tools), "--name", "failure", str(source)],
                self.output / "build-failure.log")
            failed_exe = self.tools / "bad-dist/failure.exe"
        output = self.tools / "failure-package"
        PACKAGE["build_package"](version, failed_exe.resolve(), updater, output, ROOT)
        return output / "update-manifest-singlefile.json", output / "SunYu_ERP-windows-x64.zip"

    def verify(self) -> None:
        self.prepare()
        before = {name: digest(self.root / name) for name in ("SunYu_ERP.exe", "update.exe")}
        bad = self.tools / "corrupt.zip"
        bad.write_bytes(b"invalid candidate archive")
        self.update(self.manifest, bad, "failed")
        assert self.first.poll() is None
        assert {name: digest(self.root / name) for name in before} == before
        self.health()
        self.preserved()
        self.checked("bad archive rejected before stopping or changing the old application")
        root_updater = self.root / "update.exe"
        shutil.copyfile(self.test_updater, root_updater)
        self.report["executed_root_updater_sha256"] = digest(root_updater)
        self.update(self.manifest, self.archive, duplicate=True, observe=True, entry=root_updater)
        health = self.health(self.args.version)
        self.preserved()
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        assert {name: digest(self.root / name) for name in before} == manifest["files"]
        assert self.report["executed_root_updater_sha256"] != manifest["files"]["update.exe"]
        assert self.first.wait(timeout=30) is not None
        self.checked("automatic candidate install replaces both EXEs, preserves config/session/money/invoices/ledger/attachment and serializes duplicate clicks")
        runtime_path = self.root / ".updates/runtime.json"
        runtime_bytes = runtime_path.read_bytes()
        duplicate = self.spawn(self.root / "SunYu_ERP.exe", [], "duplicate-main")
        assert duplicate.wait(timeout=30) == 0
        assert self.health(self.args.version)["pid"] == health["pid"]
        assert runtime_path.read_bytes() == runtime_bytes
        self.checked("duplicate main EXE exits without replacing the live service or its runtime identity")
        index = self.client.get("/")
        assert index.status_code == 200 and '<div id="app">' in index.text
        assets = re.findall(r'(?:src|href)="([^\"]+\.(?:js|css))"', index.text)
        assert any(asset.endswith(".js") for asset in assets)
        assert any(asset.endswith(".css") for asset in assets)
        for asset in assets:
            response = self.client.get(asset)
            assert response.status_code == 200 and len(response.content) > 100
            assert "text/html" not in response.headers.get("content-type", "")
        self.checked("bundled frontend HTML, JavaScript and CSS load from the upgraded single EXE")
        state = self.client.get("/api/system/updates").json()
        assert state["supported"] and state["can_install"]
        same = self.update(self.manifest, self.archive, "idle", apply=False)
        assert not same["update_available"]
        same_apply = self.update(self.manifest, self.archive)
        assert not same_apply["update_available"]
        assert self.health(self.args.version)["pid"] == health["pid"]
        data = self.root / "客户数据/DATA/iapm.sqlite"
        snapshot = database_snapshot(data)
        failure_manifest, failure_archive = self.failure_package()
        self.stop_service()
        (self.root / ".updates/installed.json").unlink()
        failed_install = self.update(failure_manifest, failure_archive, "failed", observe=True)
        self.health(self.args.version)
        assert (self.root / ".failure-fixture-ran").read_text() == "yes"
        assert {name: digest(self.root / name) for name in before} == manifest["files"]
        self.preserved()
        assert database_snapshot(data) == snapshot
        self.checked("closed manually installed version is identified correctly; failed new executable after database damage restores both EXEs, all database tables, config and attachment")
        self.stop_service()
        self.spawn(self.root / "SunYu_ERP.exe", [], "restart-final")
        self.health(self.args.version)
        self.preserved()
        self.checked("restored version restarts and retains business values and login session")
        self.update(self.manifest, self.archive, "idle", apply=False)
        saved_status = (self.root / ".updates/status.json").read_bytes()
        requested_job = failed_install["job_id"]
        previous = self.client.get("/api/system/updates", params={"job_id": requested_job})
        assert previous.status_code == 200, previous.text
        for key in ("job_id", "phase", "error", "message"):
            assert previous.json()[key] == failed_install[key], previous.text
        assert previous.json()["current_version"] == self.args.version
        assert not previous.json()["busy"] and not previous.json()["recovery_required"]
        replay = self.client.post("/api/system/updates/install", json={"job_id": requested_job})
        assert replay.status_code == 202, replay.text
        assert replay.json()["job_id"] == requested_job and replay.json()["phase"] == "failed"
        assert (self.root / ".updates/status.json").read_bytes() == saved_status
        self.checked("completed installation remains queryable after a later check; retrying its request ID does not dispatch another installer")
        work = self.root / ".updates/work"
        assert not list(work.rglob("package.zip")) and not list(work.rglob("stage"))
        assert not list(work.iterdir()), list(work.iterdir())
        backup = list((self.root / ".updates/backup").iterdir())
        assert len(backup) == 1 and (backup[0] / "snapshot.json").is_file(), backup
        self.preserved()
        self.checked("next check removes managed download/staging/work files, retains only the latest rollback backup and preserves unrelated files")
        self.report["main_sha256"] = manifest["files"]["SunYu_ERP.exe"]
        self.report["updater_sha256"] = manifest["files"]["update.exe"]
        self.report["database_tables_verified"] = len(snapshot)
        if self.args.check_official:
            response = self.client.post("/api/system/updates/check", json={})
            assert response.status_code == 202, response.text
            identifier = response.json()["job_id"]
            online = self.job(identifier, "idle")
            assert not online["update_available"]
            self.report["official_check"] = online
            self.checked("production update.exe checks the real official release without offering a downgrade")
        self.report["status"] = "passed"

    def stop_service(self) -> None:
        runtime_path = self.root / ".updates/runtime.json"
        if runtime_path.exists():
            runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
            if Path(runtime["executable"]).resolve() == (self.root / "SunYu_ERP.exe").resolve():
                shutdown = runtime_path.with_name("shutdown.json")
                shutdown.write_text(json.dumps({"instance_id": runtime["instance_id"]}), encoding="utf-8")
                def stopped():
                    try:
                        self.client.get("/api/health", timeout=0.5)
                    except httpx.HTTPError:
                        return True
                    raise AssertionError("service is still listening")
                wait_for(stopped, "graceful shutdown", 30)
                def exited():
                    assert not self.owned_processes(), "owned processes have not exited"
                wait_for(exited, "owned process exit", 30)
                return
        for child in self.children:
            if child.poll() is None:
                subprocess.run(["taskkill.exe", "/PID", str(child.pid), "/T", "/F"],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def close(self) -> None:
        try:
            self.stop_service()
            self.report["owned_active_processes"] = len(self.owned_processes())
            assert self.report["owned_active_processes"] == 0
        except BaseException as error:
            self.report.update(status="failed", cleanup_error=repr(error))
            raise
        finally:
            if self.client:
                self.client.close()
            for log in self.logs:
                log.close()
            self.save()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--legacy", type=Path, required=True)
    for name in ("test-updater", "old-updater", "failure-updater", "failure-exe"):
        parser.add_argument(f"--{name}", type=Path)
    parser.add_argument("--check-official", action="store_true")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Windows native verification only")
    harness = Harness(args)
    try:
        harness.verify()
    except BaseException as error:
        harness.report.update(status="failed", error=repr(error))
        raise
    finally:
        harness.close()


if __name__ == "__main__":
    main()
