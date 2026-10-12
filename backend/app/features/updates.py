from __future__ import annotations

import ipaddress
import os
from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.app.features.auth import require_authenticated_session
from updater.manifest import MAX_ARCHIVE_BYTES, PackageError
from updater.service import UpdateError, UpdateService

_INSTALL_BLOCK_MESSAGES = {
    "unsupported_runtime": "当前运行方式不支持模块化更新，请使用完整安装包。",
    "not_supervised": (
        "当前服务未通过启动器运行，请使用完整安装目录中的 SunYu_ERP.exe 启动后重试。"
    ),
    "client_unavailable": (
        "无法确认此连接的来源，请在运行服务的电脑上直接访问 127.0.0.1，"
        "并检查本机代理设置。"
    ),
    "non_loopback_peer": (
        "此连接未被识别为本机连接，请在运行服务的电脑上使用 127.0.0.1 直接访问，"
        "并检查代理是否接管本机请求。"
    ),
    "non_loopback_host": (
        "当前访问地址不是本机地址，请在服务电脑上使用 127.0.0.1 或 localhost 访问后重试。"
    ),
}


def _loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def install_block_reason(request: Request, service: UpdateService | None) -> str | None:
    # 只使用 ASGI transport 提供的 peer；生产入口必须 proxy_headers=False。
    if not service:
        return "unsupported_runtime"
    if os.environ.get("SUNYU_SUPERVISED") != "1":
        return "not_supervised"
    if not request.client:
        return "client_unavailable"
    if not _loopback(request.client.host):
        return "non_loopback_peer"
    if request.url.hostname != "localhost" and not _loopback(request.url.hostname):
        return "non_loopback_host"
    return None


def can_install(request: Request, service: UpdateService | None) -> bool:
    return install_block_reason(request, service) is None


def _origin(value: str) -> tuple[str, str | None, int]:
    url = urlsplit(value)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username
        or url.password
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
    ):
        raise ValueError("Invalid origin")
    return url.scheme, url.hostname, url.port or (443 if url.scheme == "https" else 80)


def require_same_origin(request: Request) -> None:
    try:
        if _origin(request.headers.get("origin", "")) != _origin(str(request.base_url)):
            raise ValueError("Origin differs")
        if request.headers.get("sec-fetch-site") not in {None, "same-origin", "none"}:
            raise ValueError("Cross-site request")
    except ValueError:
        raise HTTPException(403, "更新操作只接受同源请求。") from None


def create_updates_router(get_session_secret: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/system/updates", tags=["updates"])

    def require_session(request: Request, secret: str = Depends(get_session_secret)):
        require_authenticated_session(request, secret)

    router.dependencies.append(Depends(require_session))

    def service_for(request: Request) -> UpdateService:
        service = request.app.state.update_service
        if service is None:
            raise HTTPException(409, _INSTALL_BLOCK_MESSAGES["unsupported_runtime"])
        return service

    def local_service(request: Request) -> UpdateService:
        service = service_for(request)
        require_same_origin(request)
        reason = install_block_reason(request, service)
        if reason is not None:
            raise HTTPException(403, _INSTALL_BLOCK_MESSAGES[reason])
        return service

    def snapshot(request: Request):
        service = request.app.state.update_service
        reason = install_block_reason(request, service)
        if service is None:
            return {
                "supported": False,
                "can_install": False,
                "install_block_reason": reason,
                "current": {"backend": None, "frontend": None},
                "frontend_version": None,
                "latest": None,
                "preferences": {"auto_check": True, "ignored_version": None},
                "job": None,
            }
        return {
            **service.status(reason is None),
            "install_block_reason": reason,
        }

    def execute(operation):
        try:
            operation()
        except (UpdateError, PackageError, ValueError) as error:
            raise HTTPException(409, str(error)) from error

    async def payload(request: Request):
        try:
            value = await request.json()
        except (ValueError, UnicodeError):
            raise HTTPException(422, "请求需要有效 JSON。") from None
        if not isinstance(value, dict):
            raise HTTPException(422, "请求需要 JSON 对象。")
        return value

    @router.get("")
    def status(request: Request):
        return snapshot(request)

    @router.post("/check", status_code=202)
    def check(request: Request):
        service = service_for(request)
        require_same_origin(request)
        execute(service.start_check)
        return snapshot(request)

    @router.post("/download", status_code=202)
    async def download(request: Request):
        service = local_service(request)
        value = await payload(request)
        if set(value) != {"component"}:
            raise HTTPException(422, "只接受 component 参数。")
        execute(lambda: service.start_download(value["component"]))
        return snapshot(request)

    @router.post("/install", status_code=202)
    async def install(request: Request):
        service = local_service(request)
        value = await payload(request)
        if set(value) != {"component"}:
            raise HTTPException(422, "只接受 component 参数。")
        execute(lambda: service.start_install(value["component"]))
        return snapshot(request)

    @router.post("/import", status_code=202)
    async def import_package(request: Request):
        service = local_service(request)
        # 在 multipart 解析前检查鉴权；按流限制整个请求避免无界落盘。
        from starlette.datastructures import UploadFile

        total = 0
        chunks = []
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_ARCHIVE_BYTES + 1024 * 1024:
                raise HTTPException(413, "更新包超过大小限制。")
            chunks.append(chunk)
        request._body = b"".join(chunks)
        async with request.form(
            max_files=1, max_fields=0, max_part_size=MAX_ARCHIVE_BYTES
        ) as form:
            upload = form.get("file")
            if len(form) != 1 or not isinstance(upload, UploadFile):
                raise HTTPException(422, "请选择一个 ZIP 更新包。")
            data = await upload.read(MAX_ARCHIVE_BYTES + 1)
            if len(data) > MAX_ARCHIVE_BYTES:
                raise HTTPException(413, "更新包超过大小限制。")
            execute(lambda: service.start_import(data))
        return snapshot(request)

    @router.patch("/preferences")
    async def preferences(request: Request):
        service = local_service(request)
        value = await payload(request)
        execute(lambda: service.update_preferences(value))
        return snapshot(request)

    return router
