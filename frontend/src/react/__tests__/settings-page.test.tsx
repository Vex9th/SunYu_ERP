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
import { requestJson } from '../../api'
import type {
  BackupCreated,
  BackupSettingsResponse,
  SystemOverview,
} from '../../types'
import SettingsPage from '../SettingsPage'

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
    if (path === '/api/system/backups' && backup) return backup
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

describe('系统备份设置保护', () => {
  it('未配置已保存目录时禁用手动备份，不发送请求', async () => {
    mockApi(overview(null))
    renderSettings()
    const backup = await screen.findByRole('button', { name: /立即备份/ })
    expect((backup as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(backup)
    expect(requests('/api/system/backups')).toHaveLength(0)
    expect(screen.getByText('请先配置并保存备份目录。')).toBeTruthy()
  })

  it('目录修改未保存时禁用备份，刷新也不覆盖草稿', async () => {
    mockApi(overview())
    renderSettings()
    const directory = await screen.findByLabelText('备份目录')
    fireEvent.change(directory, { target: { value: '/new-backups' } })
    const backup = screen.getByRole('button', { name: /立即备份/ })
    expect((backup as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(backup)
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() =>
      expect(requests('/api/system/overview')).toHaveLength(2),
    )
    expect((directory as HTMLInputElement).value).toBe('/new-backups')
    expect(requests('/api/system/backups')).toHaveLength(0)
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
      (screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '恢复已保存设置' }))
    expect((screen.getByLabelText('备份目录') as HTMLInputElement).value).toBe(
      '/test-backups',
    )
    expect(
      (screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('备份中切走再返回仍锁定保存和备份，迟到成功只刷新当前页面', async () => {
    const pending = deferred<BackupCreated>()
    mockApi(overview(), pending.promise)
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /立即备份/ }))
    await waitFor(() => expect(requests('/api/system/backups')).toHaveLength(1))
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    const backup = await screen.findByRole('button', { name: /立即备份/ })
    try {
      expect(
        (
          screen.getByRole('button', {
            name: '保存设置',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true)
      fireEvent.click(backup)
      expect(requests('/api/system/backups')).toHaveLength(1)
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
    fireEvent.click(await screen.findByRole('button', { name: /立即备份/ }))
    fireEvent.click(screen.getByRole('link', { name: '打开其他业务' }))
    await act(async () => pending.resolve(completed))
    expect(requests('/api/system/overview')).toHaveLength(1)
    expect(screen.queryByText('备份已完成')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: '返回系统设置' }))
    expect(await screen.findByRole('button', { name: /立即备份/ })).toBeTruthy()
    await screen.findByText('备份已完成')
  })

  it('保存设置中切页返回仍禁止第二次保存，由当前表单接收成功结果', async () => {
    const pending = deferred<BackupSettingsResponse>()
    const data = overview()
    vi.mocked(requestJson).mockImplementation((async (path) => {
      if (path === '/api/system/overview') return data
      if (path === '/api/system/backup-settings') return pending.promise
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
    const backup = await screen.findByRole('button', { name: /立即备份/ })
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
        (screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement)
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
