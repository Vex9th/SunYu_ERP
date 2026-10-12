import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { App } from 'antd'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { ApiError, requestJson } from '../../api'
import type {
  BackupCreated,
  BackupSettingsResponse,
  SystemOverview,
} from '../../types'
import SettingsPage from '../SettingsPage'
import type { UpdateStatus } from '../UpdatePanel'

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  requestJson: vi.fn(),
}))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element) => original(element)
})
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  const restore = screen.queryByRole('button', { name: '恢复已保存设置' })
  if (restore) fireEvent.click(restore)
  cleanup()
})

function overview(directory: string | null = '/test-backups'): SystemOverview {
  return {
    data_directory: '/test-data',
    database_path: '/test-data/test.db',
    backup: {
      enabled: false,
      directory,
      interval_hours: 24,
      retention_days: 30,
      last_run: null,
    },
    scheduler: { alive: true, last_error_at: null, last_error_code: null },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function mockApi(data: SystemOverview, backup?: Promise<BackupCreated>) {
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return data
    if (path === '/api/system/backup-tasks' && backup) return { task_id: 'test-task' }
    if (path === '/api/system/backup-tasks/test-task' && backup) return backup.then((result) => ({ status: 'success', phase: 'finished', warning: result.warning }))
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
}
function requests(path: string) {
  return vi.mocked(requestJson).mock.calls.filter(([url]) => url === path)
}
function renderSettings() {
  return render(
    <App>
      <MemoryRouter initialEntries={['/settings']}>
        <Link to="/other">打开其他业务</Link>
        <Link to="/settings">返回系统设置</Link>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/other" element={<p>其他业务页面</p>} />
        </Routes>
      </MemoryRouter>
    </App>,
  )
}
const completed: BackupCreated = {
  path: '/test-backups/complete.zip',
  created_at: '2026-10-06T08:00:00Z',
}
const unsupportedUpdate: UpdateStatus = {
  job_id: '', phase: 'idle', message: '', progress: 0,
  current_version: '1.2.4', latest_version: '', update_available: false,
  busy: false, error: '', checked_at: '', can_install: false,
  disabled_reason: '测试环境不安装更新', supported: false,
}

it('设置页显示可选更新，备份草稿未保存时禁止安装', async () => {
  const update = {
    job_id: 'checked', phase: 'available', message: '发现新版本', progress: 0,
    current_version: '1.2.4', latest_version: '1.2.5', update_available: true,
    busy: false, error: '', checked_at: '2026-10-13T09:00:00Z',
    can_install: true, disabled_reason: '', supported: true,
  }
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/updates' || path === '/api/system/updates/check') return update
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  const directory = await screen.findByLabelText('备份目录')
  const install = await screen.findByRole('button', { name: '一键更新' })
  expect((install as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(directory, { target: { value: '/draft-for-update' } })
  expect((install as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('备份设置有未保存的修改，请先保存或恢复后再更新。')).toBeTruthy()
  fireEvent.click(install)
  expect(requests('/api/system/updates/install')).toHaveLength(0)
})

it('安装请求发出即禁用保存和备份，明确失败后恢复原操作', async () => {
  const pending = deferred<UpdateStatus>()
  const available: UpdateStatus = {
    ...unsupportedUpdate, job_id: 'check-1', phase: 'available', latest_version: '1.2.5',
    update_available: true, supported: true, can_install: true, disabled_reason: '',
  }
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/updates' || path === '/api/system/updates/check') return available
    if (path === '/api/system/updates/install') return pending.promise
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  await screen.findByLabelText('备份目录')
  const install = await screen.findByRole('button', { name: '一键更新' })
  await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(install)
  fireEvent.click(screen.getByRole('button', { name: '开始更新' }))
  await waitFor(() => expect(requests('/api/system/updates/install')).toHaveLength(1))
  const save = screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement
  const backup = screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(backup.disabled).toBe(true)
  fireEvent.click(backup)
  expect(requests('/api/system/backup-tasks')).toHaveLength(0)
  await act(async () => pending.resolve({ ...available, job_id: 'apply-1', phase: 'failed', error: '下载失败，服务保持运行' }))
  await waitFor(() => expect(save.disabled).toBe(false))
  expect(backup.disabled).toBe(false)
})

it('已有草稿遇到中断更新时仍可恢复本地设置，保存和备份保持禁用', async () => {
  let interrupted = false
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/updates') return interrupted
      ? { ...unsupportedUpdate, supported: true, can_install: true, disabled_reason: '', phase: 'failed', recovery_required: true }
      : unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  fireEvent.change(await screen.findByLabelText('备份目录'), { target: { value: '/unsaved-draft' } })
  fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
  interrupted = true
  fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
  const restore = await screen.findByRole('button', { name: '恢复已保存设置' })
  const resume = await screen.findByRole('button', { name: '继续恢复更新' })
  const save = screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement
  const backup = screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(true))
  expect(backup.disabled).toBe(true)
  expect((resume as HTMLButtonElement).disabled).toBe(true)
  expect((restore as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(restore)
  await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false))
  expect(save.disabled).toBe(true)
  expect(backup.disabled).toBe(true)
  expect(requests('/api/system/backup-settings')).toHaveLength(0)
  expect(requests('/api/system/backup-tasks')).toHaveLength(0)
})

describe('系统备份设置保护', () => {
  it('未配置已保存目录时禁用手动备份，不发送请求', async () => {
    mockApi(overview(null))
    renderSettings()
    const backup = await screen.findByRole('button', { name: /立即备份|继续查询/ })
    expect((backup as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(backup)
    expect(requests('/api/system/backup-tasks')).toHaveLength(0)
    expect(screen.getByText('请先配置并保存备份目录。')).toBeTruthy()
  })

  it('目录修改未保存时禁用备份，刷新也不覆盖草稿', async () => {
    mockApi(overview())
    renderSettings()
    const directory = await screen.findByLabelText('备份目录')
    fireEvent.change(directory, { target: { value: '/new-backups' } })
    const backup = screen.getByRole('button', { name: /立即备份|继续查询/ })
    expect((backup as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(backup)
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() =>
      expect(requests('/api/system/overview')).toHaveLength(2),
    )
    expect((directory as HTMLInputElement).value).toBe('/new-backups')
    expect(requests('/api/system/backup-tasks')).toHaveLength(0)
  })

  it('切换业务再返回仍保留未提交设置，恢复已保存设置后允许备份', async () => {
    mockApi(overview())
    renderSettings()
    fireEvent.change(await screen.findByLabelText('备份目录'), {
      target: { value: '/draft-backups' },
    })
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    expect(
      ((await screen.findByLabelText('备份目录')) as HTMLInputElement).value,
    ).toBe('/draft-backups')
    expect(
      (screen.getByRole('button', { name: /立即备份|继续查询/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '恢复已保存设置' }))
    expect((screen.getByLabelText('备份目录') as HTMLInputElement).value).toBe(
      '/test-backups',
    )
    expect(
      (screen.getByRole('button', { name: /立即备份|继续查询/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('备份中切走再返回仍锁定保存和备份，迟到成功只刷新当前页面', async () => {
    const pending = deferred<BackupCreated>()
    mockApi(overview(), pending.promise)
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /立即备份|继续查询/ }))
    await waitFor(() => expect(requests('/api/system/backup-tasks')).toHaveLength(1))
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    const backup = await screen.findByRole('button', { name: /立即备份|继续查询/ })
    try {
      expect(
        (
          screen.getByRole('button', {
            name: '保存设置',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true)
      fireEvent.click(backup)
      expect(requests('/api/system/backup-tasks')).toHaveLength(1)
    } finally {
      await act(async () => pending.resolve(completed))
    }
    await waitFor(() =>
      expect(requests('/api/system/overview')).toHaveLength(3),
    )
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: '保存设置',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    )
  })

  it('离开设置后备份响应不刷新旧页面或弹消息，返回后可核对结果', async () => {
    const pending = deferred<BackupCreated>()
    mockApi(overview(), pending.promise)
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /立即备份|继续查询/ }))
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    await act(async () => pending.resolve(completed))
    expect(requests('/api/system/overview')).toHaveLength(1)
    expect(screen.queryByText('备份已完成')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    expect(await screen.findByRole('button', { name: /立即备份|继续查询/ })).toBeTruthy()
    await screen.findByText('备份已完成')
  })

  it('保存设置中切页返回仍禁止第二次保存，由当前表单接收成功结果', async () => {
    const pending = deferred<BackupSettingsResponse>()
    const data = overview()
    vi.mocked(requestJson).mockImplementation((async (path) => {
      if (path === '/api/system/overview') return data
      if (path === '/api/system/backup-settings') return pending.promise
      if (path === '/api/system/updates') return unsupportedUpdate
      throw new Error(`未预期的请求：${path}`)
    }) as typeof requestJson)
    renderSettings()
    fireEvent.change(await screen.findByLabelText('备份目录'), {
      target: { value: '/new-backups' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() =>
      expect(requests('/api/system/backup-settings')).toHaveLength(1),
    )
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    const backup = await screen.findByRole('button', { name: /立即备份|继续查询/ })
    try {
      expect((backup as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
      expect(requests('/api/system/backup-settings')).toHaveLength(1)
    } finally {
      const saved: BackupSettingsResponse = {
        enabled: false,
        directory: '/new-backups',
        interval_hours: 24,
        retention_days: 30,
      }
      data.backup = { ...saved, last_run: null }
      await act(async () => pending.resolve(saved))
    }
    await waitFor(() =>
      expect(
        (screen.getByLabelText('备份目录') as HTMLInputElement).value,
      ).toBe('/new-backups'),
    )
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /立即备份|继续查询/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
    expect(requests('/api/system/backup-settings')[0]![1]?.body).toEqual({
      enabled: false,
      directory: '/new-backups',
      interval_hours: 24,
      retention_days: 30,
    })
  })
})

it('轮询暂时超时继续等待后台任务，不把网络错误显示为备份失败', async () => {
  let polls = 0
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/backup-tasks') return { task_id: 'slow-task' }
    if (path === '/api/system/backup-tasks/slow-task') {
      polls += 1
      if (polls === 1) throw new Error('Request timed out')
      return { status: 'success', phase: 'finished' }
    }
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  fireEvent.click(await screen.findByRole('button', { name: /立即备份|继续查询/ }))
  expect(await screen.findByText(/暂时无法读取状态/)).toBeTruthy()
  expect(screen.queryByText('Request timed out')).toBeNull()
  expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(true)
  await screen.findByText('备份已完成', {}, { timeout: 3000 })
  expect(polls).toBe(2)
  expect(sessionStorage.getItem('sunyu-backup-task')).toBeNull()
})


it('恢复的任务编号确定不存在时停止轮询并解除设置锁，结果标记为无法确认', async () => {
  sessionStorage.setItem('sunyu-backup-task', 'restored-task')
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/backup-tasks/restored-task')
      throw new ApiError('Backup task not found', 404)
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  await screen.findByText(/备份任务记录不存在/)
  expect(sessionStorage.getItem('sunyu-backup-task')).toBeNull()
  expect(requests('/api/system/backup-tasks/restored-task')).toHaveLength(1)
  expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(false)
})

it('连续五次无法读取状态后停止自动查询，保留编号供用户恢复连接后核对', async () => {
  sessionStorage.setItem('sunyu-backup-task', 'offline-task')
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/backup-tasks/offline-task')
      throw new ApiError('请求超时', 0, 'REQUEST_TIMEOUT')
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  await screen.findByText(/暂时无法确认备份结果，已停止自动查询/, {}, { timeout: 7000 })
  expect(requests('/api/system/backup-tasks/offline-task')).toHaveLength(5)
  expect(sessionStorage.getItem('sunyu-backup-task')).toBe('offline-task')
  expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(false)
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/backup-tasks/offline-task') return { status: 'success', phase: 'finished' }
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  fireEvent.click(screen.getByRole('button', { name: /继续查询/ }))
  await screen.findByText('备份已完成')
  expect(requests('/api/system/backup-tasks')).toHaveLength(0)
  expect(sessionStorage.getItem('sunyu-backup-task')).toBeNull()
}, 10000)

it('离页期间达到查询上限后，首次返回继续核对保留任务且不创建新备份', async () => {
  sessionStorage.setItem('sunyu-backup-task', 'away-task')
  let recovered = false
  vi.mocked(requestJson).mockImplementation((async (path) => {
    if (path === '/api/system/overview') return overview()
    if (path === '/api/system/backup-tasks/away-task') {
      if (!recovered) throw new ApiError('请求超时', 0, 'REQUEST_TIMEOUT')
      return { status: 'success', phase: 'finished' }
    }
    if (path === '/api/system/updates') return unsupportedUpdate
    throw new Error(`未预期的请求：${path}`)
  }) as typeof requestJson)
  renderSettings()
  await screen.findByText(/暂时无法读取状态/)
  fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
  await waitFor(() => expect(requests('/api/system/backup-tasks/away-task')).toHaveLength(5), { timeout: 7000 })
  await act(async () => { await Promise.resolve() })
  recovered = true
  fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
  await screen.findByText('备份已完成')
  expect(requests('/api/system/backup-tasks/away-task')).toHaveLength(6)
  expect(requests('/api/system/backup-tasks')).toHaveLength(0)
  expect(sessionStorage.getItem('sunyu-backup-task')).toBeNull()
}, 10000)
