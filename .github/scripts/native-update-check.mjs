/** 对已完成 native-smoke 的隔离安装执行真实官方更新检查；绝不触发安装。 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Client } from './release-smoke.mjs'

const [rootArg, phase = 'prepublish'] = process.argv.slice(2)
if (!rootArg || !['prepublish', 'postpublish'].includes(phase)) throw new Error('Usage: node native-update-check.mjs <native-smoke-installation> [prepublish|postpublish]')
const root = await realpath(path.resolve(rootArg))
const proof = JSON.parse(await readFile(path.join(root, 'native-smoke-result.json'), 'utf8'))
assert.equal(proof.status, 'passed')
const configBytes = await readFile(path.join(root, 'config.json'))
const config = JSON.parse(configBytes)
assert.equal(config.host, '127.0.0.1')
const base = `http://127.0.0.1:${config.port}`
const state = JSON.parse(await readFile(path.join(root, 'business-state.json'), 'utf8'))
const manifest = await readFile(path.join(root, 'app/manifest.json'))
const log = createWriteStream(path.join(root, `network-check-${phase}.log`), { flags: 'wx' })
const child = spawn(path.join(root, 'SunYu_ERP.exe'), ['--headless'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.once('close', () => log.end())
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(fn, seconds) {
  let error
  for (let until = Date.now() + seconds * 1000; Date.now() < until;) {
    try { return await fn() } catch (caught) { if (caught.terminal) throw caught; error = caught }
    await delay(250)
  }
  throw error
}
let report
try {
  await eventually(async () => {
    assert.equal(child.exitCode, null)
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    assert.equal(response.status, 200)
  }, 45)
  const client = new Client(base)
  await client.post('/api/auth/login', { password: state.password }, 204)
  const requestID = randomUUID()
  await client.request('/api/system/updates/check', 'POST', undefined, 202, { 'X-Update-Request-ID': requestID })
  const status = await eventually(async () => {
    const current = await client.request(`/api/system/updates?request_id=${requestID}`)
    const job = current.requested_job
    if (job?.status === 'failed') throw Object.assign(new Error(`${job.message}: ${job.error}`), { terminal: true })
    assert.equal(job?.status, 'success')
    return current
  }, 180)
  const catalog = JSON.parse(await readFile(path.join(root, '.updates/catalog-v2.json'), 'utf8'))
  assert.ok(catalog.format === 1 || catalog.format === 2)
  if (phase === 'postpublish') { assert.equal(catalog.format, 2); assert.equal(catalog.version, proof.version) }
  assert.deepEqual(await readFile(path.join(root, 'app/manifest.json')), manifest)
  assert.deepEqual(await readFile(path.join(root, 'config.json')), configBytes)
  assert.equal(status.current.backend, proof.version)
  // The public API exposes component offers, not Engine.update_available.
  const offeredComponents = status.latest?.components ?? {}
  if (catalog.format === 1) assert.deepEqual(offeredComponents, {}, 'Legacy catalog offered an incompatible component package')
  else {
    assert.deepEqual(Object.keys(offeredComponents).sort(), Object.keys(catalog.packages).sort(), 'Public API omitted a catalog component')
    for (const [component, metadata] of Object.entries(offeredComponents)) assert.equal(metadata.version, status.current[component], `Unexpected ${component} version offered after installing the current release`)
  }
  report = { status: 'passed', phase, installed: proof.version, official_catalog_format: catalog.format, official_version: catalog.version, official_backend: catalog.backend_version, official_frontend: catalog.frontend_version, newer_components_offered: false, program_unchanged: true, installation_requested: false }
  console.log(JSON.stringify(report))
} catch (error) {
  report = { status: 'failed', phase, error: error.message }
  throw error
} finally {
  if (report) await writeFile(path.join(root, `network-check-${phase}.json`), JSON.stringify(report, null, 2), { flag: 'wx' })
  await writeFile(path.join(root, '.updates/shutdown'), 'isolated network check complete')
  await eventually(() => { assert.equal(child.exitCode, 0) }, 30)
}
