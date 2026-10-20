import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { App } from 'antd'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestJson } from '../../api'
import UpdatePanel, { type UpdateStatus } from '../UpdatePanel'

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()), requestJson: vi.fn(),
}))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element) => original(element)
})
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); sessionStorage.clear() })
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); sessionStorage.clear() })

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    job_id: 'check-1', phase: 'available', message: '发现新版本 1.2.5', progress: 0,
    current_version: '1.2.4', latest_version: '1.2.5', update_available: true,
    busy: false, error: '', checked_at: '2026-10-13T09:00:00Z',
    can_install: true, disabled_reason: '', supported: true, ...overrides,
  }
}
function calls(path: string) { return vi.mocked(requestJson).mock.calls.filter(([url]) => url.split('?')[0] === path) }
function stub(handler: (path: string) => UpdateStatus | Promise<UpdateStatus>) {
  vi.mocked(requestJson).mockImplementation((async (path) => handler(path)) as typeof requestJson)
}
async function flush() { await act(async () => { await Promise.resolve() }) }
async function tick(ms = 2000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function panel(props: Parameters<typeof UpdatePanel>[0] = {}) {
  return render(<App><UpdatePanel {...props} /></App>)
}
async function confirmInstall() {
  fireEvent.click(screen.getByRole('button', { name: '一键更新' }))
  expect(screen.getByText('更新前请保存工作')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '开始更新' }))
  await flush()
}

