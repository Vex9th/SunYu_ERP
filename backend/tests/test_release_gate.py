from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / '.github/scripts/release_gate.py'
SHA = 'a' * 40


@pytest.fixture
def gate():
    spec = importlib.util.spec_from_file_location('release_gate', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def published_release():
    return {'draft': False, 'assets': [{'name': 'SunYu_ERP-windows-x64.zip', 'size': 123, 'state': 'uploaded'}]}


def test_existing_complete_release_is_a_successful_noop(gate):
    assert gate.classify_release('v1.2.2', SHA, SHA, published_release()) == 'published'


def test_new_version_and_candidate_can_build(gate):
    assert gate.classify_release('v1.2.3', SHA, None, None) == 'new'
    assert gate.classify_release('', SHA, None, None) == 'candidate'


def test_partial_draft_can_resume_after_failed_upload(gate):
    assert gate.classify_release('v1.2.3', SHA, SHA, {'draft': True, 'assets': []}) == 'draft'


def test_tag_for_other_commit_is_never_overwritten(gate):
    with pytest.raises(ValueError, match='commit'):
        gate.classify_release('v1.2.3', SHA, 'b' * 40, published_release())


@pytest.mark.parametrize('tag', ['latest', 'v1.2.3; echo hello', '../v1.2.3'])
def test_invalid_version_is_rejected_before_any_side_effect(gate, tag):
    with pytest.raises(ValueError, match='version'):
        gate.classify_release(tag, SHA, None, None)


def test_incomplete_published_release_is_not_silently_accepted(gate):
    with pytest.raises(ValueError, match='asset'):
        gate.classify_release('v1.2.3', SHA, SHA, {'draft': False, 'assets': []})


def test_release_without_expected_tag_is_rejected(gate):
    with pytest.raises(ValueError, match='tag'):
        gate.classify_release('v1.2.3', SHA, None, published_release())


@pytest.mark.parametrize('status', [403, 500])
def test_api_failure_is_not_mistaken_for_missing_release(gate, monkeypatch, status):
    def failure(*args, **kwargs):
        raise HTTPError('https://api.github.com/', status, 'failure', {}, None)
    monkeypatch.setattr(gate, 'urlopen', failure)
    with pytest.raises(HTTPError):
        gate.read_release('example/repo', 'v1.2.3', 'test-token')


def test_only_404_means_release_does_not_exist(gate, monkeypatch):
    def missing(*args, **kwargs):
        if '?per_page=' in args[0].full_url:
            return io.BytesIO(b'[]')
        raise HTTPError('https://api.github.com/', 404, 'not found', {}, None)
    monkeypatch.setattr(gate, 'urlopen', missing)
    assert gate.read_release('example/repo', 'v1.2.3', 'test-token') is None


def test_draft_can_resume_before_github_creates_its_tag(gate):
    draft = {'draft': True, 'assets': [], 'target_commitish': SHA}
    assert gate.classify_release('v1.2.3', SHA, None, draft) == 'draft'


def test_unpublished_draft_is_discovered_when_tag_endpoint_returns_404(gate, monkeypatch):
    draft = {'tag_name': 'v1.2.3', 'draft': True, 'target_commitish': SHA, 'assets': []}
    def request(url, **kwargs):
        if '/releases/tags/' in url.full_url:
            raise HTTPError(url.full_url, 404, 'not published', {}, None)
        return io.BytesIO(json.dumps([draft]).encode())
    monkeypatch.setattr(gate, 'urlopen', request)
    assert gate.read_release('example/repo', 'v1.2.3', 'test-token') == draft


def test_draft_discovery_checks_later_pages(gate, monkeypatch):
    draft = {'tag_name': 'v1.2.3', 'draft': True, 'target_commitish': SHA, 'assets': []}
    def request(url, **kwargs):
        if '/releases/tags/' in url.full_url:
            raise HTTPError(url.full_url, 404, 'not published', {}, None)
        payload = [draft] if 'page=2' in url.full_url else [{'tag_name': 'v0.0.1'}] * 100
        return io.BytesIO(json.dumps(payload).encode())
    monkeypatch.setattr(gate, 'urlopen', request)
    assert gate.read_release('example/repo', 'v1.2.3', 'test-token') == draft
