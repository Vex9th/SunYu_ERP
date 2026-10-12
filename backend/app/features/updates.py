from __future__ import annotations

import ipaddress
import os
from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.app.features.auth import require_authenticated_session
from updater.manifest import MAX_ARCHIVE_BYTES, PackageError
from updater.service import UpdateError, UpdateService


def _loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def can_install(request: Request, service: UpdateService | None) -> bool:
    # 只使用 ASGI transport 提供的 peer；生产入口必须 proxy_headers=False。
    return bool(
        service
        and os.environ.get("SUNYU_SUPERVISED") == "1"
        and request.client
        and _loopback(request.client.host)
        and (request.url.hostname == "localhost" or _loopback(request.url.hostname))
    )


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
            raise HTTPException(409, "当前运行方式不支持模块化更新，请使用完整安装包。")
        return service

    def local_service(request: Request) -> UpdateService:
        service = service_for(request)
        require_same_origin(request)
        if not can_install(request, service):
            raise HTTPException(403, "请在运行本程序的电脑上登录后操作更新。")
        return service

    def snapshot(request: Request):
        service = request.app.state.update_service
        if service is None:
            return {
                "supported": False,
                "can_install": False,
                "current": {"backend": None, "frontend": None},
                "frontend_version": None,
                "latest": None,
                "preferences": {"auto_check": True, "ignored_version": None},
                "job": None,
            }
        return service.status(can_install(request, service))

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
