import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function classifyRelease(tag, commit, tagCommit, release) {
  if (!tag) return 'candidate'
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid version: expected vMAJOR.MINOR.PATCH')
  if (tagCommit && tagCommit !== commit) throw new Error('Release tag belongs to another commit; refusing to overwrite it')
  if (!release) return 'new'
  if (release.draft) {
    if (!tagCommit && release.target_commitish !== commit) throw new Error('Draft release target commit cannot be verified')
    return 'draft'
  }
  if (!tagCommit) throw new Error('Existing release has no matching fetched tag')
  const version = tag.slice(1)
  const required = ['SunYu_ERP-windows-x64.zip', `SunYu_ERP-application-${version}.zip`, `SunYu_ERP-frontend-${version}.zip`, 'SunYu_ERP_Upgrade.exe', 'update-manifest-v2.json', 'update-manifest.json', 'SHA256SUMS.txt']
  const names = new Set(release.assets.filter(asset => asset.state === 'uploaded' && asset.size > 0).map(asset => asset.name))
  const missing = required.filter(name => !names.has(name))
  if (missing.length) throw new Error(`Published release has incomplete assets: ${missing.join(', ')}; inspect it before retrying`)
  return 'published'
}
function readRelease(repository, tag) {
  // Authenticated paginated listing includes interrupted drafts.
  for (let page = 1; ; page++) {
    const releases = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases?per_page=100&page=${page}`], { encoding: 'utf8' }))
    const found = releases.find(release => release.tag_name === tag)
    if (found) return found
    if (releases.length < 100) return null
  }
}
export function main(env = process.env) {
  const tag = env.RELEASE_TAG ?? ''
  const commit = env.GITHUB_SHA
  if (!commit) throw new Error('GITHUB_SHA is required')
  classifyRelease(tag, commit, null, null)
  let tagCommit = null, release = null
  if (tag) {
    const result = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' })
    if (result.status === 0) tagCommit = result.stdout.trim()
    else if (result.status !== 128) throw new Error('Cannot inspect release tag')
    release = readRelease(env.GITHUB_REPOSITORY, tag)
  }
  const state = classifyRelease(tag, commit, tagCommit, release)
  appendFileSync(env.GITHUB_OUTPUT, `state=${state}\nbuild_needed=${state !== 'published'}\n`)
  console.log(`Release gate: ${tag || 'candidate'} / ${state} / ${commit}`)
  if (state === 'published') appendFileSync(env.GITHUB_STEP_SUMMARY, `${tag} 已发布且资产完整，本次跳过重复构建和发布。\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
