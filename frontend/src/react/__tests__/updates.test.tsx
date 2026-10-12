import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProjectDom } from './project-fixtures'
import { UpdatesProvider, UpdateNotice, UpdatesSection } from '../updates/Updates'
import { useUpdates } from '../updates/UpdateProvider'
import { UnsavedChangesProvider, useUnsavedChanges } from '../unsavedChanges'
import { mutationLedger } from '../procurement/model'
import { clearPendingCreate, companyPayload, prepareCompanyCreate, storePendingCreate } from '../companyWrites'
import type { UpdateState } from '../updates/types'

beforeAll(installProjectDom)
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear() })
let state: UpdateState
let reads: number
let writes: { path: string; init: RequestInit }[]
beforeEach(() => {
  reads = 0
  writes = []
  state = {
    supported: true, can_install: true,
    current: { backend: '1.3.0', frontend: '1.3.0' }, frontend_version: '1.3.0',
    latest: { version: '1.4.0', notes: '改进导入操作', components: { frontend: { version: '1.4.0', url: 'https://github.com/example/frontend.zip', sha256: 'a'.repeat(64) } } },
    preferences: { auto_check: false, ignored_version: null }, job: null,
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'GET') reads++
    else {
      writes.push({ path, init })
      if (path.endsWith('/preferences')) state = { ...state, preferences: { ...state.preferences, ...JSON.parse(init.body as string) } }
      if (path.endsWith('/download')) state = { ...state, job: { id: 'download-1', status: 'ready', component: 'frontend', version: '1.4.0', message: '下载已校验' } }
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
function Editor({ dirty }: { dirty: boolean }) {
  useUnsavedChanges(() => dirty)
  return <input aria-label="业务草稿" defaultValue="保留这份草稿" />
}
function UpdateControls() {
  const updates = useUpdates()!
  return <><button onClick={() => void updates.install('backend')}>直接安装</button><button onClick={() => void updates.download('frontend')}>直接下载前端</button><button onClick={() => void updates.download('backend')}>直接下载后端</button><button onClick={() => void updates.check()}>直接检查</button><button onClick={() => void updates.read()}>核对后台任务</button><button onClick={updates.refreshPage}>直接刷新</button></>
}
function mount(dirty = false, controls = false, pageVersion = '1.3.0') {
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: '/', element: <UpdatesProvider pageVersion={pageVersion}><UpdateNotice /><UpdatesSection /><Editor dirty={dirty} />{controls && <UpdateControls />}</UpdatesProvider> }] }])
  return render(<ConfigProvider theme={{ token: { motion: false } }}><App><RouterProvider router={router} /></App></ConfigProvider>)
}

