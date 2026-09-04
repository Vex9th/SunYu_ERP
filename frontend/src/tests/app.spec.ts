import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App.vue'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

const overview = {
  data_directory: 'D:\\SunYu ERP\\Data',
  database_path: 'D:\\SunYu ERP\\Data\\sunyu.sqlite3',
  scheduler: {
    alive: true,
    last_error_at: null,
    last_error_code: null,
  },
  backup: {
    enabled: true,
    directory: 'D:\\SynologyDrive\\SunYu ERP Backups',
    interval_hours: 24,
    retention_days: 30,
    last_run: null,
  },
}

const portfolioDashboard = {
  generated_at: '2026-08-31T10:00:00+08:00',
  summary: {
    active_project_count: 0,
    overdue_receivable_count: 0,
    upcoming_delivery_count: 0,
    contracted_amount_cents: 0,
    received_amount_cents: 0,
    outstanding_receivable_cents: 0,
  },
  projects: [],
  todos: [],
  backup: { healthy: true, last_success_at: null, message: null },
}

const emptyProjectOperating = {
  stages: [],
  commercial: { accepted_quote: null, contracts: [] },
  costs: {
    material_consumed_cents: 0,
    labor_cents: 0,
    field_material_cents: 0,
    total_cents: 0,
    procurement_committed_cents: 0,
    procurement_received_cents: 0,
    procurement_paid_cents: 0,
    completeness: 'complete',
  },
  profit: {
    contracted_amount_cents: 0,
    actual_cost_cents: 0,
    actual_profit_cents: 0,
    margin_basis_points: null,
  },
  receivables: {
    contracted_amount_cents: 0,
    receivable_amount_cents: 0,
    received_amount_cents: 0,
    allocated_received_amount_cents: 0,
    unallocated_received_amount_cents: 0,
    outstanding_receivable_cents: 0,
    contract_collection_basis_points: null,
    terms: [],
    receipts: [],
  },
  todos: [],
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
  let businessFetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    businessFetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse([]))
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/dashboard') return jsonResponse(portfolioDashboard)
      if (path.startsWith('/api/projects') || path.startsWith('/api/companies')) {
        return businessFetchMock(input, init)
      }
      return fetchMock(input, init)
    }))
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
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
    expect(wrapper.find('[data-testid="nav-projects"]').exists()).toBe(true)
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

  it('登录页使用紧凑单栏工具布局，不显示宣传式大标题', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ authenticated: false, password_configured: true }),
    )

    const wrapper = mountApp()
    await settle()

    expect(wrapper.find('[data-testid="auth-context"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="auth-form-side"]').classes()).toContain('auth-main')
    expect(wrapper.text()).not.toContain('把每一个非标项目')
    expect(wrapper.get('.auth-card').text()).toContain('数据保存在当前主机')
  })

  it('认证后展示精简主导航和真实经营总览', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="portfolio-operating-overview"]').exists()).toBe(true)
    })

    const dashboard = wrapper.get('[data-testid="dashboard"]')
    expect(dashboard.get('[data-testid="nav-overview"]').text()).toBe('总览')
    expect(dashboard.get('[data-testid="workbench-overview"]').text()).toContain('今天先处理什么')
    expect(dashboard.get('[data-testid="portfolio-operating-overview"]').text()).not.toContain('真实后端')
    expect(dashboard.get('[data-testid="portfolio-operating-overview"]').isVisible()).toBe(true)
    expect(dashboard.find('[data-testid="portfolio-preview-toggle"]').exists()).toBe(false)
    expect(dashboard.find('.preview-collapse').exists()).toBe(false)
    expect(dashboard.get('[data-testid="workbench-summary"]').findAll('.workbench-summary__item')).toHaveLength(4)
    expect(dashboard.find('.system-brief').exists()).toBe(false)
    expect(dashboard.find('[data-testid="workbench-recent-projects"]').exists()).toBe(false)
    expect(dashboard.get('[data-testid="workbench-active-projects"]').text()).toContain('0')
    expect(dashboard.get('[data-testid="workbench-companies"]').text()).toContain('0')
    expect(dashboard.findAll('.workspace-menu [data-testid^="nav-"]').map((item) => item.text())).toEqual([
      '总览', '项目', '联系人', '库存', '设置',
    ])
    expect(dashboard.find('[data-testid="nav-procurement"]').exists()).toBe(false)
    expect(dashboard.find('[data-testid="nav-workforce"]').exists()).toBe(false)
    expect(dashboard.find('[data-testid="nav-delivery"]').exists()).toBe(false)
    expect(dashboard.get('[data-testid="scheduler-status"]').isVisible()).toBe(false)

    await dashboard.get('[data-testid="nav-projects"]').trigger('click')
    await settle()
    expect(dashboard.get('[data-testid="projects-empty"]').text()).toContain('暂无在建项目')
    expect(dashboard.get('[data-testid="projects-empty"]').isVisible()).toBe(true)

    await dashboard.get('[data-testid="nav-inventory"]').trigger('click')
    await vi.waitFor(() => {
      expect(dashboard.find('[data-testid="inventory-center"]').exists()).toBe(true)
    })
    expect(dashboard.get('[data-testid="inventory-center"]').isVisible()).toBe(true)

    await dashboard.get('[data-testid="nav-system"]').trigger('click')
    expect(dashboard.get('[data-testid="scheduler-status"]').isVisible()).toBe(true)
    expect(dashboard.get('[data-testid="backup-now"]').isVisible()).toBe(true)
    expect(dashboard.text()).toContain(overview.data_directory)
    expect(dashboard.text()).toContain(overview.database_path)
    expect(dashboard.text()).toContain('备份调度器')
    expect(dashboard.text()).toContain('运行中')
    expect(dashboard.text()).toContain('无')
    expect(dashboard.text()).toContain('已启用')
    expect(dashboard.text()).toContain(overview.backup.directory)
    expect(dashboard.text()).toContain('24 小时')
    expect(dashboard.text()).toContain('30 天')
    expect(dashboard.text()).toContain('尚未执行')
    expect(wrapper.find('[data-testid="session-secret"]').exists()).toBe(false)
  })

  it('生产环境保留真实经营页面并明确数据来源', async () => {
    vi.stubEnv('DEV', false)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="nav-projects"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="nav-companies"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="nav-system"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="nav-inventory"]').isVisible()).toBe(true)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="portfolio-operating-overview"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="portfolio-operating-overview"]').text()).not.toContain('真实后端')
  })

  it('总工作台只用现有项目和公司接口生成真实摘要', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/projects?status=active') {
        return jsonResponse([{
          id: 21,
          project_code: 'SY-2026-001',
          company_id: 1,
          name: '装配线改造',
          description: null,
          status: 'active',
          archive_reason: null,
          archived_at: null,
          created_at: '2026-08-28T02:00:00+00:00',
          updated_at: '2026-08-28T02:00:00+00:00',
          company_name: '苏州出发科技',
        }])
      }
      if (path === '/api/companies') {
        return jsonResponse([{
          id: 1,
          name: '苏州出发科技',
          taxpayer_id: '91320000TEST',
          registered_address: null,
          registered_phone: null,
          bank_name: null,
          bank_account: null,
          notes: null,
          created_at: '2026-08-28T01:00:00+00:00',
          updated_at: '2026-08-28T01:00:00+00:00',
          contact_count: 2,
        }])
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="workbench-active-projects"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="workbench-companies"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="workbench-overview"]').text()).toContain('联系人2')
    expect(wrapper.get('[data-testid="workbench-overview"]').text()).toContain('资料待完善0')
  })

  it('首页项目先返回时立即显示项目结果，不等待公司请求', async () => {
    let resolveCompanies!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/projects?status=active') {
        return jsonResponse([{
          id: 21,
          project_code: 'SY-2026-001',
          company_id: 1,
          name: '装配线改造',
          description: null,
          status: 'active',
          archive_reason: null,
          archived_at: null,
          created_at: '2026-08-28T02:00:00+00:00',
          updated_at: '2026-08-28T02:00:00+00:00',
          company_name: '苏州出发科技',
        }])
      }
      if (path === '/api/companies') {
        return new Promise<Response>((resolve) => { resolveCompanies = resolve })
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="workbench-active-projects"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="workbench-companies"]').text()).toContain('正在读取')

    resolveCompanies(jsonResponse([]))
    await settle()
  })

  it('总工作台任一并发接口返回 401 都立即退出失效会话', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/projects?status=active') {
        return jsonResponse({ detail: '项目服务暂时不可用' }, 503)
      }
      if (path === '/api/companies') {
        return jsonResponse({ detail: 'Authentication required' }, 401)
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('登录状态已失效')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('总工作台不等待悬挂请求即可处理已经返回的 401', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/projects?status=active') {
        return jsonResponse({ detail: '登录状态已失效' }, 401)
      }
      if (path === '/api/companies') {
        return new Promise<Response>(() => undefined)
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('登录状态已失效')
  })

  it('总工作台接口失败时将未知指标显示为占位符，不伪装成零数据', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/projects?status=active') {
        return jsonResponse({ detail: '项目服务暂时不可用' }, 503)
      }
      if (path === '/api/companies') {
        return jsonResponse([{
          id: 1,
          name: '苏州出发科技',
          taxpayer_id: null,
          registered_address: null,
          registered_phone: null,
          bank_name: null,
          bank_account: null,
          notes: null,
          created_at: '2026-08-28T01:00:00+00:00',
          updated_at: '2026-08-28T01:00:00+00:00',
          contact_count: 1,
        }])
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="workbench-error"]').text()).toContain('项目服务暂时不可用')
    expect(wrapper.get('[data-testid="workbench-active-projects"]').text()).toContain('--')
    expect(wrapper.get('[data-testid="workbench-companies"]').text()).toContain('1')
    expect(wrapper.get('[data-testid="workbench-overview"]').text()).not.toContain('暂无在建项目')
  })

  it('展示已停止调度器及最近错误信息', async () => {
    const overviewWithSchedulerError = {
      ...overview,
      scheduler: {
        alive: false,
        last_error_at: '2026-08-28T06:30:00+08:00',
        last_error_code: 'cleanup:OSError',
      },
    }
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overviewWithSchedulerError))

    const wrapper = mountApp()
    await settle()

    const scheduler = wrapper.get('[data-testid="scheduler-status"]')
    expect(scheduler.text()).toContain('已停止')
    expect(scheduler.text()).toContain('2026年8月28日 06:30')
    expect(scheduler.text()).toContain('cleanup:OSError')
  })

  it('会话有效但系统概况失败时显示可重试结果，并防止重复重试', async () => {
    let resolveRetry!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: '系统概况暂时不可用' }, 503))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRetry = resolve
        }),
      )

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="overview-error"]').text()).toContain(
      '系统概况暂时不可用',
    )
    expect(wrapper.get('[data-testid="scheduler-summary"]').text()).toContain('状态未知')
    expect(wrapper.get('[data-testid="scheduler-summary"]').text()).not.toContain('已停止')
    expect(wrapper.text()).not.toContain('正在读取系统状态')

    const retryButton = wrapper.get('[data-testid="overview-retry"]')
    await retryButton.trigger('click')
    await retryButton.trigger('click')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(wrapper.get('[data-testid="overview-loading"]').text()).toContain(
      '正在读取系统状态',
    )
    expect(wrapper.find('[data-testid="overview-retry"]').exists()).toBe(false)

    resolveRetry(jsonResponse(overview))
    await settle()
    await settle()

    expect(wrapper.find('[data-testid="overview-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="dashboard"]').text()).toContain(
      overview.database_path,
    )
  })

  it('系统概况返回 401 时清理工作台并返回登录页', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: '登录状态已失效' }, 401))

    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain(
      '登录状态已失效',
    )
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('关闭自动备份时保留 NAS 目录', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(
        jsonResponse({
          enabled: false,
          directory: overview.backup.directory,
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
          enabled: false,
          directory: overview.backup.directory,
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
        enabled: true,
        directory: 'D:\\NAS\\ERP',
        interval_hours: 8760,
        retention_days: 0,
      }),
    )
  })

  it('设置有未保存修改时不允许误用旧目录立即备份', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    const backupButton = wrapper.get('[data-testid="backup-now"]')
    expect(backupButton.text()).toContain('按已保存设置立即备份')

    await wrapper.get('[data-testid="backup-directory"]').setValue('D:\\NAS\\New')

    expect(backupButton.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('请先保存当前修改，再执行手动备份')
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

    expect(wrapper.text()).toContain('2026年8月27日 10:01')
    expect(wrapper.text()).toContain('D:\\NAS\\ERP\\2026-08-27_100000')
  })

  it('保存备份设置返回 401 时清理概况并返回登录页', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: '请重新登录' }, 401))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('请重新登录')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('保存备份设置的非 401 错误保留在工作台', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: '备份目录不可写' }, 503))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="dashboard"]').text()).toContain('备份目录不可写')
    expect(wrapper.find('[data-testid="auth-title"]').exists()).toBe(false)
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
    expect(wrapper.get('[data-testid="backup-enabled"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-directory"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-interval"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-retention"] input').attributes('disabled')).toBeDefined()

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
    expect(wrapper.text()).toContain('2026年8月28日 10:20')
    expect(wrapper.get('[data-testid="last-run-status"]').text()).toContain('成功')
    expect(document.body.textContent).toContain('备份已完成')
    expect(document.body.textContent).not.toContain(
      '备份已完成，但自动清理失败，请检查备份目录',
    )
  })

  it('手动备份成功但带 warning 时显示固定中文警告', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(
        jsonResponse({
          path: 'D:\\SynologyDrive\\SunYu ERP Backups\\2026-08-28_103000',
          created_at: '2026-08-28T10:30:00+08:00',
          warning: 'Backup created but cleanup failed',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()
    await settle()

    expect(document.body.textContent).toContain(
      '备份已完成，但自动清理失败，请检查备份目录',
    )
  })

  it('备份已创建但概况刷新失败时仍立即提示成功并保留重试', async () => {
    let resolveRefresh!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            path: 'D:\\SynologyDrive\\SunYu ERP Backups\\2026-08-28_104000',
            created_at: '2026-08-28T10:40:00+08:00',
          },
          201,
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        }),
      )

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(document.body.textContent).toContain('备份已完成')

    resolveRefresh(jsonResponse({ detail: '系统概况暂时不可用' }, 503))
    await settle()
    await settle()

    expect(document.body.textContent).toContain('备份已完成')
    expect(wrapper.get('[data-testid="overview-error"]').text()).toContain(
      '系统概况暂时不可用',
    )
    expect(wrapper.find('[data-testid="overview-retry"]').exists()).toBe(true)
  })

  it('备份已创建但概况刷新返回 401 时仍立即警告并回到登录', async () => {
    let resolveRefresh!: (response: Response) => void
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            path: 'D:\\SynologyDrive\\SunYu ERP Backups\\2026-08-28_104500',
            created_at: '2026-08-28T10:45:00+08:00',
            warning: 'Backup created but cleanup failed',
          },
          201,
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        }),
      )

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(document.body.textContent).toContain(
      '备份已完成，但自动清理失败，请检查备份目录',
    )

    resolveRefresh(jsonResponse({ detail: '会话已过期' }, 401))
    await settle()
    await settle()

    expect(document.body.textContent).toContain(
      '备份已完成，但自动清理失败，请检查备份目录',
    )
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('会话已过期')
  })

  it('立即备份返回 401 时清理概况并返回登录页', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: '会话已过期' }, 401))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('会话已过期')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('立即备份的非 401 错误保留在工作台', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: '备份操作失败' }, 503))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="dashboard"]').text()).toContain('备份操作失败')
    expect(wrapper.find('[data-testid="auth-title"]').exists()).toBe(false)
  })

  it('可在总工作台、项目、客户和系统四个真实工作页之间切换', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))

    const wrapper = mountApp()
    await settle()
    expect(wrapper.get('[data-testid="workbench-overview"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="scheduler-status"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="nav-projects"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="projects-empty"]').isVisible()).toBe(true)

    await wrapper.get('[data-testid="nav-companies"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="companies-empty"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="projects-empty"]').exists()).toBe(false)

    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    expect(wrapper.get('[data-testid="scheduler-status"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="scheduler-status"]').text()).toContain('运行中')
    expect(wrapper.find('[data-testid="companies-empty"]').exists()).toBe(false)

    await wrapper.get('[data-testid="nav-projects"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="projects-empty"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="scheduler-status"]').isVisible()).toBe(false)
  })

  it('进入项目仪表台再返回时保留归档筛选和列表', async () => {
    const archivedProject = {
      id: 31,
      project_code: 'SY-ARCHIVED',
      company_id: 1,
      name: '已归档装配线',
      description: null,
      status: 'archived',
      archive_reason: '客户计划调整',
      archived_at: '2026-08-28T08:00:00Z',
      created_at: '2026-08-20T08:00:00Z',
      updated_at: '2026-08-28T08:00:00Z',
      company_name: '苏州客户',
    }
    const dashboardCompany = {
      id: 1,
      name: '苏州客户',
      taxpayer_id: null,
      registered_address: null,
      registered_phone: null,
      bank_name: null,
      bank_account: null,
      notes: null,
      created_at: '2026-08-20T08:00:00Z',
      updated_at: '2026-08-20T08:00:00Z',
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/companies') return jsonResponse([])
      if (path === '/api/projects?status=active') return jsonResponse([])
      if (path === '/api/projects?status=archived') return jsonResponse([archivedProject])
      if (path === '/api/projects/SY-ARCHIVED/dashboard') {
        return jsonResponse({
          project: { ...archivedProject, closure_type: 'completed', revision: 2 },
          company: dashboardCompany,
          contacts: [],
          documents: { document_count: 0, version_count: 0, categories: [] },
          ...emptyProjectOperating,
        })
      }
      throw new Error(`unexpected ${path}`)
    })

    const wrapper = mountApp()
    await settle()

    await wrapper.get('[data-testid="nav-projects"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="project-filter"] input[value="archived"]').setValue(true)
    await settle()
    expect(wrapper.text()).toContain('已归档装配线')

    await wrapper.get('[data-testid="project-dashboard-SY-ARCHIVED"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="project-dashboard-back"]').isVisible()).toBe(true)
    await wrapper.get('[data-testid="project-dashboard-back"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="project-filter"] input[value="archived"]').element).toHaveProperty('checked', true)
    expect(wrapper.text()).toContain('已归档装配线')
    expect(businessFetchMock.mock.calls.filter(([path]) =>
      path === '/api/projects?status=archived')).toHaveLength(1)
  })

  it('工作台使用统一的导航与内容壳层', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
    const wrapper = mountApp()
    await settle()

    expect(wrapper.get('[data-testid="nav-column"]').classes()).toContain('workspace-aside')
    expect(wrapper.get('[data-testid="content-column"]').classes()).toContain('workspace-content')
    expect(wrapper.get('[data-testid="nav-overview"]').isVisible()).toBe(true)
  })

  it('任意业务 API 返回 401 时清空工作台并回到登录页', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, password_configured: true }),
      )
      .mockResolvedValueOnce(jsonResponse(overview))
    businessFetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith('/api/projects')) {
        return jsonResponse({ detail: '业务会话已失效' }, 401)
      }
      return jsonResponse([])
    })

    const wrapper = mountApp()
    await settle()
    await settle()

    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('业务会话已失效')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it('没有逐页会话处理的库存接口返回 401 时也统一回到登录页', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Authentication required' }, 401))

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="nav-inventory"]').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')
    })
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('登录状态已失效')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it.each(['success', 'unauthorized'] as const)(
    '旧会话 overview 迟到 %s 不得影响重新登录的新会话',
    async (oldOutcome) => {
      let resolveOldOverview!: (response: Response) => void
      let overviewCalls = 0
      const newOverview = {
        ...overview,
        data_directory: 'D:\\SunYu ERP\\New Session Data',
        database_path: 'D:\\SunYu ERP\\New Session Data\\iapm.sqlite',
      }
      fetchMock.mockImplementation(async (input) => {
        const path = String(input)
        if (path === '/api/auth/session') {
          return jsonResponse({ authenticated: true, password_configured: true })
        }
        if (path === '/api/system/overview') {
          overviewCalls += 1
          if (overviewCalls === 1) return jsonResponse(overview)
          if (overviewCalls === 2) {
            return new Promise<Response>((resolve) => { resolveOldOverview = resolve })
          }
          return jsonResponse(newOverview)
        }
        if (path === '/api/system/backups') {
          return jsonResponse({ path: 'D:\\Backups\\one', created_at: '2026-08-28T12:00:00Z' }, 201)
        }
        if (path === '/api/auth/login') return emptyResponse()
        throw new Error(`unexpected ${path}`)
      })
      let projectLoads = 0
      businessFetchMock.mockImplementation(async (input) => {
        const path = String(input)
        if (path.startsWith('/api/projects')) {
          projectLoads += 1
          if (projectLoads === 2) {
            return jsonResponse({ detail: 'Authentication required' }, 401)
          }
        }
        return jsonResponse([])
      })

      const wrapper = mountApp()
      await settle()
      await wrapper.get('[data-testid="nav-system"]').trigger('click')
      await wrapper.get('[data-testid="backup-now"]').trigger('click')
      await settle()
      expect(overviewCalls).toBe(2)

      await wrapper.get('[data-testid="nav-projects"]').trigger('click')
      await settle()
      expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')

      await wrapper.get('[data-testid="login-password"]').setValue('123456')
      await wrapper.get('[data-testid="auth-submit"]').trigger('click')
      await settle()
      expect(overviewCalls).toBe(3)
      await wrapper.get('[data-testid="nav-system"]').trigger('click')
      expect(wrapper.get('[data-testid="scheduler-status"]').text()).toContain(
        newOverview.database_path,
      )

      resolveOldOverview(
        oldOutcome === 'success'
          ? jsonResponse({ ...overview, database_path: 'D:\\Old\\stale.sqlite' })
          : jsonResponse({ detail: 'Authentication required' }, 401),
      )
      await settle()
      await settle()
      expect(wrapper.find('[data-testid="auth-title"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="scheduler-status"]').text()).toContain(
        newOverview.database_path,
      )
      expect(wrapper.text()).not.toContain('D:\\Old\\stale.sqlite')
    },
  )

  it.each([
    {
      name: '立即备份',
      selector: 'backup-now',
      path: '/api/system/backups',
      response: {
        path: 'D:\\Backups\\new-session',
        created_at: '2026-08-28T13:00:00Z',
      },
    },
    {
      name: '保存备份设置',
      selector: 'backup-save',
      path: '/api/system/backup-settings',
      response: {
        enabled: true,
        directory: overview.backup.directory,
        interval_hours: overview.backup.interval_hours,
        retention_days: overview.backup.retention_days,
      },
    },
  ])('旧会话$name不得锁住或误解锁新会话操作', async ({ selector, path, response }) => {
    const operationResolvers: Array<(response: Response) => void> = []
    let expireBusinessSession = false
    fetchMock.mockImplementation(async (input) => {
      const requestPath = String(input)
      if (requestPath === '/api/auth/session') {
        return jsonResponse({ authenticated: true, password_configured: true })
      }
      if (requestPath === '/api/auth/login') return emptyResponse()
      if (requestPath === '/api/system/overview') return jsonResponse(overview)
      if (requestPath === path) {
        return new Promise<Response>((resolve) => operationResolvers.push(resolve))
      }
      throw new Error(`unexpected ${requestPath}`)
    })
    businessFetchMock.mockImplementation(async (input) => {
      const requestPath = String(input)
      if (expireBusinessSession && requestPath.startsWith('/api/projects')) {
        expireBusinessSession = false
        return jsonResponse({ detail: 'Authentication required' }, 401)
      }
      return jsonResponse([])
    })

    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    await wrapper.get(`[data-testid="${selector}"]`).trigger('click')
    expect(operationResolvers).toHaveLength(1)

    expireBusinessSession = true
    await wrapper.get('[data-testid="nav-projects"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="auth-title"]').text()).toContain('密码登录')

    await wrapper.get('[data-testid="login-password"]').setValue('123456')
    await wrapper.get('[data-testid="auth-submit"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    const currentButton = wrapper.get(`[data-testid="${selector}"]`)
    expect(currentButton.attributes('disabled')).toBeUndefined()

    await currentButton.trigger('click')
    expect(operationResolvers).toHaveLength(2)
    expect(currentButton.attributes('disabled')).toBeDefined()

    operationResolvers[0]?.(jsonResponse(response))
    await settle()
    expect(currentButton.attributes('disabled')).toBeDefined()

    operationResolvers[1]?.(jsonResponse(response))
    await settle()
    await settle()
    expect(currentButton.attributes('disabled')).toBeUndefined()
  })

  it('全局操作错误在项目页也可见', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: '退出服务暂时不可用' }, 503))
    const wrapper = mountApp()
    await settle()

    await wrapper.get('[data-testid="logout"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="request-error"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="request-error"]').text()).toContain('退出服务暂时不可用')
    expect(wrapper.get('[data-testid="workbench-overview"]').isVisible()).toBe(true)
  })

  it('备份专属错误只在系统页展示', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Backup operation failed' }, 503))
    const wrapper = mountApp()
    await settle()
    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    await wrapper.get('[data-testid="backup-now"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="system-request-error"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="system-request-error"]').text()).toContain('备份操作失败')

    await wrapper.get('[data-testid="nav-projects"]').trigger('click')
    expect(wrapper.get('[data-testid="system-request-error"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="request-error"]').exists()).toBe(false)
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
