/** 从当前源码构建隔离升级与故障恢复夹具，不修改正式候选或 frontend/dist。 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [candidateArg, outputArg, version, serverArg] = process.argv.slice(2)
if (!candidateArg || !outputArg || !/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: node build-upgrade-fixtures.mjs <candidate-artifacts> <new-fixtures-dir> <candidate-version> [server-source-snapshot]')
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const server = serverArg ? path.resolve(serverArg) : path.join(repository, 'server')
const output = path.resolve(outputArg)
const candidate = path.resolve(candidateArg)
await mkdir(output)
await cp(candidate, path.join(output, version), { recursive: true, force: false, errorOnExist: true })
const [major, minor, patch] = version.split('.').map(Number)
for (let increment = 1; increment <= 4; increment++) {
  const fixtureVersion = `${major}.${minor}.${patch + increment}`
  const work = path.join(output, `fixture-build-${fixtureVersion}`)
  await mkdir(work)
  const web = path.join(work, 'frontend')
  const bin = path.join(work, 'bin')
  await mkdir(bin)
  execFileSync(process.execPath, [path.join(repository, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--outDir', web], { cwd: path.join(repository, 'frontend'), env: { ...process.env, SUNYU_VERSION: fixtureVersion }, stdio: 'inherit' })
  // Frontend-only versions keep the original binary identities. The third
  // fixture has newly compiled identities and must restart both native parts.
  const nativeVersion = increment >= 3 ? fixtureVersion : version
  const launcherVersion = increment === 4 ? `${major}.${minor}.${patch + 3}` : nativeVersion
  for (const [name, command, gui] of [['SunYu_ERP.exe', 'launcher', true], ['SunYuService.exe', 'service', true], ['SunYu_ERP_Upgrade.exe', 'upgrade', false]]) {
    if (increment < 3) {
      const relative = name === 'SunYu_ERP_Upgrade.exe' ? name : path.join('SunYu_ERP', name === 'SunYuService.exe' ? path.join('app', name) : name)
      await cp(path.join(candidate, relative), path.join(bin, name), { force: false, errorOnExist: true })
    } else if (increment === 4) {
      if (command !== 'service') {
        await cp(path.join(output, `fixture-build-${launcherVersion}`, 'bin', name), path.join(bin, name), { force: false, errorOnExist: true })
      } else {
        // This synthetic executable refuses to write anything without an exact
        // marker created only by native-upgrade-smoke in its brand-new directory.
        const badSource = path.join(work, 'failure-service.go')
        await writeFile(badSource, `package main
import ("encoding/json"; "os"; "path/filepath")
func main() {
  if len(os.Args)!=3 || os.Args[1]!="--root" { os.Exit(43) }
  root:=os.Args[2]
  marker,err:=os.ReadFile(filepath.Join(root,".upgrade-smoke-fixture"))
  if err!=nil || string(marker)!="isolated native upgrade smoke" { os.Exit(43) }
  configuration,err:=os.ReadFile(filepath.Join(root,"config.json"))
  var settings struct { DataDir string \`json:"data_dir"\` }
  if err!=nil || json.Unmarshal(configuration,&settings)!=nil || settings.DataDir=="" { os.Exit(44) }
  data:=settings.DataDir
  if !filepath.IsAbs(data) { data=filepath.Join(root,data) }
  if err=os.WriteFile(filepath.Join(data,"iapm.sqlite"),[]byte("simulated interrupted database migration"),0600); err!=nil { os.Exit(44) }
  _=os.WriteFile(filepath.Join(root,".upgrade-smoke-failure-ran"),[]byte("yes"),0600)
  os.Exit(42)
}
`, { flag: 'wx' })
        execFileSync('go', ['build', '-trimpath', '-o', path.join(bin, name), badSource], { cwd: server, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' }, stdio: 'inherit' })
      }
    } else {
      execFileSync('go', ['build', '-trimpath', `-ldflags=-s -w ${gui ? '-H=windowsgui ' : ''}-X main.version=${nativeVersion}`, '-o', path.join(bin, name), `./cmd/${command}`], { cwd: server, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' }, stdio: 'inherit' })
    }
  }
  execFileSync('go', ['run', './cmd/package', '--version', fixtureVersion, '--backend-version', nativeVersion, '--launcher-version', launcherVersion, '--bin-dir', bin, '--web-dir', web, '--output', path.join(output, fixtureVersion), '--notes', '仅用于隔离升级验收的版本，不发布。'], { cwd: server, stdio: 'inherit' })
}
await writeFile(path.join(output, 'fixture-versions.json'), JSON.stringify({ candidate: version, frontend: [`${major}.${minor}.${patch + 1}`, `${major}.${minor}.${patch + 2}`], application: `${major}.${minor}.${patch + 3}`, failure: `${major}.${minor}.${patch + 4}` }, null, 2), { flag: 'wx' })
