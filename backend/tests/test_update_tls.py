from __future__ import annotations

import ssl
import urllib.error
import urllib.request
from pathlib import Path

import certifi
import pytest

from updater import service

FIXTURES = Path(__file__).with_name("fixtures") / "update_tls"


def updater_context(monkeypatch):
    """截取下载器实际使用的 TLS 上下文，不发起公网请求。"""
    contexts = []

    class CaptureHTTPS(urllib.request.HTTPSHandler):
        def __init__(self, *, context):
            contexts.append(context)
            super().__init__(context=context)

    def stop_before_network(*args, **kwargs):
        raise OSError("test: network intentionally stopped")

    monkeypatch.setattr(urllib.request, "HTTPSHandler", CaptureHTTPS)
    monkeypatch.setattr(urllib.request.OpenerDirector, "open", stop_before_network)
    with pytest.raises(OSError, match="intentionally stopped"):
        service.fetch_official(service.RELEASE_API, 1024)
    assert len(contexts) == 1
    return contexts[0]


def handshake(context, hostname="api.github.com"):
    """用仅供测试的证书完成真实 TLS 握手，无监听端口和外部网络。"""
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(FIXTURES / "server.pem", FIXTURES / "server.key")
    client_in, client_out = ssl.MemoryBIO(), ssl.MemoryBIO()
    server_in, server_out = ssl.MemoryBIO(), ssl.MemoryBIO()
    client = context.wrap_bio(client_in, client_out, server_hostname=hostname)
    server = server_context.wrap_bio(server_in, server_out, server_side=True)
    completed = set()
    for _ in range(20):
        for side, source, destination in (
            (client, client_out, server_in), (server, server_out, client_in),
        ):
            try:
                side.do_handshake()
                completed.add(side)
            except ssl.SSLWantReadError:
                pass
            if source.pending:
                destination.write(source.read())
        if len(completed) == 2:
            return
    raise AssertionError("TLS handshake did not finish")


def test_updater_uses_bundled_ca_when_system_store_is_empty(monkeypatch):
    monkeypatch.setattr(ssl.SSLContext, "load_default_certs", lambda *args: None)
    monkeypatch.setattr(certifi, "where", lambda: str(FIXTURES / "ca.pem"))
    context = updater_context(monkeypatch)
    handshake(context)
    assert context.check_hostname
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_updater_preserves_system_trust_when_adding_public_roots(monkeypatch):
    def system_roots(context, *args):
        context.load_verify_locations(cafile=FIXTURES / "ca.pem")

    monkeypatch.setattr(ssl.SSLContext, "load_default_certs", system_roots)
    handshake(updater_context(monkeypatch))


def test_updater_rejects_untrusted_certificates(monkeypatch):
    monkeypatch.setattr(ssl.SSLContext, "load_default_certs", lambda *args: None)
    with pytest.raises(ssl.SSLCertVerificationError):
        handshake(updater_context(monkeypatch))


def test_updater_rejects_wrong_hostname_even_with_trusted_ca(monkeypatch):
    monkeypatch.setattr(certifi, "where", lambda: str(FIXTURES / "ca.pem"))
    with pytest.raises(ssl.SSLCertVerificationError, match="[Hh]ostname mismatch"):
        handshake(updater_context(monkeypatch), "github.com")


@pytest.mark.parametrize("wrapped", [True, False])
def test_certificate_failure_explains_recovery_and_preserves_cause(monkeypatch, wrapped):
    certificate_error = ssl.SSLCertVerificationError(1, "unable to get local issuer certificate")
    error = urllib.error.URLError(certificate_error) if wrapped else certificate_error

    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", fail)
    with pytest.raises(service.UpdateError) as caught:
        service.fetch_official(service.RELEASE_API, 1024)
    assert caught.value.__cause__ is error
    assert "api.github.com" in str(caught.value)
    assert "证书" in str(caught.value)
    assert "代理" in str(caught.value)
    assert "离线" in str(caught.value)
    assert "unable to get local issuer certificate" in str(caught.value)