describe('可选的一键更新', () => {
  it('进入只自动检查一次，无更新时不允许安装', async () => {
    stub(() => status({ phase: 'idle', update_available: false, latest_version: '1.2.4', message: '当前已是最新版本' }))
    const view = panel()
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(1)
    expect(screen.getByText('当前已是最新版本')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<App><UpdatePanel installBlockedReason="备份进行中" /></App>)
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(1)
    expect(calls('/api/system/updates/install')).toHaveLength(0)
  })

  it('远程可检查但明确限制安装，开发环境显示后端原因', async () => {
    stub(() => status({ can_install: false, disabled_reason: '请在运行程序的本机打开设置页安装更新。' }))
    const view = panel()
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(1)
    expect(screen.getByText('请在运行程序的本机打开设置页安装更新。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    stub(() => status({ supported: false, can_install: false, disabled_reason: '开发模式不支持安装更新。' }))
    panel()
    await flush()
    expect(screen.getByText('开发模式不支持安装更新。')).toBeTruthy()
    expect(calls('/api/system/updates/check')).toHaveLength(1)
  })

  it('安装必须确认，重复点击不重发，短暂断线后仅GET继续核对', async () => {
    let installed = false
    let polls = 0
    const busy = vi.fn()
    stub((path) => {
      if (path.endsWith('/install')) { installed = true; return status({ job_id: 'apply-1', phase: 'restarting', busy: true, progress: 90 }) }
      if (path.split('?')[0] === '/api/system/updates' && installed) {
        if (++polls === 1) throw new ApiError('连接中断', 0)
        return status({ job_id: 'apply-1', phase: 'success', current_version: '1.2.5', busy: false, progress: 100, message: '更新完成' })
      }
      return status()
    })
    panel({ onInstallBusyChange: busy })
    await flush()
    expect(calls('/api/system/updates/install')).toHaveLength(0)
    await confirmInstall()
    fireEvent.click(screen.getByRole('button', { name: '一键更新' }))
    expect(calls('/api/system/updates/install')).toHaveLength(1)
    expect(busy).toHaveBeenLastCalledWith(true)
    await tick()
    expect(screen.getByText(/正在重新连接/)).toBeTruthy()
    await tick()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(calls('/api/system/updates/install')).toHaveLength(1)
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('安装响应丢失时不把旧检查结果当成完成，也不再次提交安装', async () => {
    let attempted = false
    let recovered = false
    stub((path) => {
      if (path.endsWith('/install')) { attempted = true; throw new ApiError('超时', 0) }
      if (attempted && recovered) return status({ job_id: JSON.parse(sessionStorage.getItem('sunyu-update-install')!).job_id, phase: 'success', progress: 100, current_version: '1.2.5' })
      if (attempted) throw new ApiError('原请求尚未接受', 410)
      return status()
    })
    panel()
    await flush()
    await confirmInstall()
    await tick()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '刷新使用新版' })).toBeNull()
    recovered = true
    await tick()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(calls('/api/system/updates/install')).toHaveLength(1)
  })

  it('重连超时提供继续查询，恢复只查询原任务并保持安装互斥', async () => {
    let started = false
    let online = false
    stub((path) => {
      if (path.endsWith('/install')) { started = true; return status({ job_id: 'apply-3', phase: 'installing', busy: true }) }
      if (started) {
        if (!online) throw new ApiError('离线', 0)
        return status({ job_id: 'apply-3', phase: 'success', current_version: '1.2.5' })
      }
      return status()
    })
    panel()
    await flush()
    await confirmInstall()
    await tick(64000)
    expect(screen.getByText(/已停止自动查询/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '一键更新' }) as HTMLButtonElement).disabled).toBe(true)
    const before = calls('/api/system/updates').length
    await tick(10000)
    expect(calls('/api/system/updates')).toHaveLength(before)
    online = true
    fireEvent.click(screen.getByRole('button', { name: '继续查询更新状态' }))
    await flush()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(calls('/api/system/updates/install')).toHaveLength(1)
  })

  it('挂载时已有更新任务直接续查，卸载后不再轮询', async () => {
    stub(() => status({ job_id: 'existing-job', phase: 'downloading', busy: true, progress: 25 }))
    const view = panel()
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(0)
    await tick()
    const count = calls('/api/system/updates').length
    view.unmount()
    await tick(10000)
    expect(calls('/api/system/updates')).toHaveLength(count)
    expect(calls('/api/system/updates/install')).toHaveLength(0)
  })

  it('失败保留具体原因并允许确认后重试安装', async () => {
    let attempt = 0
    stub((path) => path.endsWith('/install')
      ? status({ job_id: `apply-${++attempt}`, phase: 'failed', error: '文件校验失败', message: '安装未完成' })
      : status())
    panel()
    await flush()
    await confirmInstall()
    expect(screen.getByText('文件校验失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试更新' }))
    fireEvent.click(screen.getByRole('button', { name: '开始更新' }))
    await flush()
    expect(calls('/api/system/updates/install')).toHaveLength(2)
  })

  it('中断事务不再检查新版，无新版本也能确认后继续恢复更新', async () => {
    stub((path) => path.endsWith('/install')
      ? status({ job_id: 'recovery-job', phase: 'success', current_version: '1.2.5', update_available: false })
      : { ...status({ phase: 'failed', update_available: false, message: '更新曾中断，请继续恢复。' }), recovery_required: true })
    const busy = vi.fn()
    panel({ onInstallBusyChange: busy })
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(0)
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true)
    const resume = screen.getByRole('button', { name: '继续恢复更新' })
    expect((resume as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(resume)
    expect(calls('/api/system/updates/install')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '开始更新' }))
    await flush()
    expect(calls('/api/system/updates/install')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('确认期间出现未保存设置会禁止提交，成功后也不会强制刷新', async () => {
    stub(() => status())
    const view = panel()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '一键更新' }))
    view.rerender(<App><UpdatePanel installBlockedReason="请先保存备份设置" /></App>)
    fireEvent.click(screen.getByRole('button', { name: '开始更新' }))
    await flush()
    expect(calls('/api/system/updates/install')).toHaveLength(0)
  })

  it('登录过期后停止轮询，重新登录后只继续查询原安装任务', async () => {
    let reads = 0
    let signedInAgain = false
    stub(() => {
      if (++reads === 1) return status({ job_id: 'login-job', phase: 'restarting', busy: true })
      if (!signedInAgain) throw new ApiError('Authentication required', 401)
      return status({ job_id: 'login-job', phase: 'success', current_version: '1.2.5' })
    })
    panel()
    await flush()
    await tick()
    expect(screen.getByText(/请重新登录后继续查询/)).toBeTruthy()
    await tick(10000)
    expect(reads).toBe(2)
    expect(calls('/api/system/updates/install')).toHaveLength(0)
    signedInAgain = true
    fireEvent.click(screen.getByRole('button', { name: '继续查询更新状态' }))
    await flush()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
  })

  it('恢复未确认安装时首次查询已过期应立即提示登录，不继续自动重试', async () => {
    sessionStorage.setItem('sunyu-update-install', JSON.stringify({ job_id: 'old-job', previous_job_id: 'check-1' }))
    stub(() => { throw new ApiError('Authentication required', 401) })
    panel()
    await flush()
    expect(screen.getByText(/请重新登录后继续查询/)).toBeTruthy()
    await tick(10000)
    expect(calls('/api/system/updates')).toHaveLength(1)
  })

  it('卸载会取消在途请求，迟到结果不发起检查或后台轮询', async () => {
    let resolve!: (value: UpdateStatus) => void
    stub(() => new Promise<UpdateStatus>((done) => { resolve = done }))
    const view = panel()
    const signal = calls('/api/system/updates')[0]![1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => resolve(status({ phase: 'checking', busy: true })))
    await tick(10000)
    expect(calls('/api/system/updates')).toHaveLength(1)
    expect(calls('/api/system/updates/check')).toHaveLength(0)
  })

  it('StrictMode 重挂载只自动发起一次检查，手动重复点击也互斥', async () => {
    let resolve!: (value: UpdateStatus) => void
    let checks = 0
    stub((path) => {
      if (path.endsWith('/check') && ++checks === 2)
        return new Promise<UpdateStatus>((done) => { resolve = done })
      return status()
    })
    render(<StrictMode><App><UpdatePanel /></App></StrictMode>)
    await flush()
    expect(calls('/api/system/updates/check')).toHaveLength(1)
    const check = screen.getByRole('button', { name: '检查更新' })
    fireEvent.click(check)
    fireEvent.click(check)
    expect(calls('/api/system/updates/check')).toHaveLength(2)
    await act(async () => resolve(status()))
  })

  it('安装被明确拒绝时显示原因并解除本页操作锁', async () => {
    const busy = vi.fn()
    stub((path) => {
      if (path.endsWith('/install')) throw new ApiError('仅允许本机安装', 403)
      return status()
    })
    panel({ onInstallBusyChange: busy })
    await flush()
    await confirmInstall()
    expect(screen.getByText('仅允许本机安装')).toBeTruthy()
    expect(busy).toHaveBeenLastCalledWith(false)
    await tick(10000)
    expect(calls('/api/system/updates/install')).toHaveLength(1)
  })
  it('安装终态被其他检查覆盖后，按原任务查询并解除操作锁', async () => {
    sessionStorage.setItem('sunyu-update-install', JSON.stringify({ job_id: 'install-A', previous_job_id: 'check-A' }))
    const busy = vi.fn()
    stub((path) => path === '/api/system/updates?job_id=install-A'
      ? status({ job_id: 'install-A', phase: 'success', current_version: '1.2.5' })
      : status({ job_id: 'check-B', phase: 'idle', current_version: '1.2.5', update_available: false }))
    panel({ onInstallBusyChange: busy })
    await flush()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(sessionStorage.getItem('sunyu-update-install')).toBeNull()
    expect(calls('/api/system/updates/install')).toHaveLength(0)
  })

  it('提交前保存请求ID，响应丢失也能定向查询而不把其他任务当成结果', async () => {
    let target = ''
    vi.mocked(requestJson).mockImplementation((async (path, options) => {
      if (path.endsWith('/install')) {
        target = (options?.body as { job_id: string }).job_id
        expect(target).toMatch(/^[a-f0-9-]{36}$/)
        throw new ApiError('连接中断', 0)
      }
      if (target && path === `/api/system/updates?job_id=${target}`)
        return status({ job_id: target, phase: 'success', current_version: '1.2.5' })
      return status()
    }) as typeof requestJson)
    panel()
    await flush()
    await confirmInstall()
    await tick()
    expect(screen.getByRole('button', { name: '刷新使用新版' })).toBeTruthy()
    expect(calls('/api/system/updates/install')).toHaveLength(1)
  })

  it.each([
    { name: '空闲', current: status({ job_id: 'check-new', phase: 'idle', update_available: false }), locked: false, pendingId: null },
    { name: '其他任务成功', current: status({ job_id: 'install-new', phase: 'success', update_available: false }), locked: false, pendingId: null },
    { name: '新任务正在安装', current: status({ job_id: 'install-new', phase: 'installing', busy: true }), locked: true, pendingId: 'install-new' },
    { name: '仍需恢复更新', current: status({ job_id: 'install-new', phase: 'failed', recovery_required: true, update_available: false }), locked: true, pendingId: null },
  ])('旧任务记录被淘汰后核对当前$name，不误报旧任务成功或永久锁住设置', async ({ current, locked, pendingId }) => {
    sessionStorage.setItem('sunyu-update-install', JSON.stringify({ job_id: 'forgotten-job', previous_job_id: '' }))
    const busy = vi.fn()
    stub((path) => {
      if (path === '/api/system/updates?job_id=forgotten-job') throw new ApiError('任务记录已过期', 410)
      if (path === '/api/system/updates') return current
      throw new Error(`未预期的请求：${path}`)
    })
    panel({ onInstallBusyChange: busy })
    await flush()
    expect(busy).toHaveBeenLastCalledWith(true)
    await tick(60000)
    expect(screen.getByText(/原任务结果已无法确认/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '刷新使用新版' })).toBeNull()
    expect(screen.queryByText('更新已完成，请保存其他页面的工作后刷新使用新版。')).toBeNull()
    expect(busy).toHaveBeenLastCalledWith(locked)
    expect(JSON.parse(sessionStorage.getItem('sunyu-update-install') ?? 'null')?.job_id ?? null).toBe(pendingId)
    expect(calls('/api/system/updates/install')).toHaveLength(0)
    expect(calls('/api/system/updates/check')).toHaveLength(0)
    if (current.recovery_required) {
      expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByRole('button', { name: '继续恢复更新' }) as HTMLButtonElement).disabled).toBe(false)
    }
  })

})

