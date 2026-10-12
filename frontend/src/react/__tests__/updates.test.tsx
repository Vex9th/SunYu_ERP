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
const requestID = (init?: RequestInit) => new Headers(init?.headers).get('X-Update-Request-ID')!
beforeEach(() => {
  reads = 0
  writes = []
  state = {
    supported: true, can_install: true,
    current: { application: '2.0.0', backend: '2.0.0', frontend: '2.0.0' }, frontend_version: '2.0.0',
    latest: { version: '2.1.0', notes: '改进导入操作', components: { application: { version: '2.1.0', url: 'https://github.com/example/application.zip', sha256: 'a'.repeat(64) } } },
    preferences: { auto_check: false, ignored_version: null }, job: null,
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'GET') reads++
    else {
      writes.push({ path, init })
      if (path.endsWith('/preferences')) state = { ...state, preferences: { ...state.preferences, ...JSON.parse(init.body as string) } }
      if (path.endsWith('/update') || path.endsWith('/import')) state = { ...state, job: { id: 'update-1', request_id: requestID(init), status: 'downloading', component: 'application', version: '2.1.0', message: '正在自动更新' } }
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
  return <><button onClick={() => void updates.update()}>直接更新</button><button onClick={() => void updates.check()}>直接检查</button><button onClick={() => void updates.read()}>核对后台任务</button><button onClick={updates.refreshPage}>直接刷新</button></>
}
function mount(dirty = false, controls = false, pageVersion = '2.0.0') {
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [{ path: '/', element: <UpdatesProvider pageVersion={pageVersion}><UpdateNotice /><UpdatesSection /><Editor dirty={dirty} />{controls && <UpdateControls />}</UpdatesProvider> }] }])
  return render(<ConfigProvider theme={{ token: { motion: false } }}><App><RouterProvider router={router} /></App></ConfigProvider>)
}

describe('一键自愿更新', () => {
  it('不自动安装；点击一次直接启动完整更新，没有逐组件或二次确认', async () => {
    mount()
    await screen.findByText('改进导入操作')
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '一键更新' }))
    await screen.findByText('正在自动更新')
    expect(writes.map(item => item.path)).toEqual(['/api/system/updates/update'])
    expect(requestID(writes[0]!.init)).toMatch(/^[a-f0-9-]{36}$/)
    expect(screen.queryByRole('button', { name: /确认安装|下载前端|安装后端/ })).toBeNull()
  })
  it('尚未检查也可一键更新，连续点击只提交一次', async () => {
    state.latest = null
    mount(false, true)
    const button = await screen.findByRole('button', { name: '一键更新' })
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: '直接更新' }))
    await screen.findByText('正在自动更新')
    expect(writes).toHaveLength(1)
  })
  it('自动检查只在允许且达到间隔时触发，绝不自动安装', async () => {
    state.preferences.auto_check = true
    const page = mount()
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.path).toBe('/api/system/updates/check')
    page.unmount(); mount()
    await screen.findByText('改进导入操作')
    expect(writes).toHaveLength(1)
  })
  it('忽略版本与关闭自动检查只改变提醒，不妨碍主动一键更新', async () => {
    state.preferences.auto_check = true
    sessionStorage.setItem('sunyu-update-checked-at', String(Date.now()))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '忽略此版本' }))
    await screen.findByRole('button', { name: '恢复此版本提醒' })
    fireEvent.click(screen.getByRole('switch', { name: '自动检查更新' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes.map(item => JSON.parse(item.init.body as string))).toEqual([{ ignored_version: '2.1.0' }, { auto_check: false }])
    expect(screen.getByRole('button', { name: '一键更新' })).toBeTruthy()
  })
  it('选择离线包即开始校验安装，只发送明确选择的文件', async () => {
    const page = mount()
    fireEvent.click(await screen.findByText('无法在线更新时'))
    const file = new File(['trusted-package'], 'update.zip', { type: 'application/zip' })
    fireEvent.change(page.container.querySelector('input[type="file"]')!, { target: { files: [file] } })
    await screen.findByText('正在自动更新')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe('/api/system/updates/import')
    const uploaded = (writes[0]!.init.body as FormData).get('file') as File
    expect(uploaded.name).toBe('update.zip')
    const content = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(uploaded) })
    expect(content).toBe('trusted-package')
  })
})

