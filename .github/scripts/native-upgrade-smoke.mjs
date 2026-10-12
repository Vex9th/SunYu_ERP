/** Windows 隔离目录中验证旧正式包迁移、前端热切换、应用重启和清理。 */
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, writeFile, readdir, stat, lstat, realpath, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { Client, seed, verify } from './release-smoke.mjs'
import { extractWindowsZip } from './windows-zip.mjs'

const [legacyArg, fixturesArg, outputArg, version, dataMode = 'relative'] = process.argv.slice(2)
if (!legacyArg || !fixturesArg || !outputArg || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !['relative', 'junction', 'short-leaf'].includes(dataMode) || process.platform !== 'win32') throw new Error('Usage (Windows): node native-upgrade-smoke.mjs <old-1.3.1.zip> <fixtures> <new-output> <candidate-version> [relative|junction|short-leaf]')
const [legacyZip, fixtures, output] = [legacyArg, fixturesArg, outputArg].map(value => path.resolve(value))
const [major, minor, patch] = version.split('.').map(Number)
const firstFrontend = `${major}.${minor}.${patch + 1}`
const secondFrontend = `${major}.${minor}.${patch + 2}`
const applicationVersion = `${major}.${minor}.${patch + 3}`
const failureVersion = `${major}.${minor}.${patch + 4}`
await mkdir(output)
const installation = path.join(output, 'installation')
await mkdir(installation)
const root = await realpath(installation)
extractWindowsZip(legacyZip, root)
const listener = net.createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const base = `http://127.0.0.1:${port}`
const configPath = path.join(root, 'config.json')
let configuredData = 'customer/DATA'
let physicalData = path.join(root, 'customer/DATA')
if (dataMode !== 'relative') {
  physicalData = path.join(output, 'external-customer-data')
  await mkdir(physicalData)
  if (dataMode === 'junction') {
    await mkdir(path.join(root, 'customer'))
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(root, configuredData), physicalData])
  } else {
    // Assign a short name only to this owned fixture; never change volume settings.
    execFileSync('fsutil.exe', ['file', 'setshortname', physicalData, 'CUSTOM~1'])
    configuredData = path.join(output, 'CUSTOM~1')
  }
}
const accessedData = path.isAbsolute(configuredData) ? configuredData : path.join(root, configuredData)
await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, data_dir: configuredData, backup_enabled: false, session_secret: randomUUID() }), { flag: 'wx' })
// First-time 1.3.1 migration uses the same updater users download into their
// old directory; it remains installed after both failure and success.
const migrationUpdater = await readFile(path.join(fixtures, version, 'update.exe'))
await writeFile(path.join(root, 'update.exe'), migrationUpdater, { flag: 'wx' })
const checks = []
let first, config, business, frontendPID, servicePID
const updateProcesses = new Map()
const check = name => { checks.push(name); console.log(`PASS ${name}`) }
const digest = buffer => createHash('sha256').update(buffer).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(fn, label, seconds = 90) {
  const until = Date.now() + seconds * 1000
  let last
  do { try { return await fn() } catch (error) { if (error.terminal) throw error; last = error }; await delay(250) } while (Date.now() < until)
  throw new Error(`${label}: ${last?.message}`)
}
function launch(exe, args, logName) {
  const log = createWriteStream(path.join(output, logName), { flags: 'wx' })
  const child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  child.on('error', error => log.write(String(error)))
  child.once('close', () => log.end())
  return child
}
async function health(version) {
  return eventually(async () => {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'ok'); assert.equal(body.backend_version, version)
    assert.ok(Number.isInteger(body.pid) && body.pid > 0)
    servicePID = body.pid
    return body
  }, `Health ${version}`)
}
async function noFile(relative) {
  try { await stat(path.join(root, relative)); assert.fail(`Unexpected retained file ${relative}`) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function catalog(version) {
  await mkdir(path.join(root, '.updates'), { recursive: true })
  await writeFile(path.join(root, '.updates/catalog-v2.json'), await readFile(path.join(fixtures, version, 'update-manifest-v2.json')))
}
function verifyUpdateOwner(state) {
  if (!state.owner_pid && !state.owner_exe && !['success', 'failed', 'manual_recovery'].includes(state.status)) return
  assert.ok(Number.isInteger(state.owner_pid) && state.owner_pid > 0, `Missing updater owner PID: ${JSON.stringify(state)}`)
  assert.notEqual(state.owner_pid, servicePID, 'Business service executed the update job')
  assert.match(state.id, /^[a-f0-9]{24}$/)
  const expected = path.join(root, '.updates/work', state.id, 'update.exe')
  assert.equal(path.resolve(state.owner_exe).toLowerCase(), expected.toLowerCase(), 'Update job was not owned by its independent updater work copy')
  const previous = updateProcesses.get(state.id)
  if (previous?.observed) {
    previous.component = state.component ?? previous.component
    previous.version = state.version ?? previous.version
    return
  }
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.owner_pid}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim()
  const process = raw ? JSON.parse(raw) : null
  const proof = { id: state.id, owner_pid: state.owner_pid, owner_exe: state.owner_exe, observed: !!process, component: state.component, version: state.version }
  if (process) {
    assert.equal(process.ProcessId, state.owner_pid)
    assert.equal(path.resolve(process.ExecutablePath).toLowerCase(), expected.toLowerCase())
    assert.match(process.CommandLine, /--(?:worker|recover)\b/)
    proof.command_line = process.CommandLine
  }
  updateProcesses.set(state.id, proof)
}
async function job(requestID, expected = 'success', previousID) {
  return eventually(async () => {
    const file = requestID ? `.updates/requests/${requestID}.json` : '.updates/job.json'
    const state = JSON.parse(await readFile(path.join(root, file), 'utf8'))
    if (previousID) assert.notEqual(state.id, previousID, 'Waiting for the new helper transaction')
    verifyUpdateOwner(state)
    if (['success', 'failed', 'manual_recovery'].includes(state.status) && state.status !== expected) throw Object.assign(new Error(JSON.stringify(state)), { terminal: true })
    assert.equal(state.status, expected, JSON.stringify(state))
    return state
  }, 'Update completion', 150)
}
async function assets(version) {
  const response = await fetch(base, { signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 200)
  const html = await response.text()
  const asset = html.match(/(?:src|href)="(\/__frontend\/[^/]+\/assets\/[^\"]+)"/)
  assert.ok(asset, 'Versioned frontend resource missing')
  assert.ok(asset[1].startsWith(`/__frontend/${version}/`), asset[1])
  assert.equal((await fetch(base + asset[1])).status, 200)
  return asset[1]
}
async function preserved(client) {
  assert.deepEqual(await readFile(configPath), config, 'Config bytes changed')
  assert.equal(await readFile(path.join(physicalData, 'customer-attachment.txt'), 'utf8'), '测试附件保留')
  assert.equal((await realpath(accessedData)).toLowerCase(), (await realpath(physicalData)).toLowerCase(), 'Data alias no longer targets the original physical directory')
  if (dataMode === 'junction') assert.equal((await lstat(accessedData)).isSymbolicLink(), true, 'Data junction was replaced by an ordinary directory')
  if (dataMode === 'short-leaf') {
    const entries = await readdir(path.dirname(physicalData))
    assert.ok(entries.includes(path.basename(physicalData)), 'Physical long directory name was removed')
    assert.ok(!entries.some(name => name.toUpperCase() === 'CUSTOM~1'), 'Rollback created the short alias as a physical directory name')
  }
  assert.equal(await readFile(path.join(root, 'runtime/customer-note.txt'), 'utf8'), '客户未知文件保留')
  await verify(client, business)
}
async function importPackage(client, version, component, expected = 'success') {
  await catalog(version)
  const archive = path.join(fixtures, version, `SunYu_ERP-${component}-${version}.zip`)
  const requestID = randomUUID()
  const form = new FormData()
  form.set('file', new Blob([await readFile(archive)], { type: 'application/zip' }), path.basename(archive))
  const response = await fetch(`${base}/api/system/updates/import`, { method: 'POST', headers: { Cookie: client.cookie, Origin: base, 'X-Update-Request-ID': requestID }, body: form, signal: AbortSignal.timeout(30000) })
  const responseText = await response.text()
  assert.equal(response.status, 202, responseText)
  await job(requestID, expected)
  return requestID
}
async function migrate(target, expected, logName) {
  let previousID
  try { previousID = JSON.parse(await readFile(path.join(root, '.updates/job.json'), 'utf8')).id } catch (error) { if (error.code !== 'ENOENT') throw error }
  await catalog(target)
  const helper = launch(path.join(root, 'update.exe'), ['--root', root, '--package', path.join(fixtures, target, `SunYu_ERP-application-${target}.zip`), '--no-pause'], logName)
  // The root entry exits after a successful handoff to release its own image
  // lock. Only the worker's durable job determines installation success.
  await eventually(() => { assert.equal(helper.exitCode, 0); return true }, 'Independent updater handoff', 30)
  const result = await job(undefined, expected, previousID)
  return result
}
async function verifyFailedHandoff() {
  const failedRoot = path.join(output, 'handoff-failure')
  await cp(path.join(fixtures, version, 'SunYu_ERP'), failedRoot, { recursive: true, force: false, errorOnExist: true })
  // A separately owned fixture with a matching manifest but invalid PE image
  // makes Windows reject the work-copy launch. Never alter the real candidate.
  const invalidPE = Buffer.from('isolated invalid Windows updater image')
  await writeFile(path.join(failedRoot, 'update.exe'), invalidPE)
  const manifestPath = path.join(failedRoot, 'app/manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files['update.exe'] = digest(invalidPE)
  await writeFile(manifestPath, JSON.stringify(manifest))
  const entry = launch(path.join(fixtures, version, 'update.exe'), ['--root', failedRoot, '--package', path.join(fixtures, applicationVersion, `SunYu_ERP-application-${applicationVersion}.zip`), '--no-pause'], 'failed-handoff.log')
  await eventually(() => { assert.equal(entry.exitCode, 1, 'Failed worker launch was reported as successful handoff'); return true }, 'Failed updater handoff', 30)
  const failedJob = JSON.parse(await readFile(path.join(failedRoot, '.updates/job.json'), 'utf8'))
  assert.equal(failedJob.status, 'failed')
  assert.ok(failedJob.error, 'Worker launch failure cause was lost')
  assert.deepEqual(await readFile(path.join(failedRoot, 'update.exe')), invalidPE)
  check('Windows worker launch failure returns nonzero from the root entry and remains visible in the job')
}
try {
  await verifyFailedHandoff()
  first = launch(path.join(root, 'SunYu_ERP.exe'), ['--headless'], 'legacy-launcher.log')
  await health('1.3.1')
  const client = new Client(base)
  business = await seed(client)
  await verify(client, business)
  config = await readFile(configPath)
  assert.equal(JSON.parse(config).data_dir, configuredData, 'Legacy setup changed the configured Data alias before the upgrade test')
  await writeFile(path.join(output, 'business-state.json'), JSON.stringify(business), { flag: 'wx' })
  await writeFile(path.join(physicalData, 'customer-attachment.txt'), '测试附件保留', { flag: 'wx' })
  await writeFile(path.join(root, 'runtime/customer-note.txt'), '客户未知文件保留', { flag: 'wx' })
  await writeFile(path.join(root, '.upgrade-smoke-fixture'), 'isolated native upgrade smoke', { flag: 'wx' })
  await preserved(client)
  check('real 1.3.1 business data seeded and verified')
  const legacyFailure = await migrate(failureVersion, 'failed', 'legacy-failed-upgrade.log')
  assert.match(legacyFailure.message, /已恢复/)
  assert.equal(await readFile(path.join(root, '.upgrade-smoke-failure-ran'), 'utf8'), 'yes')
  await health('1.3.1')
  await preserved(client)
  assert.deepEqual(await readFile(path.join(root, 'update.exe')), migrationUpdater, 'Failed first migration removed or changed the standalone update entry point')
  await unlink(path.join(root, '.upgrade-smoke-failure-ran'))
  check('failed Python-to-Go migration restores real Python service, business data and the reusable update.exe entry point')
  await migrate(version, 'success', 'legacy-upgrade.log')
  await eventually(() => { assert.equal(first.exitCode, 0); return true }, 'Legacy launcher exit', 20)
  frontendPID = (await health(version)).pid
  // Use the cookie issued by Python before logging in again.
  await client.request(`/api/projects/RELEASE-SMOKE/purchase-orders/${business.order_id}`)
  check('Python session retained by Go')
  await preserved(client)
  const firstAsset = await assets(version)
  await noFile('runtime/SunYuRuntime.exe')
  await noFile('releases/backend/1.3.1/backend/app/main.py')
  await noFile('installation.json')
  await noFile('SunYu_ERP_Upgrade.exe')
  assert.deepEqual(await readFile(path.join(root, 'update.exe')), migrationUpdater)
  check('1.3.1 migrated; DATA/config/business preserved; owned Python files cleaned; unknown file retained')

  const firstID = await importPackage(client, firstFrontend, 'frontend')
  assert.equal((await health(version)).pid, frontendPID)
  const secondAsset = await assets(firstFrontend)
  assert.equal((await fetch(base + firstAsset)).status, 200)
  await preserved(client)
  assert.deepEqual(await readFile(path.join(root, 'update.exe')), migrationUpdater, 'Frontend update changed the updater')
  check('first frontend hot update; PID unchanged; previous assets accessible')
  // Reusing a completed request must neither apply twice nor retain another upload.
  await catalog(firstFrontend)
  const replayForm = new FormData()
  replayForm.set('file', new Blob([await readFile(path.join(fixtures, firstFrontend, `SunYu_ERP-frontend-${firstFrontend}.zip`))]), 'replay.zip')
  const replay = await fetch(`${base}/api/system/updates/import`, { method: 'POST', headers: { Cookie: client.cookie, Origin: base, 'X-Update-Request-ID': firstID }, body: replayForm })
  assert.equal(replay.status, 202, await replay.text())
  assert.deepEqual(await readdir(path.join(root, '.updates/imports')), [])
  check('completed import replay is idempotent and leaves no uploaded ZIP')
  await importPackage(client, secondFrontend, 'frontend')
  assert.equal((await health(version)).pid, frontendPID)
  await assets(secondFrontend)
  assert.equal((await fetch(base + secondAsset)).status, 200)
  await noFile(`app/web/${version}/index.html`)
  await preserved(client)
  assert.deepEqual(await readFile(path.join(root, 'update.exe')), migrationUpdater, 'Frontend update changed the updater')
  check('second frontend update retains one previous version and removes oldest')

  const oldLauncher = digest(await readFile(path.join(root, 'SunYu_ERP.exe')))
  const oldUpdater = digest(await readFile(path.join(root, 'update.exe')))
  await importPackage(client, applicationVersion, 'application')
  assert.notEqual((await health(applicationVersion)).pid, frontendPID)
  await assets(applicationVersion)
  const installed = JSON.parse(await readFile(path.join(root, 'app/manifest.json'), 'utf8'))
  assert.equal(installed.launcher_version, applicationVersion)
  for (const [relative, hash] of Object.entries(installed.files)) assert.equal(digest(await readFile(path.join(root, relative))), hash, relative)
  assert.notEqual(digest(await readFile(path.join(root, 'SunYu_ERP.exe'))), oldLauncher)
  const newUpdater = digest(await readFile(path.join(root, 'update.exe')))
  assert.notEqual(newUpdater, oldUpdater, 'Application update did not replace update.exe')
  assert.equal(newUpdater, installed.files['update.exe'], 'Installed updater is not manifest-managed')
  await preserved(client)
  const backups = await readdir(path.join(root, '.updates/rollback'), { withFileTypes: true })
  assert.equal(backups.filter(entry => entry.isDirectory()).length, 1)
  assert.deepEqual(await readdir(path.join(root, '.updates/imports')), [])
  check('application update replaced launcher/service/update.exe and restarted backend; one rollback snapshot; all data intact')
  const previousManifest = await readFile(path.join(root, 'app/manifest.json'))
  assert.notEqual(digest(await readFile(path.join(fixtures, failureVersion, 'update.exe'))), newUpdater, 'Failure fixture must install a different updater to prove its rollback')
  const failureID = await importPackage(client, failureVersion, 'application', 'failed')
  const failure = await job(failureID, 'failed')
  assert.match(failure.message, /已恢复/)
  assert.equal(await readFile(path.join(root, '.upgrade-smoke-failure-ran'), 'utf8'), 'yes', 'Failure service did not run')
  await health(applicationVersion)
  await assets(applicationVersion)
  assert.deepEqual(await readFile(path.join(root, 'app/manifest.json')), previousManifest)
  assert.equal(digest(await readFile(path.join(root, 'update.exe'))), newUpdater, 'Failed application update did not restore update.exe')
  for (const [relative, hash] of Object.entries(installed.files)) assert.equal(digest(await readFile(path.join(root, relative))), hash, `Rollback ${relative}`)
  await preserved(client)
  check('real failed startup after SQLite write automatically restores program, update.exe, database, config and attachments')
  assert.ok([...updateProcesses.values()].some(proof => proof.observed), 'No independent updater process was observed while executing an actual update')
  check('independent updater owns every installation job; Windows process inspection confirms the real worker executable')
  if (dataMode !== 'relative') check(`${dataMode} Data root preserves physical directory, alias and config through migration and rollback`)
  await writeFile(path.join(output, 'native-upgrade-result.json'), JSON.stringify({ status: 'passed', version, data_mode: dataMode, network_catalog: 'controlled offline catalog fixture; live GitHub check not tested', update_processes: [...updateProcesses.values()], checks }, null, 2), { flag: 'wx' })
} finally {
  await mkdir(path.join(root, '.updates'), { recursive: true })
  await writeFile(path.join(root, '.updates/shutdown'), 'isolated upgrade smoke cleanup')
  await eventually(async () => {
    let online = false
    try { online = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok } catch { }
    assert.equal(online, false, 'Owned smoke service remains running')
  }, 'Graceful cleanup', 30)
}
