"""蓝奏发布端的受限 HTTP 会话；不执行网页脚本，不绕过验证码。"""
from __future__ import annotations

import base64
import gzip
import http.cookiejar
import re
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie

HOSTS = {"pc.woozooo.com", "accounts.woozooo.com"}
USER_AGENT = "Mozilla/5.0"


def allowed(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme == "https" and parsed.netloc in HOSTS
            and not parsed.fragment and not parsed.username)


def browser_cookie(page: str) -> str:
    argument = re.search(r"\barg1='([0-9A-Fa-f]{40})'", page)
    permutation = re.search(r"var m=\[([0-9a-fx,]+)\]", page)
    if not argument or not permutation:
        raise RuntimeError("蓝奏需要人工验证或浏览器校验格式已变化")
    positions = [int(i, 0) for i in permutation[1].split(",")]
    if sorted(positions) != list(range(1, 41)):
        raise RuntimeError("浏览器校验参数异常")
    key = None
    translate = str.maketrans(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    for value in re.findall(r"'([A-Za-z0-9+/=]+)'", page):
        try:
            decoded = base64.b64decode(value.translate(translate) + "===").decode("ascii")
        except (ValueError, UnicodeDecodeError):
            continue
        if re.fullmatch(r"[0-9a-f]{40}", decoded):
            key = bytes.fromhex(decoded)
    if key is None:
        raise RuntimeError("浏览器校验参数无效")
    value = bytes.fromhex("".join(argument[1][i - 1] for i in positions))
    return bytes(a ^ b for a, b in zip(value, key, strict=True)).hex()


class RestrictedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise RuntimeError("蓝奏登录跳转到站外，已拒绝发送凭据")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Session:
    def __init__(self, cookie: str = ""):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            RestrictedRedirect(), urllib.request.HTTPCookieProcessor(self.jar))
        if "\r" in cookie or "\n" in cookie:
            raise ValueError("登录 Cookie 格式无效")
        initial = SimpleCookie()
        initial.load(cookie)
        for name, value in initial.items():
            self.set_cookie("pc.woozooo.com", name, value.value)

    def set_cookie(self, host: str, name: str, value: str) -> None:
        self.jar.set_cookie(http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain=host, domain_specified=False, domain_initial_dot=False,
            path="/", path_specified=True, secure=True, expires=None, discard=True,
            comment=None, comment_url=None, rest={}))

    def request(self, url: str, data: bytes | None = None,
                content_type: str = "application/x-www-form-urlencoded") -> bytes:
        if not allowed(url):
            raise ValueError("发布会话只允许访问蓝奏登录和文件后台")
        for attempt in range(2):
            req = urllib.request.Request(url, data=data, headers={
                "User-Agent": USER_AGENT, "Content-Type": content_type,
            })
            with self.opener.open(req, timeout=180) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError("蓝奏后台响应过大")
                if response.headers.get("Content-Encoding") == "gzip":
                    # 限制解压大小，避免可信站点异常响应耗尽内存。
                    import io
                    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
                        raw = compressed.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError("蓝奏后台响应过大")
                if not raw.startswith(b"<html><script>var arg1="):
                    return raw
                if attempt:
                    raise RuntimeError("蓝奏浏览器校验失败")
                self.set_cookie(urllib.parse.urlsplit(response.url).hostname,
                                "acw_sc__v2", browser_cookie(raw.decode("utf-8")))
                # 仅站点明确返回前置 JS 校验时重发；业务请求未进入上传接口。
        raise RuntimeError("蓝奏请求失败")