describe('更新网络错误展示', () => {
  it('旧更新器的 TLS 错误显示一次简短提示，隐藏签名链接并提供官方下载入口', async () => {
    const error = '新版本尚未提供可验证的单文件更新包：Get "https://release-assets.githubusercontent.com/asset?sig=PRIVATE_SIGNED_QUERY": net/http: TLS handshake timeout'
    stub(() => status({ phase: 'failed', error, message: error }))
    panel()
    await flush()
    expect(screen.getAllByText('连接 GitHub 下载服务超时，请检查网络后重试。')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('PRIVATE_SIGNED_QUERY')
    expect(document.body.textContent).not.toContain('尚未提供可验证')
    expect(screen.getByRole('link', { name: '手动下载完整包' }).getAttribute('href')).toBe('https://github.com/Vex9th/SunYu_ERP/releases/latest')
    expect(screen.getByRole('link', { name: '蓝奏下载（提取码 hru1）' }).getAttribute('href')).toBe('https://urldown.lanzouw.com/b019w91rof')
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('普通错误只显示一次并保留原因', async () => {
    stub(() => status({ phase: 'failed', error: '文件校验失败', message: '文件校验失败' }))
    panel()
    await flush()
    expect(screen.getAllByText('文件校验失败')).toHaveLength(1)
  })
})
