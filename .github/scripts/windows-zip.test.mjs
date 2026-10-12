import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractWindowsZip } from './windows-zip.mjs'

test('Windows ZIP extraction preserves Unicode paths and entries', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(process.env.SUNYU_ZIP_TEST_ROOT || os.tmpdir(), 'sunyu-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, "中文 空格 ' [源] 😀")
  const archive = path.join(root, "中文 空格 ' [包] 😀.zip")
  const destination = path.join(root, "中文 空格 ' [目标] 😀")
  await mkdir(source)
  await mkdir(destination)
  const filename = '中文 文件 😀.txt'
  await writeFile(path.join(source, filename), 'Unicode archive 内容')
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:SUNYU_ZIP_SOURCE, $env:SUNYU_ZIP_ARCHIVE)"
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, SUNYU_ZIP_SOURCE: source, SUNYU_ZIP_ARCHIVE: archive }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000,
  })
  extractWindowsZip(archive, destination)
  assert.deepEqual(await readdir(destination), [filename])
  assert.equal(await readFile(path.join(destination, filename), 'utf8'), 'Unicode archive 内容')
})

test('Windows ZIP extraction propagates invalid archive errors', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(process.env.SUNYU_ZIP_TEST_ROOT || os.tmpdir(), 'sunyu-zip-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archive = path.join(root, 'invalid.zip')
  const destination = path.join(root, 'output')
  await mkdir(destination)
  await writeFile(archive, 'invalid ZIP')
  assert.throws(() => extractWindowsZip(archive, destination), { status: 1 })
  assert.deepEqual(await readdir(destination), [])
})
