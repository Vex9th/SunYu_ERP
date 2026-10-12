from __future__ import annotations

import hashlib
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path

import certifi

from updater.manifest import (
    MAX_ARCHIVE_BYTES,
    PackageError,
    parse_json,
    stage_package,
    verify_staged,
)
from updater.storage import read_installation, read_json, validate_version, write_json

RELEASE_API = "https://api.github.com/repos/Vex9th/SunYu_ERP/releases/latest"
_DOWNLOAD_PREFIX = "/Vex9th/SunYu_ERP/releases/download/"
_ACTIVE = {"checking", "downloading", "installing"}
_CATALOG_LIMIT = 2 * 1024 * 1024


class UpdateError(ValueError):
    pass


def official_asset_url(value: object) -> str:
    if not isinstance(value, str):
        raise UpdateError("Invalid official asset URL")
    url = urllib.parse.urlsplit(value)
    if (
        url.scheme != "https"
        or url.hostname != "github.com"
        or url.port not in {None, 443}
        or url.username
        or url.password
        or url.query
        or url.fragment
        or not url.path.startswith(_DOWNLOAD_PREFIX)
        or len(url.path.removeprefix(_DOWNLOAD_PREFIX).split("/")) != 2
        or any(
            part in {"", ".", ".."}
            for part in url.path.removeprefix(_DOWNLOAD_PREFIX).split("/")
        )
    ):
        raise UpdateError("Update assets must belong to the official GitHub repository")
    return value


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port not in {None, 443}
            or url.hostname
            not in {
                "github.com",
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
            }
        ):
            raise UpdateError("Refused non-GitHub download redirect")
        if url.hostname == "github.com":
            official_asset_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch_official(url: str, limit: int) -> bytes:
    if url != RELEASE_API:
        official_asset_url(url)
    # 保留系统/用户信任的证书，同时补充公共根证书，兼容精简或未更新的系统。
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    opener = urllib.request.build_opener(
        _OfficialRedirect(),
        urllib.request.HTTPSHandler(context=context),
    )
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "SunYu-ERP-Updater/1",
            "Accept": "application/vnd.github+json"
            if url == RELEASE_API
            else "application/octet-stream",
        },
    )
    deadline = time.monotonic() + 60
    try:
        with opener.open(request, timeout=15) as response:
            if (
                response.headers.get("Content-Length")
                and int(response.headers["Content-Length"]) > limit
            ):
                raise UpdateError("Download exceeds size limit")
            body = bytearray()
            while True:
                if time.monotonic() > deadline:
                    raise UpdateError("Download timed out")
                chunk = response.read(min(1024 * 1024, limit + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > limit:
                    raise UpdateError("Download exceeds size limit")
            return bytes(body)
    except (urllib.error.URLError, ssl.SSLCertVerificationError) as error:
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise UpdateError(
                f"无法验证更新服务器 {urllib.parse.urlsplit(url).hostname} 的 HTTPS 证书。"
                "请检查系统时间、系统根证书，以及代理或安全软件的 HTTPS 检查设置；"
                "可改用可信网络，或下载官方离线更新包。"
                f"技术详情：{reason}"
            ) from error
        raise


def validate_catalog(value: object) -> dict:
    if (
        not isinstance(value, dict)
        or type(value.get("format")) is not int
        or value["format"] != 1
    ):
        raise UpdateError("Unsupported update catalog")
    version = validate_version(value.get("version"))
    notes = value.get("notes", "")
    components = value.get("components")
    if (
        not isinstance(notes, str)
        or len(notes) > 50000
        or not isinstance(components, dict)
        or not components
    ):
        raise UpdateError("Invalid update catalog")
    normalized = {}
    for component, entry in components.items():
        if component not in {"frontend", "backend"} or not isinstance(entry, dict):
            raise UpdateError("Unknown update component")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise UpdateError("Invalid archive digest")
        normalized[component] = {
            "version": validate_version(entry.get("version")),
            "url": official_asset_url(entry.get("url")),
            "sha256": digest.lower(),
        }
    return {"version": version, "notes": notes, "components": normalized}


class UpdateService:
    def __init__(
        self, root: Path, *, fetch: Callable[[str, int], bytes] = fetch_official
    ):
        self.root = Path(root)
        self.directory = self.root / ".updates"
        self.directory.mkdir(parents=True, exist_ok=True)
        read_installation(self.root)
        self._fetch = fetch
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        job = self._job()
        if job and job.get("status") in {"checking", "downloading"}:
            self._save_job(
                {**job, "status": "failed", "message": "上次更新任务已中断，请重试。"}
            )
        elif (
            job
            and job.get("status") == "installing"
            and job.get("component") == "frontend"
        ):
            installed = read_installation(self.root)["frontend"] == job.get("version")
            self._save_job(
                {
                    **job,
                    "status": "success" if installed else "failed",
                    "message": "前端切换已完成。"
                    if installed
                    else "前端切换已中断，请重试。",
                }
            )
        elif (
            job
            and job.get("status") == "installing"
            and not (self.directory / "pending.json").exists()
            and not (self.directory / "transaction.json").exists()
        ):
            self._save_job(
                {
                    **job,
                    "status": "failed",
                    "message": "安装校验已中断，尚未交接后端更新，请重试。",
                }
            )

    def _job(self):
        return read_json(self.directory / "job.json", None)

    def _save_job(self, value):
        write_json(self.directory / "job.json", value)

    def status(self, can_install: bool = False) -> dict:
        with self._lock:
            installed = read_installation(self.root)
            return {
                "supported": True,
                "can_install": can_install,
                "current": {key: installed[key] for key in ("backend", "frontend")},
                "frontend_version": installed["frontend"],
                "latest": read_json(self.directory / "latest.json", None),
                "preferences": read_json(
                    self.directory / "preferences.json",
                    {"auto_check": True, "ignored_version": None},
                ),
                "job": self._job(),
            }

    def _ensure_idle(self):
        job = self._job()
        if (
            (self._worker and self._worker.is_alive())
            or (job and job.get("status") in _ACTIVE)
            or (self.directory / "pending.json").exists()
            or (self.directory / "maintenance").exists()
        ):
            raise UpdateError("已有更新任务正在进行，请等待完成。")

    def _start(self, status, component, version, operation):
        with self._lock:
            self._ensure_idle()
            job = {
                "id": uuid.uuid4().hex,
                "status": status,
                "component": component,
                "version": version,
                "message": "",
            }
            self._save_job(job)

            def run():
                try:
                    result = operation()
                    if result is not None:
                        with self._lock:
                            self._save_job({**job, **result})
                except Exception as error:  # noqa: BLE001 - persist failures at worker boundary
                    with self._lock:
                        self._save_job(
                            {
                                **job,
                                "status": "failed",
                                "message": str(error)[:1000] or type(error).__name__,
                            }
                        )

            self._worker = threading.Thread(
                target=run, name="sunyu-update", daemon=True
            )
            self._worker.start()
            return job

    def start_check(self):
        def check():
            release = parse_json(self._fetch(RELEASE_API, _CATALOG_LIMIT))
            if not isinstance(release, dict) or not isinstance(
                release.get("assets"), list
            ):
                raise UpdateError("Invalid GitHub release response")
            assets = [
                asset
                for asset in release["assets"]
                if isinstance(asset, dict)
                and asset.get("name") == "update-manifest.json"
            ]
            if len(assets) != 1:
                raise UpdateError("此正式版本未提供模块化更新包，请使用完整安装包。")
            catalog = validate_catalog(
                parse_json(
                    self._fetch(
                        official_asset_url(assets[0].get("browser_download_url")),
                        _CATALOG_LIMIT,
                    )
                )
            )
            write_json(self.directory / "latest.json", catalog)
            return {"status": "success", "message": "更新检查完成。"}

        return self._start("checking", None, None, check)

    def start_download(self, component):
        if component not in ("frontend", "backend"):
            raise UpdateError("Unknown component")
        latest = read_json(self.directory / "latest.json", None)
        if not latest or component not in latest.get("components", {}):
            raise UpdateError("请先检查可用更新。")
        entry = validate_catalog({"format": 1, **latest})["components"][component]

        def download():
            data = self._fetch(entry["url"], MAX_ARCHIVE_BYTES)
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise PackageError("更新包 SHA256 不匹配。")
            # 下载包身份必须与目录一致，不能让前端按钮导入后端包。
            manifest = stage_package(
                self.root,
                data,
                expected_component=component,
                expected_version=entry["version"],
                reuse_verified=True,
            )
            write_json(self.directory / "ready.json", manifest)
            return {"status": "ready", "message": "更新包已校验，等待手动安装。"}

        return self._start("downloading", component, entry["version"], download)

    def start_import(self, data: bytes):
        def import_package():
            manifest = stage_package(self.root, data, reuse_verified=True)
            write_json(self.directory / "ready.json", manifest)
            return {
                "status": "ready",
                "component": manifest["component"],
                "version": manifest["version"],
                "message": "离线更新包已校验，等待手动安装。",
            }

        return self._start("downloading", None, None, import_package)

    def start_install(self, component):
        if component not in ("frontend", "backend"):
            raise UpdateError("Unknown component")
        with self._lock:
            self._ensure_idle()
            ready = read_json(self.directory / "ready.json", None)
            if not ready or ready.get("component") != component:
                raise UpdateError("没有对应的已校验更新包。")
            version = ready["version"]
            if read_installation(self.root)[component] == version:
                raise UpdateError("此版本已安装。")

            def install():
                verify_staged(self.root, component, version)
                if component == "backend":
                    job = self._job()
                    write_json(
                        self.directory / "pending.json",
                        {"id": job["id"], "component": component, "version": version},
                    )
                    # pending 发布后 job 完全交由 supervisor；避免覆盖它的结果。
                    return None
                installed = read_installation(self.root)
                installed["frontend"] = version
                write_json(self.root / "installation.json", installed)
                return {
                    "status": "success",
                    "message": "前端更新已安装，刷新页面后生效。",
                }

            return self._start("installing", component, version, install)

    def update_preferences(self, changes):
        if (
            not isinstance(changes, dict)
            or not changes
            or not set(changes) <= {"auto_check", "ignored_version"}
        ):
            raise UpdateError("Invalid update preferences")
        if "auto_check" in changes and type(changes["auto_check"]) is not bool:
            raise UpdateError("auto_check must be boolean")
        if changes.get("ignored_version") is not None:
            validate_version(changes["ignored_version"])
        with self._lock:
            previous = self.status()["preferences"]
            write_json(self.directory / "preferences.json", {**previous, **changes})
