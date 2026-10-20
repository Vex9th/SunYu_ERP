from __future__ import annotations

import importlib
import io
import json
import zipfile
from pathlib import Path
from urllib.parse import parse_qs

import pytest


@pytest.fixture
def publisher(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / ".github/scripts"))
    return importlib.import_module("publish_lanzou")


def test_cookie_expiry_logs_in_once_and_consumes_auth_bridge(publisher, monkeypatch):
    calls = []

    class Session:
        def __init__(self, cookie=""):
            self.logged_in = False

        def request(self, url, data=None, content_type=""):
            calls.append(url.split("?")[0])
            if url.endswith("/accounts.php") and data:
                form = parse_qs(data.decode())
                assert form["task"] == ["uselogin"]
                assert form["username"] == ["test-user"]
                assert form["password"] == ["test-password"]
                return b'{"zt":1,"msgs":"https://pc.woozooo.com/acc.php?t=ephemeral"}'
            if "/acc.php?" in url:
                self.logged_in = True
                return b"login bridge"
            if self.logged_in:
                return b"data:{'task':5,'folder_id':folder_id,'vei':'dynamic'}"
            return b"login required"

    monkeypatch.setattr(publisher, "Session", Session)
    result = publisher.Publisher("expired", "test-user", "test-password")
    assert result.vei == "dynamic"
    assert calls.count("https://accounts.woozooo.com/accounts.php") == 2
    assert calls.count("https://pc.woozooo.com/acc.php") == 1


def test_login_refuses_third_party_bridge_without_sending_credentials(publisher, monkeypatch):
    calls = []

    class Session:
        def __init__(self, cookie=""):
            pass

        def request(self, url, data=None, content_type=""):
            calls.append(url)
            if data:
                return b'{"zt":1,"msgs":"https://evil.example/steal"}'
            return b"login required"

    monkeypatch.setattr(publisher, "Session", Session)
    with pytest.raises(RuntimeError, match="自动登录失败"):
        publisher.Publisher("", "test", "test-password")
    assert all("evil.example" not in url for url in calls)


def test_rejected_login_is_attempted_once(publisher, monkeypatch):
    posts = []

    class Session:
        def __init__(self, cookie=""):
            pass

        def request(self, url, data=None, content_type=""):
            if data:
                posts.append(url)
                return b'{"zt":0,"msgs":"verification required"}'
            return b"login required"

    monkeypatch.setattr(publisher, "Session", Session)
    with pytest.raises(RuntimeError, match="人工处理"):
        publisher.Publisher("expired", "test", "test-password")
    assert posts == ["https://accounts.woozooo.com/accounts.php"]


def test_valid_cookie_does_not_send_account_credentials(publisher, monkeypatch):
    class Session:
        def __init__(self, cookie=""):
            assert cookie == "valid-cookie"

        def request(self, url, data=None, content_type=""):
            assert url == publisher.ORIGIN + publisher.PAGE
            assert data is None
            return b"data:{'task':5,'vei':'valid'}"

    monkeypatch.setattr(publisher, "Session", Session)
    assert publisher.Publisher("valid-cookie", "test", "test-password").vei == "valid"


def test_manifest_uses_safe_versioned_archive_name(publisher):
    payload = publisher.make_manifest({"version": "1.2.8"}, "2026102001.zip")
    with zipfile.ZipFile(io.BytesIO(payload)) as z:
        assert z.namelist() == ["update-manifest-singlefile.json"]
        assert json.loads(z.read(z.namelist()[0]))["lanzou_archive"] == "2026102001.zip"
    for bad in ("../Data/config.json", "config.json", "https://example.com/a.zip"):
        with pytest.raises(ValueError):
            publisher.make_manifest({}, bad)


def test_upload_order_and_duplicate_release_preserved(publisher, monkeypatch, tmp_path):
    uploaded = []
    metadata = {"version": "1.2.8", "archive": {"sha256": "a" * 64}}
    monkeypatch.setattr(publisher, "prepare", lambda _: (metadata, b"verified archive"))

    class Publisher:
        def __init__(self, *args):
            pass

        def files(self):
            return []

        def upload(self, name, payload):
            uploaded.append(name)
            return "iid"

    monkeypatch.setattr(publisher, "Publisher", Publisher)
    publisher.publish(tmp_path, tmp_path / "out")
    assert len(uploaded) == 2
    assert uploaded[0].endswith(".zip")
    assert uploaded[1] == "SunERP_v1.2.8_manifest.zip"
    monkeypatch.setattr(Publisher, "files", lambda _: [{"name_all": uploaded[-1]}])
    publisher.publish(tmp_path, tmp_path / "already-published")
    assert len(uploaded) == 2
    assert not (tmp_path / "already-published").exists()


def test_prepare_rejects_customer_files_even_when_archive_hash_matches(publisher, tmp_path):
    import hashlib
    archive = tmp_path / publisher.ARCHIVE
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("Data/customer.sqlite", b"must not upload")
    metadata = {
        "format": 1, "application": "SunYu_ERP", "version": "1.2.8",
        "archive": {
            "url": "https://github.com/Vex9th/SunYu_ERP/releases/download/v1.2.8/SunYu_ERP-windows-x64.zip",
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        },
    }
    (tmp_path / publisher.MANIFEST).write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="非预期文件"):
        publisher.prepare(tmp_path)
