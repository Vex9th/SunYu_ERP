import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App.vue'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

const overview = {
  data_directory: 'D:\\SunYu ERP\\Data',
  database_path: 'D:\\SunYu ERP\\Data\\sunyu.sqlite3',
  backup: {
    enabled: true,
    directory: 'D:\\SynologyDrive\\SunYu ERP Backups',
    interval_hours: 24,
    retention_days: 30,
    last_run: null,
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status })
}

function mountApp(): VueWrapper {
  return mount(App, {
    attachTo: document.body,
    global: { plugins: [ElementPlus] },
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('App', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('在会话状态返回前显示载入状态', async () => {
    let resolveSession!: (response: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveSession = resolve
      }),
    )

    const wrapper = mountApp()

    expect(wrapper.get('[data-testid="app-loading"]').text()).toContain('正在载入')

    resolveSession(
      jsonResponse({ authenticated: false, password_configured: false }),
    )
    await settle()
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('首次设置')
  })

  it('会话请求失败时不伪装首次设置，并允许重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: '本地服务尚未就绪' }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: false, password_configured: true }),
      )

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="startup-error"]').text()).toContain(
      '本地服务尚未就绪',
    )
    expect(wrapper.find('[data-testid="auth-title"]').exists()).toBe(false)

    await wrapper.get('[data-testid="startup-retry"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
  })

  it('首次设置只提交匹配的六位 ASCII 数字密码', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: false, password_configured: false }),
      )
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()

    await wrapper.get('[data-testid="setup-password"]').setValue('１２３４５６')
    await wrapper.get('[data-testid="setup-confirm"]').setValue('１２３４５６')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('密码必须是 6 位数字')

    await wrapper.get('[data-testid="setup-password"]').setValue('123456')
    await wrapper.get('[data-testid="setup-confirm"]').setValue('654321')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('两次输入的密码不一致')

    await wrapper.get('[data-testid="setup-confirm"]').setValue('123456')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/auth/setup',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: '123456' }),
      }),
    ])
    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: '123456' }),
      }),
    ])
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/system/overview')
    expect(wrapper.get('[data-testid="dashboard"]').text()).toContain('项目中心')
  })

  it('首次设置后的登录失败时保留已设置状态并允许重新登录', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: false, password_configured: false }),
      )
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: '登录会话创建失败' }, 503))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="setup-password"]').setValue('123456')
    await wrapper.get('[data-testid="setup-confirm"]').setValue('123456')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/auth/login')
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain(
      '登录会话创建失败',
    )
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('已设置密码时提交登录请求并展示后端错误', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: false, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: '密码错误' }, 401))

    const wrapper = mountApp()
    await settle()
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')

    await wrapper.get('[data-testid="login-password"]').setValue('123456')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: '123456' }),
      }),
    ])
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('密码错误')
  })

  it('认证后展示本地数据与备份状态，不伪装未完成模块', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()

    const dashboard = wrapper.get('[data-testid="dashboard"]')
    expect(dashboard.text()).toContain('项目中心')
    expect(dashboard.text()).toContain('模块建设中')
    expect(dashboard.text()).toContain(overview.data_directory)
    expect(dashboard.text()).toContain(overview.database_path)
    expect(dashboard.text()).toContain('已启用')
    expect(dashboard.text()).toContain(overview.backup.directory)
    expect(dashboard.text()).toContain('24 小时')
    expect(dashboard.text()).toContain('30 天')
    expect(dashboard.text()).toContain('尚未执行')
    expect(wrapper.find('[data-testid="session-secret"]').exists()).toBe(false)
  })

  it('可关闭自动备份并用 null 保存目录', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: false,
          directory: null,
          interval_hours: 12,
          retention_days: 14,
        }),
      )

    const wrapper = mountApp()
    await settle()

    await wrapper.get('[data-testid="backup-enabled"] input').setValue(false)
    await wrapper.get('[data-testid="backup-interval"] input').setValue('12')
    await wrapper.get('[data-testid="backup-retention"] input').setValue('14')
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/system/backup-settings',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          directory: null,
          interval_hours: 12,
          retention_days: 14,
        }),
      }),
    ])
    expect(wrapper.text()).toContain('备份设置已保存')
  })

  it('启用自动备份时校验并提交修剪后的目录', async () => {
    const disabledOverview = {
      ...overview,
      backup: { ...overview.backup, enabled: false, directory: null },
    }
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(disabledOverview))
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          directory: 'D:\\NAS\\ERP',
          interval_hours: 8760,
          retention_days: 0,
        }),
      )

    const wrapper = mountApp()
    await settle()

    await wrapper.get('[data-testid="backup-enabled"] input').setValue(true)
    await wrapper.get('[data-testid="backup-directory"]').setValue('   ')
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('请输入备份目录')

    await wrapper
      .get('[data-testid="backup-directory"]')
      .setValue('  D:\\NAS\\ERP  ')
    await wrapper.get('[data-testid="backup-interval"] input').setValue('8760')
    await wrapper.get('[data-testid="backup-retention"] input').setValue('0')
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        directory: 'D:\\NAS\\ERP',
        interval_hours: 8760,
        retention_days: 0,
      }),
    )
  })

  it('保存备份设置后保留已有的最近执行状态', async () => {
    const overviewWithRun = {
      ...overview,
      backup: {
        ...overview.backup,
        last_run: {
          status: 'success',
          started_at: '2026-08-27T10:00:00+08:00',
          finished_at: '2026-08-27T10:01:00+08:00',
          target_path: 'D:\\NAS\\ERP\\2026-08-27_100000',
          error_message: null,
        },
      },
    }
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overviewWithRun))
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: true,
          directory: 'D:\\NAS\\ERP',
          interval_hours: 12,
          retention_days: 14,
        }),
      )

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-interval"] input').setValue('12')
    await wrapper.get('[data-testid="backup-retention"] input').setValue('14')
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()

    expect(wrapper.text()).toContain('2026-08-27T10:01:00+08:00')
    expect(wrapper.text()).toContain('D:\\NAS\\ERP\\2026-08-27_100000')
  })

  it('立即备份期间防止重复提交，成功后刷新系统概况', async () => {
    let resolveBackup!: (response: Response) => void
    const updatedOverview = {
      ...overview,
      backup: {
        ...overview.backup,
        last_run: {
          status: 'success',
          started_at: '2026-08-28T10:20:00+08:00',
          finished_at: '2026-08-28T10:20:30+08:00',
          target_path: 'D:\\SynologyDrive\\SunYu ERP Backups\\2026-08-28_102030',
          error_message: null,
        },
      },
    }
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveBackup = resolve
        }),
      )
      .mockResolvedValueOnce(jsonResponse(updatedOverview))

    const wrapper = mountApp()
    await settle()

    const backupButton = wrapper.get('[data-testid="backup-now"]')
    await backupButton.trigger('click')
    await backupButton.trigger('click')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(backupButton.attributes('disabled')).toBeDefined()

    resolveBackup(
      jsonResponse({
        path: 'D:\\SynologyDrive\\SunYu ERP Backups\\2026-08-28_102030',
        created_at: '2026-08-28T10:20:30+08:00',
      }),
    )
    await settle()
    await settle()

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/system/backups')
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/system/overview')
    expect(wrapper.text()).toContain('2026-08-28T10:20:30+08:00')
    expect(wrapper.get('[data-testid="last-run-status"]').text()).toContain('成功')
  })

  it('退出期间防止重复提交，完成后回到密码登录页', async () => {
    let resolveLogout!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveLogout = resolve
        }),
      )

    const wrapper = mountApp()
    await settle()
    const logoutButton = wrapper.get('[data-testid="logout"]')
    await logoutButton.trigger('click')
    await logoutButton.trigger('click')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(logoutButton.attributes('disabled')).toBeDefined()

    resolveLogout(emptyResponse())
    await settle()

    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    ])
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })
})