describe('可选模块更新', () => {
  it('不自动下载或安装；用户先下载校验，再选择安装', async () => {
    mount()
    await screen.findByText('改进导入操作')
    expect(writes).toEqual([])
    expect(screen.queryByRole('button', { name: '安装前端' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下载前端' }))
    await screen.findByRole('button', { name: '安装前端' })
    expect(writes.map(item => [item.path, JSON.parse(item.init.body as string)])).toEqual([['/api/system/updates/download', { component: 'frontend' }]])
  })
  it('局域网只读，仍能看到新前端并手动检查', async () => {
    state.can_install = false
    state.frontend_version = '1.4.0'
    state.current.frontend = '1.4.0'
    mount()
    await screen.findByRole('button', { name: '刷新使用新版本' })
    expect(screen.getByText(/请在运行服务的本机/)).toBeTruthy()
    expect(screen.queryByText(/登录后下载/)).toBeNull()
    expect(screen.queryByRole('button', { name: /下载前端|安装前端|导入离线更新包|忽略此版本/ })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(writes[0]?.path).toBe('/api/system/updates/check'))
  })
  it.each([
    ['not_supervised', /当前服务未通过正式启动器运行/, /完整安装目录中的 SunYu_ERP\.exe/],
    ['client_unavailable', /暂时无法确认此连接是否来自本机/, /检查本机代理设置/],
    ['non_loopback_peer', /当前连接未被识别为本机连接/, /检查代理是否接管本机请求/],
    ['non_loopback_host', /当前访问地址不是本机地址/, /127\.0\.0\.1 或 localhost/],
  ])('按后端限制原因 %s 显示恢复操作，不错误要求重新登录', async (reason, title, recovery) => {
    Object.assign(state, { can_install: false, install_block_reason: reason })
    mount()
    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.getByText(recovery)).toBeTruthy()
    expect(screen.queryByText(/登录后下载/)).toBeNull()
    expect(screen.queryByRole('button', { name: /下载前端|安装前端|导入离线更新包/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(writes[0]?.path).toBe('/api/system/updates/check'))
  })
  it('未知的安装限制原因使用兼容说明，保持可检查且不开放安装', async () => {
    Object.assign(state, { can_install: false, install_block_reason: 'future_reason' })
    mount()
    expect(await screen.findByText('此连接暂不允许修改更新')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下载前端' })).toBeNull()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeTruthy()
  })
  it('忽略版本与关闭自动检查会保存偏好，更新仍可手动操作', async () => {
    state.preferences.auto_check = true
    sessionStorage.setItem('sunyu-update-checked-at', String(Date.now()))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '忽略此版本' }))
    await screen.findByRole('button', { name: '恢复此版本提醒' })
    fireEvent.click(screen.getByRole('switch', { name: '自动检查更新' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(item => JSON.parse(item.init.body as string))).toEqual([{ ignored_version: '1.4.0' }, { auto_check: false }])
    expect(screen.getByRole('button', { name: '下载前端' })).toBeTruthy()
  })
  it('刷新前阻止未保存草稿，保留输入内容', async () => {
    state.frontend_version = '1.4.0'
    mount(true)
    fireEvent.click(await screen.findByRole('button', { name: '刷新使用新版本' }))
    expect(await screen.findByText(/请先保存或处理未保存的修改/)).toBeTruthy()
    expect((screen.getByLabelText('业务草稿') as HTMLInputElement).value).toBe('保留这份草稿')
  })
  it('未打开原业务页面也阻止结果未知请求丢失', async () => {
    const job = mutationLedger.start('update-test', '保存采购', async () => { throw new Error('连接中断') }, () => true)
    await expect(mutationLedger.run(job)).rejects.toThrow('连接中断')
    try {
      state.frontend_version = '1.4.0'
      mount()
      fireEvent.click(await screen.findByRole('button', { name: '刷新使用新版本' }))
      expect(await screen.findByText(/业务请求仍在执行或结果尚未确认/)).toBeTruthy()
    } finally { mutationLedger.discard(job) }
  })
  it('后端安装断线继续查询，只有持久任务成功后才显示成功', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    state.job = { id: 'install-1', status: 'installing', component: 'backend', version: '1.4.0', message: '正在重启后端' }
    mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('正在重启后端')).toBeTruthy()
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('断线'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(screen.getByText(/正在恢复连接/)).toBeTruthy()
    expect(screen.queryByText('后端升级完成')).toBeNull()
    state.job = { ...state.job, status: 'success', message: '后端升级完成' }
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText('后端升级完成')).toBeTruthy()
    expect(screen.queryByText(/正在恢复连接/)).toBeNull()
    expect(reads).toBeGreaterThanOrEqual(2)
  })
  it('开发服务显示友好说明，不提供安装操作', async () => {
    state.supported = false
    state.can_install = false
    mount()
    expect(await screen.findByText(/当前为开发运行环境/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull()
  })
})

describe('在线更新按组件语义版本比较', () => {
  function setVersions(currentFrontend: string, currentBackend: string, remoteFrontend: string, remoteBackend: string, releaseVersion: string) {
    state.current = { frontend: currentFrontend, backend: currentBackend }
    state.frontend_version = currentFrontend
    state.preferences.auto_check = true
    sessionStorage.setItem('sunyu-update-checked-at', String(Date.now()))
    state.latest = { version: releaseVersion, notes: '线上版本说明', components: {
      frontend: { version: remoteFrontend, url: 'https://github.com/example/frontend.zip', sha256: 'a'.repeat(64) },
      backend: { version: remoteBackend, url: 'https://github.com/example/backend.zip', sha256: 'b'.repeat(64) },
    } }
  }
  it('本机 1.3.1 高于远端 1.3.0 时不提示降级，底层下载操作也不提交', async () => {
    setVersions('1.3.1', '1.3.1', '1.3.0', '1.3.0', '1.3.0')
    mount(false, true, '1.3.1')
    await screen.findByText('线上版本说明')
    expect(screen.queryByText(/发现可选更新/)).toBeNull()
    expect(screen.queryByText('可用版本 1.3.0')).toBeNull()
    expect(screen.queryByRole('button', { name: /^下载(前端|后端)$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '直接下载前端' }))
    fireEvent.click(screen.getByRole('button', { name: '直接下载后端' }))
    await act(async () => { await Promise.resolve() })
    expect(writes).toHaveLength(0)
  })
  it('数值比较 1.3.10 高于 1.3.9，并只为确有更高版本的组件提供下载', async () => {
    setVersions('1.3.10', '1.3.9', '1.3.9', '1.3.10', '1.3.10')
    mount(false, true, '1.3.10')
    expect(await screen.findByText('发现可选更新 1.3.10')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下载前端' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '直接下载前端' }))
    fireEvent.click(screen.getByRole('button', { name: '下载后端' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(JSON.parse(writes[0]!.init.body as string)).toEqual({ component: 'backend' })
  })
  it('相同组件版本不下载，不根据整体发布版本误判组件升级', async () => {
    setVersions('1.3.10', '1.4.0', '1.3.10', '1.3.9', '1.5.0')
    mount(false, true, '1.3.10')
    await screen.findByText('线上版本说明')
    expect(screen.queryByText(/发现可选更新/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^下载(前端|后端)$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '直接下载前端' }))
    await act(async () => { await Promise.resolve() })
    expect(writes).toHaveLength(0)
  })
  it('在线包不是更高版本时，仍保留用户已导入校验的离线包安装', async () => {
    setVersions('1.3.1', '1.3.1', '1.3.0', '1.3.0', '1.3.0')
    state.job = { id: 'offline-old', component: 'backend', version: '1.3.0', status: 'ready', message: '离线包已校验' }
    mount(false, false, '1.3.1')
    fireEvent.click(await screen.findByRole('button', { name: '安装后端' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认安装' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.path).toBe('/api/system/updates/install')
  })
  it.each([
    ['1.3.1', '1.3.1-rc.1'],
    ['1.3.1-rc.10', '1.3.1-rc.9'],
    ['1.3.1+build.2', '1.3.1+build.3'],
  ])('当前 %s 不把远端 %s 作为更高版本', async (installed, remote) => {
    setVersions(installed, installed, remote, remote, remote)
    mount(false, false, installed)
    await screen.findByText('线上版本说明')
    expect(screen.queryByText(/发现可选更新/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^下载(前端|后端)$/ })).toBeNull()
  })
})

describe('更新边界与持久保护', () => {
  it('自动检查只在允许且达到间隔时触发，绝不自动下载', async () => {
    state.preferences.auto_check = true
    const page = mount()
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.path).toBe('/api/system/updates/check')
    page.unmount()
    mount()
    await screen.findByText('改进导入操作')
    expect(writes).toHaveLength(1)
  })
  it('导入离线包使用明确选择的文件，校验后仍需点击安装', async () => {
    state.latest = null
    const page = mount()
    await screen.findByRole('button', { name: '导入离线更新包' })
    const file = new File(['trusted-package'], 'update.zip', { type: 'application/zip' })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/import')) state.job = { id: 'offline-1', status: 'ready', component: 'backend', version: '1.4.0', message: '离线包已校验' }
      return originalFetch(path, init)
    })
    fireEvent.change(page.container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await screen.findByRole('button', { name: '安装后端' })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe('/api/system/updates/import')
    const uploaded = (writes[0]!.init.body as FormData).get('file') as File
    expect(uploaded.name).toBe('update.zip')
    const content = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(uploaded) })
    expect(content).toBe('trusted-package')
  })
  it('连续两次相同断线错误后仍继续轮询恢复', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    state.job = { id: 'restart-many', status: 'installing', component: 'backend', version: '1.4.0', message: '准备切换' }
    mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('断线')).mockRejectedValueOnce(new TypeError('断线'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText(/正在恢复连接/)).toBeTruthy()
    state.job = { ...state.job, status: 'failed', message: '更新失败，已保留原版本' }
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText('更新失败，已保留原版本')).toBeTruthy()
  })
})

describe('用户明确选择更新', () => {
  it('稍后隐藏全局提醒后，仍能从设置区主动刷新', async () => {
    state.frontend_version = '1.4.0'
    mount(true)
    fireEvent.click(await screen.findByRole('button', { name: /稍.*后/ }))
    fireEvent.click(screen.getByRole('button', { name: '刷新使用新版本' }))
    expect(await screen.findByText(/请先保存或处理未保存的修改/)).toBeTruthy()
  })
  it('后端安装先展示重启影响，确认后才发送唯一安装请求', async () => {
    state.latest = null
    state.job = { id: 'offline-backend', status: 'ready', component: 'backend', version: '1.4.0', message: '后端包已校验' }
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '安装后端' }))
    expect(await screen.findByText(/后端将短暂重启/)).toBeTruthy()
    expect(writes).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.path).toBe('/api/system/updates/install')
    expect(JSON.parse(writes[0]!.init.body as string)).toEqual({ component: 'backend' })
  })
  it('已导入待安装的任务不会被自动检查覆盖', async () => {
    state.preferences.auto_check = true
    state.latest = null
    state.job = { id: 'offline-backend', status: 'ready', component: 'backend', version: '1.4.0', message: '后端包已校验' }
    mount()
    await screen.findByRole('button', { name: '安装后端' })
    await act(async () => { await Promise.resolve() })
    expect(writes).toHaveLength(0)
  })
})


