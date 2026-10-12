"""只读发布预检：完整版本跳过，草稿可续传，不覆盖其他提交的标签。"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ASSET = 'SunYu_ERP-windows-x64.zip'
VERSION = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+')


def classify_release(tag: str, commit: str, tag_commit: str | None, release: dict | None) -> str:
    if not tag:
        return 'candidate'
    if not VERSION.fullmatch(tag):
        raise ValueError('Invalid version: expected vMAJOR.MINOR.PATCH')
    if tag_commit is not None and tag_commit != commit:
        raise ValueError('Release tag belongs to another commit; refusing to overwrite it')
    if release is None:
        return 'new'
    if release['draft']:
        if tag_commit is None and release.get('target_commitish') != commit:
            raise ValueError('Draft release target commit cannot be verified')
        return 'draft'
    if tag_commit is None:
        raise ValueError('Existing release has no matching fetched tag')
    if not any(asset['name'] == ASSET and asset.get('state') == 'uploaded'
               and asset.get('size', 0) > 0 for asset in release['assets']):
        raise ValueError('Published release has no complete Windows asset; inspect it before retrying')
    return 'published'


def read_release(repo: str, tag: str, token: str) -> dict | None:
    def read(path: str):
        request = Request(
            f'https://api.github.com/repos/{repo}/{path}',
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'},
        )
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    try:
        return read(f'releases/tags/{tag}')
    except HTTPError as error:
        if error.code != 404:
            raise
    # 按 tag 查询只返回已发布版本；上传中断留下的草稿需从认证列表发现。
    page = 1
    while True:
        releases = read(f'releases?per_page=100&page={page}')
        for release in releases:
            if release['tag_name'] == tag:
                return release
        if len(releases) < 100:
            return None
        page += 1


def main() -> None:
    tag = os.environ.get('RELEASE_TAG', '')
    commit = os.environ['GITHUB_SHA']
    # 在任何网络访问前校验版本号，后续通过环境变量和独立参数传递。
    classify_release(tag, commit, None, None)
    tag_commit = None
    release = None
    if tag:
        result = subprocess.run(
            ['git', 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}'],
            text=True, capture_output=True, check=False,
        )
        if result.returncode == 0:
            tag_commit = result.stdout.strip()
        elif result.returncode != 128:
            raise RuntimeError('Cannot inspect release tag')
        release = read_release(os.environ['GITHUB_REPOSITORY'], tag, os.environ['GH_TOKEN'])
    state = classify_release(tag, commit, tag_commit, release)
    with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8') as output:
        output.write(f'state={state}\nbuild_needed={str(state != "published").lower()}\n')
    print(f'Release gate: {tag or "candidate"} / {state} / {commit}')
    if state == 'published':
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as summary:
            summary.write(f'{tag} 已发布且 Windows 安装包完整，本次跳过重复构建和发布。\n')


if __name__ == '__main__':
    main()
