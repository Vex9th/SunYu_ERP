/** Windows 成品启动、单实例、数据持久化验收。所有数据只写入新的批次子目录。 */
import { spawn, execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Client, seed, verify } from './release-smoke.mjs'

const [source, output, version] = process.argv.slice(2)
if (!source || !output || !version) throw new Error('Usage: node native-smoke.mjs <installation> <new-output-dir> <version>')
const root = path.resolve(output)
await mkdir(root) // Never merge into customer data or an earlier test batch.
for (const name of await readdir(source)) {
  await cp(path.join(source, name), path.join(root, name), { recursive: true, force: false, errorOnExist: true })
}
const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
await writeFile(path.join(root, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, data_dir: 'Data', backup_enabled: false }), { flag: 'wx', mode: 0o600 })
let active
function start(name) {
  const log = createWriteStream(path.join(root, `${name}.log`), { flags: 'wx' })
  const process = spawn(path.join(root, 'SunYu_ERP.exe'), ['--headless'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.pipe(log, { end: false }); process.stderr.pipe(log, { end: false })
  process.once('close', () => log.end())
  return process
}
async function eventually(check, description, seconds = 40) {
  const deadline = Date.now() + seconds * 1000
  let failure
  do {
    try { return await check() } catch (error) { failure = error }
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  throw new Error(`${description}: ${failure?.message}`)
}
async function healthy(process) {
  return eventually(async () => {
    assert.equal(process.exitCode, null, `Launcher exited ${process.exitCode}`)
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.status, 'ok'); assert.equal(health.backend_version, version)
    assert.ok(Number.isInteger(health.pid) && health.pid > 0)
    return health
  }, 'Service did not become healthy')
}
async function exit(process, name) {
  await eventually(() => { assert.notEqual(process.exitCode, null, `${name} is still running`); assert.equal(process.exitCode, 0); return true }, name, 30)
}
async function stop() {
  if (!active || active.exitCode !== null) return
  await writeFile(path.join(root, '.updates', 'shutdown'), 'test shutdown')
  await exit(active, 'Graceful service exit')
}
try {
  const updaterVersion = execFileSync(path.join(root, 'update.exe'), ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
  assert.equal(updaterVersion, version, 'Packaged independent updater has the wrong version')
  active = start('first')
  const first = await healthy(active)
  const index = await fetch(base).then(response => response.text())
  assert.match(index, /<div id="app">/)
  const asset = index.match(/(?:src|href)="(\/__frontend\/[^/]+\/assets\/[^\"]+)"/)
  assert.ok(asset, 'No versioned frontend asset')
  assert.equal((await fetch(base + asset[1])).status, 200)
  const client = new Client(base)
  const state = await seed(client)
  await verify(client, state)
  await writeFile(path.join(root, 'business-state.json'), JSON.stringify(state), { mode: 0o600, flag: 'wx' })
  const duplicate = start('duplicate')
  await exit(duplicate, 'Duplicate launch')
  assert.equal((await healthy(active)).pid, first.pid, 'Duplicate launch replaced the service')
  const updateState = await client.request('/api/system/updates')
  assert.equal(updateState.supported, true); assert.equal(updateState.can_install, true)
  await stop()
  const config = await readFile(path.join(root, 'config.json'))
  active = start('second')
  await healthy(active)
  await verify(new Client(base), state)
  assert.deepEqual(await readFile(path.join(root, 'config.json')), config, 'Restart changed config bytes')
  await stop()
  await writeFile(path.join(root, 'native-smoke-result.json'), JSON.stringify({ status: 'passed', version, checks: ['independent updater executable and version', 'native startup', 'frontend assets', 'single instance', 'graceful shutdown', 'restart', 'config bytes unchanged', 'number', 'tax', 'payment', 'invoice', 'receipt', 'ledger', 'local update permission'] }, null, 2))
  console.log('Native Windows packaged smoke: PASS')
} finally {
  try { await stop() } catch (error) {
    console.error('Graceful test cleanup failed:', error)
    if (active?.pid && active.exitCode === null && process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(active.pid), '/T', '/F'])
  }
}