it('公司创建原请求即使无法持久化也阻止跨页面更新刷新', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储禁用') })
  storePendingCreate(prepareCompanyCreate(companyPayload({ name: '待确认公司' })))
  try {
    state.frontend_version = '1.4.0'
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '刷新使用新版本' }))
    expect(await screen.findByText(/业务请求仍在执行或结果尚未确认/)).toBeTruthy()
  } finally { clearPendingCreate(); storage.mockRestore() }
})

it('安装提交响应丢失后，按恢复查询到的持久任务消除未知结果提示', async () => {
  state.latest = null
  state.job = { id: 'install-response-lost', status: 'ready', component: 'backend', version: '1.4.0', message: '后端包已校验' }
  const originalFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/install')) {
      state.job = { ...state.job!, id: 'accepted-install', status: 'installing', message: '后台安装中' }
      throw new TypeError('response lost')
    }
    return originalFetch(path, init)
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '安装后端' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认安装' }))
  await screen.findByText('后台安装中')
  expect(screen.queryByText(/提交结果尚未确认/)).toBeNull()
  expect(screen.queryByText(/更新已完成/)).toBeNull()
})


describe('更新审查回归', () => {
  it('安装响应未知且 GET 仍是旧 ready 时禁止新操作和刷新，错误组件任务也不能解锁', async () => {
    state.latest = null
    state.frontend_version = '1.4.0'
    state.job = { id: 'old-ready', status: 'ready', component: 'backend', version: '1.4.0', message: '待安装包' }
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/install')) { writes.push({ path: String(path), init: init! }); throw new TypeError('response lost') }
      return originalFetch(path, init)
    })
    mount(false, true)
    fireEvent.click(await screen.findByRole('button', { name: '安装后端' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认安装' }))
    await screen.findByText(/提交结果尚未确认/)
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))
    expect((screen.getByRole('button', { name: '安装后端' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '刷新使用新版本' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '直接安装' }))
    fireEvent.click(screen.getByRole('button', { name: '直接检查' }))
    fireEvent.click(screen.getByRole('button', { name: '直接刷新' }))
    expect(await screen.findByText(/更新任务尚未确认完成/)).toBeTruthy()
    expect(writes).toHaveLength(1)
    state.job = { id: 'unrelated-job', component: 'frontend', version: '1.4.0', status: 'success', message: '其他组件完成' }
    fireEvent.click(screen.getByRole('button', { name: '核对后台任务' }))
    await screen.findByText('其他组件完成')
    expect(screen.getByText(/提交结果尚未确认/)).toBeTruthy()
    state.job = { id: 'unrelated-version', component: 'backend', version: '1.5.0', status: 'success', message: '其他版本完成' }
    state.current.backend = '1.5.0'
    fireEvent.click(screen.getByRole('button', { name: '核对后台任务' }))
    await screen.findByText('其他版本完成')
    expect(screen.getByText(/提交结果尚未确认/)).toBeTruthy()
    state.job = { id: 'accepted-install', component: 'backend', version: '1.4.0', status: 'success', message: '目标组件已完成' }
    state.current.backend = '1.4.0'
    fireEvent.click(screen.getByRole('button', { name: '核对后台任务' }))
    await screen.findByText('目标组件已完成')
    expect(screen.queryByText(/提交结果尚未确认/)).toBeNull()
    expect((screen.getByRole('button', { name: '刷新使用新版本' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('ready 包禁止手工检查覆盖，底层 action 同样保护待安装任务', async () => {
    state.latest = null
    state.job = { id: 'ready-preserved', status: 'ready', component: 'backend', version: '1.4.0', message: '离线包待安装' }
    mount(false, true)
    await screen.findByRole('button', { name: '安装后端' })
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/先安装当前更新包或重新选择更新包/)).toBeTruthy()
    expect(screen.queryByText('尚无可用更新信息，可点击检查更新。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '直接检查' }))
    await act(async () => { await Promise.resolve() })
    expect(writes).toHaveLength(0)
    expect(screen.getByRole('button', { name: '安装后端' })).toBeTruthy()
  })
})