describe('本机限制与草稿保护', () => {
  it('局域网可读和检查，可刷新前端，不能安装和改偏好', async () => {
    state.can_install = false; state.frontend_version = '2.1.0'; state.current.frontend = '2.1.0'
    mount()
    await screen.findByRole('button', { name: '刷新使用新版本' })
    expect(screen.getByText(/请在运行服务的本机/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /一键更新|选择离线包并更新|忽略此版本/ })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(writes[0]?.path).toBe('/api/system/updates/check'))
  })
  it.each([
    ['not_supervised', /当前服务未通过正式启动器运行/, /完整安装目录中的 SunYu_ERP\.exe/],
    ['client_unavailable', /暂时无法确认此连接是否来自本机/, /检查本机代理设置/],
    ['non_loopback_peer', /当前连接未被识别为本机连接/, /检查代理是否接管本机请求/],
    ['non_loopback_host', /当前访问地址不是本机地址/, /127\.0\.0\.1 或 localhost/],
    ['future_reason', /此连接暂不允许修改更新/, /请在运行服务的本机/],
  ])('按限制 %s 显示可行恢复步骤', async (reason, title, recovery) => {
    Object.assign(state, { can_install: false, install_block_reason: reason })
    mount(false, true)
    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.getByText(recovery)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '直接更新' }))
    expect(writes).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    await waitFor(() => expect(writes[0]?.path).toBe('/api/system/updates/check'))
  })
  it('未保存草稿时不开始更新，也不刷新；保留输入', async () => {
    state.frontend_version = '2.1.0'
    mount(true)
    fireEvent.click(await screen.findByRole('button', { name: '一键更新' }))
    expect(await screen.findByText(/再开始更新/)).toBeTruthy()
    expect(writes).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '刷新使用新版本' }))
    expect(await screen.findByText(/再刷新使用新版本/)).toBeTruthy()
    expect((screen.getByLabelText('业务草稿') as HTMLInputElement).value).toBe('保留这份草稿')
  })
  it('跨页面仍保护结果未知的采购请求', async () => {
    const job = mutationLedger.start('update-test', '保存采购', async () => { throw new Error('连接中断') }, () => true)
    await expect(mutationLedger.run(job)).rejects.toThrow('连接中断')
    try {
      mount()
      fireEvent.click(await screen.findByRole('button', { name: '一键更新' }))
      expect(await screen.findByText(/业务请求仍在执行或结果尚未确认/)).toBeTruthy()
      expect(writes).toHaveLength(0)
    } finally { mutationLedger.discard(job) }
  })
  it('公司创建即使无法持久化也阻止更新', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('存储禁用') })
    storePendingCreate(prepareCompanyCreate(companyPayload({ name: '待确认公司' })))
    try {
      mount()
      fireEvent.click(await screen.findByRole('button', { name: '一键更新' }))
      expect(await screen.findByText(/业务请求仍在执行或结果尚未确认/)).toBeTruthy()
      expect(writes).toHaveLength(0)
    } finally { clearPendingCreate(); storage.mockRestore() }
  })
  it('稍后隐藏全局提醒后仍能从设置主动刷新', async () => {
    state.frontend_version = '2.1.0'; mount(true)
    fireEvent.click(await screen.findByRole('button', { name: /稍.*后/ }))
    fireEvent.click(screen.getByRole('button', { name: '刷新使用新版本' }))
    expect(await screen.findByText(/请先保存或处理未保存的修改/)).toBeTruthy()
  })
  it('开发环境不提供更新操作', async () => {
    state.supported = false; state.can_install = false; mount()
    expect(await screen.findByText(/当前为开发运行环境/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull()
    expect(screen.queryByRole('button', { name: '一键更新' })).toBeNull()
  })
})

