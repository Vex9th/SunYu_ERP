"""向指定 SunERP 蓝奏目录发布正式包；登录凭据仅从环境变量读取。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import urllib.parse
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from lanzou_http import Session, allowed

ORIGIN = "https://pc.woozooo.com"
PAGE = "/mydisk.php?item=files&action=index&u=502598"
FOLDER = "14123945"
MANIFEST = "update-manifest-singlefile.json"
ARCHIVE = "SunYu_ERP-windows-x64.zip"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")


def prepare(source: Path) -> tuple[dict, bytes]:
    """校验正式附件，既不遍历业务目录，也不读取真实配置。"""
    metadata = json.loads((source / MANIFEST).read_text("utf-8"))
    version = metadata.get("version", "")
    if (metadata.get("format") != 1 or metadata.get("application") != "SunYu_ERP"
            or not VERSION.fullmatch(version)
            or metadata.get("archive", {}).get("url") !=
            f"https://github.com/Vex9th/SunYu_ERP/releases/download/v{version}/{ARCHIVE}"):
        raise ValueError("正式更新清单无效")
    archive = (source / ARCHIVE).read_bytes()
    if len(archive) > 100 * 1024 * 1024:
        raise ValueError("正式包超过当前蓝奏账号的 100 MiB 单文件上限")
    if hashlib.sha256(archive).hexdigest() != metadata["archive"]["sha256"]:
        raise ValueError("正式包 SHA256 与清单不一致")
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        expected = {"SunYu_ERP.exe", "update.exe", "start.bat", "README.md",
                    "LICENSE", "config.example.json"}
        if len(z.infolist()) != len(expected) or set(z.namelist()) != expected:
            raise ValueError("正式包包含非预期文件，拒绝上传")
        if set(metadata.get("files", {})) != {"SunYu_ERP.exe", "update.exe"}:
            raise ValueError("正式清单程序列表不正确")
        if sum(i.file_size for i in z.infolist()) > 512 * 1024 * 1024:
            raise ValueError("正式包展开体积异常")
        for name, digest in metadata["files"].items():
            if hashlib.sha256(z.read(name)).hexdigest() != digest:
                raise ValueError(f"{name} SHA256 不匹配")
    return metadata, archive


def make_manifest(metadata: dict, archive_name: str) -> bytes:
    if not re.fullmatch(r"[0-9]{10}\.zip", archive_name):
        raise ValueError("完整包名称必须为北京时间日期加两位序号.zip")
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(MANIFEST, json.dumps({**metadata, "lanzou_archive": archive_name},
                                      ensure_ascii=False))
    return result.getvalue()


class Publisher:
    def __init__(self, cookie: str, username: str = "", password: str = ""):
        self.session = Session(cookie)
        page = self.request(PAGE).decode("utf-8")
        token = self.token(page)
        if token is None and username and password:
            # 丢弃失效会话，只尝试一次账号登录，避免重试导致账号锁定。
            self.session = Session()
            self.login(username, password)
            token = self.token(self.request(PAGE).decode("utf-8"))
        if token is None:
            raise RuntimeError("蓝奏登录已失效，或需要人工验证码；请更新发布凭据")
        self.vei = token

    @staticmethod
    def token(page: str) -> str | None:
        token = re.search(r"""['"]task['"]\s*:\s*5\s*,[^}]*['"]vei['"]\s*:\s*['"]([^'"]+)""", page)
        return token[1] if token else None

    def login(self, username: str, password: str) -> None:
        endpoint = "https://accounts.woozooo.com/accounts.php"
        self.session.request(endpoint + "?action=login&ref=pc.woozooo.com")
        form = urllib.parse.urlencode({
            "task": "uselogin", "username": username,
            "password": password, "ref": "pc.woozooo.com",
        }).encode()
        result = json.loads(self.session.request(endpoint, form))
        bridge = result.get("msgs", "")
        if (str(result.get("zt")) != "1" or not isinstance(bridge, str)
                or not allowed(bridge)
                or urllib.parse.urlsplit(bridge).netloc != "pc.woozooo.com"
                or urllib.parse.urlsplit(bridge).path != "/acc.php"):
            raise RuntimeError("蓝奏自动登录失败或需要验证码，请人工处理后重试")
        # 鉴权跳转只在内存中消费，禁止输出带一次性令牌的地址。
        self.session.request(bridge)
        print("蓝奏会话已通过账号重新登录。")

    def request(self, path: str, data: bytes | None = None,
                content_type: str = "application/x-www-form-urlencoded") -> bytes:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("上传只允许访问固定蓝奏后台")
        # 上传 POST 不盲目重试；结果不明确时先检查目录，避免重复发布。
        return self.session.request(ORIGIN + path, data, content_type)

    def files(self) -> list[dict]:
        files = []
        for pg in range(1, 21):
            data = urllib.parse.urlencode({
                "task": "5", "folder_id": FOLDER, "pg": pg, "vei": self.vei,
            }).encode()
            result = json.loads(self.request("/doupload.php?uid=502598", data))
            code = str(result.get("zt"))
            if code == "2":
                return files
            if code != "1" or not isinstance(result.get("text"), list):
                raise RuntimeError("SunERP 目录读取失败，未上传文件")
            batch = result["text"]
            files.extend(batch)
            if len(batch) < 50:
                return files
        raise RuntimeError("目录超过 1000 个文件，未完成检查")

    def upload(self, name: str, payload: bytes) -> str:
        boundary = "SunYu" + uuid.uuid4().hex
        form = io.BytesIO()
        fields = {
            "task": "1", "vie": "2", "ve": "2", "id": uuid.uuid4().hex,
            "name": name, "type": "application/zip", "size": str(len(payload)),
            "folder_id_bb_n": FOLDER,
        }
        for key, value in fields.items():
            form.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        form.write(f'--{boundary}\r\nContent-Disposition: form-data; name="upload_file"; filename="{name}"\r\nContent-Type: application/zip\r\n\r\n'.encode())
        form.write(payload)
        form.write(f"\r\n--{boundary}--\r\n".encode())
        result = json.loads(self.request("/html5up.php", form.getvalue(),
                                        f"multipart/form-data; boundary={boundary}"))
        if str(result.get("zt")) != "1" or not result.get("text"):
            raise RuntimeError("蓝奏上传未确认成功，请检查目录后重试")
        item = result["text"][0]
        if item.get("name_all") != name or not re.fullmatch(r"i[A-Za-z0-9_-]+", item.get("f_id", "")):
            raise RuntimeError("蓝奏上传响应与预期文件不符")
        return item["f_id"]


def publish(source: Path, output: Path) -> None:
    metadata, archive = prepare(source)
    publisher = Publisher(os.environ.get("LANZOU_COOKIE", ""),
                          os.environ.get("LANZOU_USERNAME", ""),
                          os.environ.get("LANZOU_PASSWORD", ""))
    names = [item.get("name_all", item.get("name")) for item in publisher.files()]
    manifest_name = f"SunERP_v{metadata['version']}_manifest.zip"
    if manifest_name in names:
        # 不覆盖已发布版本；后续验证步骤仍会下载并比对本次正式附件。
        print(f"{manifest_name} 已存在，保留原文件并继续公开下载校验。")
        return
    day = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d")
    archive_name = next((f"{day}{i:02}.zip" for i in range(1, 100)
                         if f"{day}{i:02}.zip" not in names), None)
    if archive_name is None:
        raise RuntimeError("当日分发序号已满")
    output.mkdir(parents=True, exist_ok=False)
    manifest = make_manifest(metadata, archive_name)
    (output / archive_name).write_bytes(archive)
    (output / manifest_name).write_bytes(manifest)
    archive_id = publisher.upload(archive_name, archive)
    # 只有完整包响应确认成功后，才让客户端看到新版本清单。
    manifest_id = publisher.upload(manifest_name, manifest)
    receipt = {
        "version": metadata["version"], "folder": "https://urldown.lanzouw.com/b019w91rof",
        "archive_name": archive_name, "archive_id": archive_id,
        "manifest_id": manifest_id, "sha256": metadata["archive"]["sha256"],
    }
    (output / "upload-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", "utf-8")
    print(f"已上传 {archive_name}、{manifest_name}；等待公开下载校验。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        publish(args.source, args.output)
    except (OSError, ValueError, RuntimeError, KeyError, zipfile.BadZipFile) as error:
        # 不输出 Cookie、服务器原始返回或带参数的请求地址。
        print(f"蓝奏发布失败：{type(error).__name__}: {str(error).split('https://')[0]}")
        raise SystemExit(1) from None