describe('持久任务与重连', () => {
  it('后端重启连续断线仍轮询，持久任务确认后才显示完成', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    state.job = { id: 'restart-1', status: 'restarting', component: 'application', version: '2.1.0', message: '正在重启服务' }
    mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('正在重启服务')).toBeTruthy()
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('断线')).mockRejectedValueOnce(new TypeError('断线'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText(/正在恢复连接/)).toBeTruthy()
    expect(screen.queryByText('升级完成并已清理')).toBeNull()
    state.job = { ...state.job, status: 'success', message: '升级完成并已清理' }
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText('升级完成并已清理')).toBeTruthy()
    expect(screen.queryByText(/正在恢复连接/)).toBeNull()
    expect(reads).toBe(2)
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(4)
  })
  it.each(['verifying', 'backing_up', 'installing', 'restarting', 'cleaning'] as const)('%s 阶段保持唯一任务，禁用新提交', async status => {
    state.job = { id: 'ongoing', status, component: 'application', version: '2.1.0', message: '后台处理中', progress: 45 }
    mount(false, true)
    expect(await screen.findByText('后台处理中')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '直接更新' })); fireEvent.click(screen.getByRole('button', { name: '直接检查' }))
    expect(writes).toHaveLength(0)
  })
  it('提交响应丢失后按request_id认领，其他任务不能解除重复提交保护', async () => {
    state.frontend_version = '2.1.0'
    let submitted = ''
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/update')) { submitted = requestID(init); writes.push({ path: String(path), init: init! }); throw new TypeError('response lost') }
      return originalFetch(path, init)
    })
    mount(false, true)
    fireEvent.click(await screen.findByRole('button', { name: '一键更新' }))
    await screen.findByText(/提交结果尚未确认/)
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))
    fireEvent.click(screen.getByRole('button', { name: '直接更新' })); fireEvent.click(screen.getByRole('button', { name: '直接检查' })); fireEvent.click(screen.getByRole('button', { name: '直接刷新' }))
    expect(await screen.findByText(/更新任务尚未确认完成/)).toBeTruthy()
    expect(writes).toHaveLength(1)
    state.job = { id: 'another-window', request_id: 'different', component: 'application', version: '2.1.0', status: 'success', message: '其他任务完成' }
    fireEvent.click(screen.getByRole('button', { name: '核对后台任务' }))
    await screen.findByText('其他任务完成')
    expect(screen.getByText(/提交结果尚未确认/)).toBeTruthy()
    state.job = { ...state.job, id: 'mine', request_id: submitted, status: 'failed', message: '更新失败，原版本可用' }
    fireEvent.click(screen.getByRole('button', { name: '核对后台任务' }))
    await screen.findByText('更新失败，原版本可用')
    expect(screen.queryByText(/提交结果尚未确认/)).toBeNull()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('确定拒绝时显示原因，允许用户修正后重试', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).endsWith('/update') ? new Response(JSON.stringify({ detail: '空间不足，请清理磁盘' }), { status: 409 }) : originalFetch(path, init))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '一键更新' }))
    expect(await screen.findByText('空间不足，请清理磁盘')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('后台任务失败时显示具体原因，保留重试入口', async () => {
    state.job = { id: 'failed', status: 'failed', component: 'application', version: '2.1.0', message: '更新失败，原版本可用', error: '下载失败：证书校验失败，请检查代理证书' }
    mount()
    expect(await screen.findByText('下载失败：证书校验失败，请检查代理证书')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('需要人工恢复时不允许重新安装覆盖恢复材料', async () => {
    state.job = { id: 'blocked', status: 'manual_recovery', component: 'application', version: '2.1.0', message: '恢复尚未完成' }
    mount(false, true)
    await screen.findByText('恢复尚未完成')
    fireEvent.click(screen.getByRole('button', { name: '直接更新' }))
    expect(writes).toHaveLength(0)
  })
})

describe('版本提醒按组件语义版本比较', () => {
  it.each([['2.0.1', '2.0.0'], ['2.0.1', '2.0.1-rc.1'], ['2.0.1-rc.10', '2.0.1-rc.9'], ['2.0.1+build.2', '2.0.1+build.3']])('当前 %s 不把 %s 误报为更新', async (installed, remote) => {
    state.current = { application: installed, backend: installed, frontend: installed }; state.frontend_version = installed
    state.latest = { version: remote, notes: '线上版本说明', components: { application: { version: remote, url: 'https://github.com/x.zip', sha256: 'a'.repeat(64) } } }
    state.preferences.auto_check = true; sessionStorage.setItem('sunyu-update-checked-at', String(Date.now()))
    mount(false, false, installed)
    await screen.findByText('线上版本说明')
    expect(screen.queryByText(/发现可选更新/)).toBeNull()
  })
  it('数值版本正确比较，前端独立更新同样提醒', async () => {
    state.current = { application: '2.0.9', backend: '2.0.9', frontend: '2.0.9' }; state.frontend_version = '2.0.9'
    state.latest = { version: '2.0.10', notes: '', components: { frontend: { version: '2.0.10', url: 'https://github.com/x.zip', sha256: 'a'.repeat(64) } } }
    state.preferences.auto_check = true; sessionStorage.setItem('sunyu-update-checked-at', String(Date.now()))
    mount(false, false, '2.0.9')
    expect(await screen.findByText('发现可选更新 2.0.10')).toBeTruthy()
  })
})
