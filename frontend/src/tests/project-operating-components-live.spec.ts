import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PortfolioOperatingOverview from '../components/PortfolioOperatingOverview.vue'
import ProjectDashboard from '../components/ProjectDashboard.vue'
import ProjectCommercialPanel from '../components/project/ProjectCommercialPanel.vue'
import ProjectDocumentsPanel from '../components/project/ProjectDocumentsPanel.vue'
import ProjectOverviewPanel from '../components/project/ProjectOverviewPanel.vue'
import type { GlobalDashboard, ProjectDashboard as ProjectDashboardData } from '../domain/contracts'
import type { ProjectOperatingRepository } from '../repositories/project-operating.live'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function clickDocumentAction(wrapper: VueWrapper, documentId: number, actionSelector: string): Promise<void> {
  await wrapper.get(`[data-testid="document-actions-${documentId}"]`).trigger('click')
  await settle()
  const action = document.body.querySelector<HTMLElement>(actionSelector)
  if (!action) throw new Error(`未找到资料操作 ${actionSelector}`)
  action.click()
  await settle()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsText(blob)
  })
}

function mountComponent(component: object, props: Record<string, unknown> = {}): VueWrapper {
  return mount(component, {
    attachTo: document.body,
    props,
    global: { plugins: [ElementPlus] },
  })
}

const projectDashboard: ProjectDashboardData = {
  project: {
    id: 21,
    project_code: 'SY-2026-001',
    company_id: 1,
    company_name: '苏州出发科技',
    name: '装配线改造',
    description: '自动化装配线',
    status: 'active',
    closure_type: null,
    archive_reason: null,
    archived_at: null,
    revision: 4,
    created_at: '2026-08-28T02:00:00+00:00',
    updated_at: '2026-08-28T02:00:00+00:00',
  },
  company: {
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
  },
  contacts: [],
  documents: { document_count: 0, version_count: 0, categories: [] },
  completion_check: {
    stages_ready: true,
    final_acceptance_ready: true,
    receivables_ready: true,
    ready: true,
    blockers: [],
  },
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
    terms: ['advance', 'progress', 'final'].map((milestone) => ({
      id: null,
      milestone: milestone as 'advance' | 'progress' | 'final',
      due_on: null,
      planned_amount_cents: 0,
      received_amount_cents: 0,
      outstanding_amount_cents: 0,
      term_fulfillment_basis_points: null,
      status: 'unplanned',
      is_overdue: false,
      notes: null,
      revision: null,
    })),
    receipts: [],
  },
  todos: [],
}

const globalDashboard: GlobalDashboard = {
  generated_at: '2026-08-31T10:00:00+08:00',
  summary: {
    active_project_count: 1,
    overdue_receivable_count: 0,
    upcoming_delivery_count: 0,
    contracted_amount_cents: 0,
    received_amount_cents: 0,
    outstanding_receivable_cents: 0,
  },
  projects: [{
    project: projectDashboard.project,
    current_stage: null,
    contracted_amount_cents: 0,
    received_amount_cents: 0,
    outstanding_receivable_cents: 0,
    final_delivery_on: null,
    actual_profit_cents: 0,
  }],
  todos: [],
  backup: { healthy: true, last_success_at: null, message: null },
}

describe('项目经营真实组件', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('经营总览读取真实 dashboard，失败时显示错误而不回退演示数据', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: '仪表台暂不可用' }, 503))
      .mockResolvedValueOnce(jsonResponse(globalDashboard))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(PortfolioOperatingOverview)
    await settle()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/dashboard')
    expect(wrapper.get('[data-testid="portfolio-operating-error"]').text()).toContain('仪表台暂不可用')
    expect(wrapper.text()).not.toContain('演示数据')

    await wrapper.get('[data-testid="portfolio-operating-retry"]').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('装配线改造')
    expect(wrapper.text()).toContain('生成于 2026年8月31日 10:00')
    expect(wrapper.text()).not.toContain('2026-08-31T10:00:00+08:00')
    expect(wrapper.text()).not.toContain('真实后端')
  })

  it('项目工作页使用同一次完整 dashboard 响应并真实编辑和完结', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(projectDashboard)
      if (init?.method === 'PUT') {
        return jsonResponse({
          ...projectDashboard.project,
          name: '装配线整体升级',
          description: '机械与电气同步改造',
          revision: 5,
        })
      }
      if (path.endsWith('/close')) {
        return jsonResponse({
          ...projectDashboard.project,
          status: 'archived',
          closure_type: 'completed',
          archive_reason: '项目已验收',
          revision: 6,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.[0]).toBe('/api/projects/SY-2026-001/dashboard')
    expect(wrapper.text()).not.toContain('真实后端')
    expect(wrapper.find('[data-testid="project-demo-notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-edit-open"]').text()).toBe('编辑项目')
    expect(wrapper.get('[data-testid="project-close-open"]').text()).toBe('完结并归档')

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await wrapper.get('[data-testid="project-edit-name"]').setValue('装配线整体升级')
    await wrapper.get('[data-testid="project-edit-description"]').setValue('机械与电气同步改造')
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await settle()
    const update = requests.find(([, init]) => init?.method === 'PUT')
    expect(update?.[0]).toBe('/api/projects/SY-2026-001')
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({
      company_id: 1,
      name: '装配线整体升级',
      description: '机械与电气同步改造',
      expected_revision: 4,
    })

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    expect(wrapper.findAll('[data-testid="project-close-type"] input:checked')).toHaveLength(0)
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    expect(wrapper.get('[data-testid="project-close-completion-check"]').text()).toContain('正常完结条件已满足')
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await settle()
    const close = requests.find(([path]) => path.endsWith('/close'))
    expect(close?.[1]?.method).toBe('POST')
    expect((close?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
    expect(wrapper.text()).not.toContain('演示')
  })

  it('项目正常完结展示三项检查并阻止未就绪提交，提前终止仍可提交', async () => {
    const blockedDashboard: ProjectDashboardData = {
      ...projectDashboard,
      completion_check: {
        stages_ready: false,
        final_acceptance_ready: false,
        receivables_ready: true,
        ready: false,
        blockers: ['PROJECT_STAGES_INCOMPLETE', 'FINAL_ACCEPTANCE_NOT_PASSED'],
      },
    }
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(blockedDashboard)
      if (path.endsWith('/close')) {
        return jsonResponse({
          ...blockedDashboard.project,
          status: 'archived',
          closure_type: 'cancelled',
          archive_reason: '客户提前终止',
          revision: 5,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    expect(wrapper.findAll('[data-testid="project-close-type"] input:checked')).toHaveLength(0)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('客户提前终止')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    expect(wrapper.get('[data-testid="project-close-check-stages"]').text()).toContain('未满足')
    expect(wrapper.get('[data-testid="project-close-check-final-acceptance"]').text()).toContain('未满足')
    expect(wrapper.get('[data-testid="project-close-check-receivables"]').text()).toContain('已满足')
    expect(wrapper.get('[data-testid="project-close-save"]').attributes('disabled')).toBeDefined()
    expect(requests.filter(([path]) => path.endsWith('/close'))).toHaveLength(0)

    await wrapper.get('[data-testid="project-close-type"] input[value="cancelled"]').setValue(true)
    expect(wrapper.get('[data-testid="project-close-cancelled-warning"]').text()).toContain('提前终止')
    expect(wrapper.get('[data-testid="project-close-save"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await settle()
    const close = requests.find(([path]) => path.endsWith('/close'))
    expect(JSON.parse(String(close?.[1]?.body))).toEqual({
      closure_type: 'cancelled',
      reason: '客户提前终止',
      expected_revision: 4,
    })
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已取消')
  })

  it('项目完结 revision 冲突后刷新 dashboard 并保留表单再次确认', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse({
          ...projectDashboard,
          project: {
            ...projectDashboard.project,
            revision: dashboardRead === 1 ? 4 : 5,
          },
        })
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) {
          return jsonResponse({
            detail: 'Revision conflict',
            error_code: 'REVISION_CONFLICT',
            field_errors: {},
            current_revision: 5,
          }, 409)
        }
        return jsonResponse({
          ...projectDashboard.project,
          status: 'archived',
          closure_type: 'completed',
          archive_reason: '项目已验收',
          revision: 6,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(wrapper.get('[data-testid="project-close-type"] input[value="completed"]').attributes('checked'))
      .toBeDefined()
    expect((wrapper.get('[data-testid="project-close-reason"]').element as HTMLTextAreaElement).value)
      .toBe('项目已验收')
    expect(wrapper.get('[data-testid="project-close-save"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await settle()
    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect(closeCalls.map(([, request]) => JSON.parse(String(request?.body)))).toEqual([
      { closure_type: 'completed', reason: '项目已验收', expected_revision: 4 },
      { closure_type: 'completed', reason: '项目已验收', expected_revision: 5 },
    ])
  })

  it('项目完结被业务条件阻塞后刷新三项检查并保留表单', async () => {
    let dashboardRead = 0
    const refreshedDashboard: ProjectDashboardData = {
      ...projectDashboard,
      project: { ...projectDashboard.project, revision: 5 },
      completion_check: {
        stages_ready: false,
        final_acceptance_ready: true,
        receivables_ready: true,
        ready: false,
        blockers: ['PROJECT_STAGES_INCOMPLETE'],
      },
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse(dashboardRead === 1 ? projectDashboard : refreshedDashboard)
      }
      if (path.endsWith('/close')) {
        return jsonResponse({
          detail: 'Project completion requirements are not met',
          error_code: 'PROJECT_COMPLETION_BLOCKED',
          field_errors: { stages: '所有项目阶段必须为已完成或已跳过' },
          current_revision: null,
        }, 409)
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('准备正常完结')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(wrapper.get('[data-testid="project-close-check-stages"]').text()).toContain('未满足')
    expect((wrapper.get('[data-testid="project-close-reason"]').element as HTMLTextAreaElement).value)
      .toBe('准备正常完结')
    expect(wrapper.get('[data-testid="project-close-type"] input[value="completed"]').attributes('checked'))
      .toBeDefined()
    expect(wrapper.get('[data-testid="project-close-save"]').attributes('disabled')).toBeDefined()
  })

  it('项目完结响应丢失但 dashboard 已归档时按成功收敛', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse({
          ...projectDashboard,
          project: {
            ...projectDashboard.project,
            status: dashboardRead === 1 ? 'active' : 'archived',
            closure_type: dashboardRead === 1 ? null : 'completed',
            archive_reason: dashboardRead === 1 ? null : '项目已验收',
            revision: dashboardRead === 1 ? 4 : 5,
          },
        })
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        throw new TypeError('response lost')
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(closeAttempt).toBe(1)
    expect(wrapper.get('[data-testid="project-close-save"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
  })

  it('项目完结响应丢失且 dashboard 仍 active 时继续锁定并只允许原样重试', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse(projectDashboard)
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) throw new TypeError('response lost')
        return jsonResponse({
          ...projectDashboard.project,
          status: 'archived',
          closure_type: 'completed',
          archive_reason: '项目已验收',
          revision: 5,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(wrapper.find('[data-testid="project-close-save"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="project-close-type"] input[value="completed"]').attributes('disabled'))
      .toBeDefined()
    expect(wrapper.get('[data-testid="project-close-reconcile-retry"]').text()).toContain('重新核对状态')

    await wrapper.get('[data-testid="project-close-original-retry"]').trigger('click')
    await settle()
    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect(closeCalls).toHaveLength(2)
    expect(closeCalls[0]?.[1]?.body).toBe(closeCalls[1]?.[1]?.body)
    expect((closeCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((closeCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('项目完结返回 503 且 dashboard 仍 active 时继续锁定并复用原请求', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse(projectDashboard)
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) return jsonResponse({ detail: 'upstream unavailable' }, 503)
        return jsonResponse({
          ...projectDashboard.project,
          status: 'archived',
          closure_type: 'completed',
          archive_reason: '项目已验收',
          revision: 5,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(wrapper.find('[data-testid="project-close-save"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="project-close-original-retry"]').text()).toContain('原样重试')

    await wrapper.get('[data-testid="project-close-original-retry"]').trigger('click')
    await settle()
    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect(closeCalls).toHaveLength(2)
    expect(closeCalls[0]?.[1]?.body).toBe(closeCalls[1]?.[1]?.body)
    expect((closeCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((closeCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('未知完结请求原样重试明确冲突后才刷新并解除锁定', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse({
          ...projectDashboard,
          project: {
            ...projectDashboard.project,
            revision: dashboardRead < 3 ? 4 : 5,
          },
        })
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) throw new TypeError('response lost')
        return jsonResponse({
          detail: 'Revision conflict',
          error_code: 'REVISION_CONFLICT',
          field_errors: {},
          current_revision: 5,
        }, 409)
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))
    await wrapper.get('[data-testid="project-close-original-retry"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(3))

    expect(wrapper.find('[data-testid="project-close-original-retry"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-close-save"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeUndefined()
    expect((wrapper.get('[data-testid="project-close-reason"]').element as HTMLTextAreaElement).value)
      .toBe('项目已验收')
    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect((closeCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((closeCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
    expect(closeCalls[0]?.[1]?.body).toBe(closeCalls[1]?.[1]?.body)
  })

  it('项目完结响应丢失且 dashboard 核对失败时锁住原请求并原样重试', async () => {
    let dashboardRead = 0
    let closeAttempt = 0
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        if (dashboardRead > 1) throw new TypeError('reconcile failed')
        return jsonResponse(projectDashboard)
      }
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) throw new TypeError('response lost')
        return jsonResponse({
          ...projectDashboard.project,
          status: 'archived',
          closure_type: 'completed',
          archive_reason: '项目已验收',
          revision: 5,
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-close-original-retry"]').exists()).toBe(true)
    })

    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="project-close-type"] input[value="completed"]').attributes('disabled'))
      .toBeDefined()
    expect(wrapper.get('[data-testid="project-close-reconcile-retry"]').text()).toContain('重新核对状态')
    await wrapper.get('[data-testid="project-close-reconcile-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="project-close-original-retry"]').trigger('click')
    await settle()
    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect(closeCalls).toHaveLength(2)
    expect(closeCalls[0]?.[1]?.body).toBe(closeCalls[1]?.[1]?.body)
    expect((closeCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((closeCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('完结在途时同项目刷新不应跳过响应丢失后的核对与锁定', async () => {
    let dashboardRead = 0
    let rejectClose!: (reason?: unknown) => void
    const closeResponse = new Promise<Response>((_resolve, reject) => {
      rejectClose = reject
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        if (dashboardRead === 3) throw new TypeError('reconcile failed')
        return jsonResponse(projectDashboard)
      }
      if (path.endsWith('/close')) return closeResponse
      throw new Error(`unexpected GET ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    wrapper.findComponent(ProjectOverviewPanel).vm.$emit('stagesChanged', projectDashboard.stages)
    await vi.waitFor(() => expect(dashboardRead).toBe(2))
    rejectClose(new TypeError('response lost'))
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-close-original-retry"]').exists()).toBe(true)
    })

    expect(dashboardRead).toBe(3)
    expect(wrapper.get('[data-testid="project-close-reason"]').attributes('disabled')).toBeDefined()
  })

  it('完结成功后不被先前在途的 active dashboard 覆盖', async () => {
    let dashboardRead = 0
    const refreshResponse = deferred<Response>()
    const closeResponse = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return dashboardRead === 1 ? jsonResponse(projectDashboard) : refreshResponse.promise
      }
      if (path.endsWith('/close')) return closeResponse.promise
      throw new Error(`unexpected GET ${path}`)
    }))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="completed"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    wrapper.findComponent(ProjectOverviewPanel).vm.$emit('stagesChanged', projectDashboard.stages)
    await vi.waitFor(() => expect(dashboardRead).toBe(2))
    closeResponse.resolve(jsonResponse({
      ...projectDashboard.project,
      status: 'archived',
      closure_type: 'completed',
      archive_reason: '项目已验收',
      revision: 5,
    }))
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
    })

    refreshResponse.resolve(jsonResponse(projectDashboard))
    await settle()
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
  })

  it('项目文档真实加载、上传、追加、下载、编辑和归档', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'site_survey',
      title: '现场测绘',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T01:00:00+00:00',
    }
    const detail = {
      ...document,
      versions: [{
        id: 31,
        version_number: 1,
        managed_filename: 'SY-2026-001-现场测绘-20260831.dwg',
        original_filename: 'survey.dwg',
        content_type: 'application/acad',
        size_bytes: 6,
        sha256: '0'.repeat(64),
        notes: null,
        created_at: document.created_at,
      }],
    }
    let listedDocument = document
    const requests: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      const method = init?.method ?? 'GET'
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [listedDocument], total: 1, page: 1, page_size: 20 })
      }
      if (path.endsWith('/documents/12') && method === 'GET') return jsonResponse(detail)
      if (path.endsWith('/download')) return new Response(new Blob(['survey']))
      if (path.endsWith('/versions')) return jsonResponse({ ...detail.versions[0], id: 32, version_number: 2 })
      if (path.endsWith('/archive')) return jsonResponse({ ...detail, archived_at: '2026-08-31T03:00:00+00:00', revision: 2 })
      if (path.endsWith('/documents/12') && method === 'PUT') {
        listedDocument = { ...document, title: '现场测绘复核', revision: 2 }
        return jsonResponse({ ...detail, ...listedDocument })
      }
      if (path.endsWith('/documents') && method === 'POST') return jsonResponse({ ...detail, id: 13, title: '技术协议' }, 201)
      throw new Error(`unexpected ${method} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const createObjectUrl = vi.fn(() => 'blob:document')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    expect(requests[0]?.[0]).toBe('/api/projects/SY-2026-001/documents?page=1&page_size=20&archived=active')
    expect(wrapper.text()).not.toContain('演示')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text()).toContain('1 份资料 · 1 个历史版本')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-history-open-12"]')
    await settle()
    expect(wrapper.find('[data-testid="document-history-version-31"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('V1')
    expect(wrapper.text()).toContain('SY-2026-001-现场测绘-20260831.dwg')
    expect(wrapper.text()).toContain('原文件名：survey.dwg')
    expect(wrapper.text()).toContain('survey.dwg')
    await wrapper.get('[data-testid="document-history-download-31"]').trigger('click')
    await settle()
    expect(requests.some(([path]) => path.endsWith('/documents/12/versions/31/download'))).toBe(true)

    await clickDocumentAction(wrapper, 12, '[data-testid="document-edit-open-12"]')
    await wrapper.get('[data-testid="document-edit-title"]').setValue('现场测绘复核')
    await wrapper.get('[data-testid="document-edit-save"]').trigger('click')
    await settle()
    const edit = requests.find(([path, init]) => path.endsWith('/documents/12') && init?.method === 'PUT')
    expect(JSON.parse(String(edit?.[1]?.body))).toEqual({
      title: '现场测绘复核', notes: null, expected_revision: 1,
    })

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('技术协议')
    expect(wrapper.get('[data-testid="document-create-dropzone"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    const createFile = wrapper.get('[data-testid="document-create-file"]')
    Object.defineProperty(createFile.element, 'files', {
      configurable: true,
      value: [new File(['pdf'], 'agreement.pdf', { type: 'application/pdf' })],
    })
    await createFile.trigger('change')
    await wrapper.get('[data-testid="document-create-save"]').trigger('click')
    await settle()
    const create = requests.find(([path, init]) => path.endsWith('/documents') && init?.method === 'POST')
    expect(create?.[1]?.body).toBeInstanceOf(FormData)
    expect((create?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)

    await clickDocumentAction(wrapper, 12, '[data-testid="document-version-open-12"]')
    expect(wrapper.get('[data-testid="document-version-dropzone"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    const versionFile = wrapper.get('[data-testid="document-version-file"]')
    Object.defineProperty(versionFile.element, 'files', {
      configurable: true,
      value: [new File(['v2'], 'survey-v2.dwg', { type: 'application/acad' })],
    })
    await versionFile.trigger('change')
    await wrapper.get('[data-testid="document-version-save"]').trigger('click')
    await settle()
    const version = requests.find(([path]) => path.endsWith('/documents/12/versions'))
    expect((version?.[1]?.body as FormData).get('expected_revision')).toBe('2')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-download-12"]')
    await settle()
    expect(requests.some(([path]) => path.endsWith('/documents/12/versions/31/download'))).toBe(true)
    expect(createObjectUrl).toHaveBeenCalled()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-archive-open-12"]')
    await wrapper.get('[data-testid="document-archive-reason"]').setValue('已由最终版替代')
    await wrapper.get('[data-testid="document-archive-save"]').trigger('click')
    await settle()
    const archive = requests.find(([path]) => path.endsWith('/documents/12/archive'))
    expect((archive?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('切换项目后旧项目的延迟历史请求不覆盖新项目或串错下载路径', async () => {
    const document = (projectCode: string, id: number, title: string) => ({
      id,
      project_code: projectCode,
      category: 'planning_minutes',
      title,
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-01T01:00:00+00:00',
      updated_at: '2026-09-01T01:00:00+00:00',
    })
    const version = (id: number, filename: string) => ({
      id,
      version_number: 1,
      original_filename: filename,
      content_type: 'text/plain',
      size_bytes: 12,
      sha256: String(id).padStart(64, '0'),
      notes: null,
      created_at: '2026-09-01T01:00:00+00:00',
    })
    const aDocument = document('PROJECT-A', 12, 'A 项目纪要')
    const bDocument = document('PROJECT-B', 22, 'B 项目纪要')
    const aDetail = { ...aDocument, versions: [version(31, 'project-a.txt')] }
    const bDetail = { ...bDocument, versions: [version(42, 'project-b.txt')] }
    const aHistory = deferred<Response>()
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      requests.push(path)
      if (path.includes('/api/projects/PROJECT-A/documents?page=')) {
        return jsonResponse({ items: [aDocument], total: 1, page: 1, page_size: 100 })
      }
      if (path.includes('/api/projects/PROJECT-B/documents?page=')) {
        return jsonResponse({ items: [bDocument], total: 1, page: 1, page_size: 100 })
      }
      if (path === '/api/projects/PROJECT-A/documents/12') return aHistory.promise
      if (path === '/api/projects/PROJECT-B/documents/22') return jsonResponse(bDetail)
      if (path === '/api/projects/PROJECT-B/documents/22/versions/42/download') {
        return new Response(new Blob(['project-b']))
      }
      throw new Error(`unexpected GET ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:project-b'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'PROJECT-A' })
    await settle()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-history-open-12"]')
    await wrapper.setProps({ projectCode: 'PROJECT-B' })
    await settle()
    await clickDocumentAction(wrapper, 22, '[data-testid="document-history-open-22"]')
    await settle()

    expect(wrapper.find('[data-testid="document-history-version-42"]').exists()).toBe(true)
    aHistory.resolve(jsonResponse(aDetail))
    await settle()

    expect(wrapper.find('[data-testid="document-history-version-42"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="document-history-version-31"]').exists()).toBe(false)
    await wrapper.get('[data-testid="document-history-download-42"]').trigger('click')
    await settle()
    expect(requests).toContain('/api/projects/PROJECT-B/documents/22/versions/42/download')
    expect(requests).not.toContain('/api/projects/PROJECT-B/documents/12/versions/31/download')
  })

  it('会议纪要可在网页直接录入文字并追加多版本', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title: '项目启动会纪要',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T01:00:00+00:00',
    }
    const detail = {
      ...document,
      versions: [{
        id: 31,
        version_number: 1,
        original_filename: 'planning-minutes.txt',
        content_type: 'text/plain',
        size_bytes: 12,
        sha256: '0'.repeat(64),
        notes: null,
        created_at: document.created_at,
      }],
    }
    const requests: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [document], total: 1, page: 1, page_size: 100 })
      }
      if (path.endsWith('/documents') && init?.method === 'POST') {
        return jsonResponse({ ...detail, id: 13, title: '第二次项目会纪要' }, 201)
      }
      if (path.endsWith('/documents/12/versions') && init?.method === 'POST') {
        return jsonResponse({ ...detail.versions[0], id: 32, version_number: 2 }, 201)
      }
      if (path.endsWith('/documents/12')) {
        return jsonResponse({ ...detail, latest_version_number: 2, revision: 2 })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="document-minutes-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-title"]').setValue('第二次项目会纪要')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('客户确认了新的交付日期。')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()

    const createRequest = requests.find(([path, init]) => path.endsWith('/documents') && init?.method === 'POST')
    const createBody = createRequest?.[1]?.body as FormData
    expect(createBody.get('category')).toBe('planning_minutes')
    expect(createBody.get('title')).toBe('第二次项目会纪要')
    const createdFile = createBody.get('file') as File
    expect(createdFile.name).toBe('planning-minutes.txt')
    expect(createdFile.type).toBe('text/plain')
    await expect(readBlob(createdFile)).resolves.toBe('客户确认了新的交付日期。')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-minutes-version-open-12"]')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('客户追加了安全护栏要求。')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()

    const versionRequest = requests.find(([path]) => path.endsWith('/documents/12/versions'))
    const versionBody = versionRequest?.[1]?.body as FormData
    expect(versionBody.get('expected_revision')).toBe('1')
    const versionFile = versionBody.get('file') as File
    await expect(readBlob(versionFile)).resolves.toBe('客户追加了安全护栏要求。')
  })

  it('A 项目文字纪要创建延迟返回时不污染 B 项目列表、弹窗和提示', async () => {
    const bDocument = {
      id: 22,
      project_code: 'PROJECT-B',
      category: 'planning_minutes',
      title: 'B 项目原有纪要',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-01T01:00:00+00:00',
      updated_at: '2026-09-01T01:00:00+00:00',
    }
    const aCreate = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.includes('/api/projects/PROJECT-A/documents?page=')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      }
      if (path.includes('/api/projects/PROJECT-B/documents?page=')) {
        return jsonResponse({ items: [bDocument], total: 1, page: 1, page_size: 100 })
      }
      if (path === '/api/projects/PROJECT-A/documents' && init?.method === 'POST') {
        return aCreate.promise
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'PROJECT-A' })
    await settle()

    await wrapper.get('[data-testid="document-minutes-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-title"]').setValue('A 项目新增纪要')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('A 项目内容')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await wrapper.setProps({ projectCode: 'PROJECT-B' })
    await settle()

    await wrapper.get('[data-testid="document-minutes-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-title"]').setValue('B 项目待录纪要')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('B 项目尚未提交内容')

    aCreate.resolve(jsonResponse({
      ...bDocument,
      id: 11,
      project_code: 'PROJECT-A',
      title: 'A 项目新增纪要',
      versions: [],
    }, 201))
    await settle()

    expect(wrapper.get('[data-testid="document-ledger-summary"]').text()).toContain('1 份资料')
    expect(wrapper.text()).toContain('B 项目原有纪要')
    expect(wrapper.text()).not.toContain('已保存 A 项目新增纪要')
    const bDialog = wrapper.get('[aria-label="录入文字会议纪要"]')
    expect(bDialog.isVisible()).toBe(true)
    expect(bDialog.text()).toContain('请填写纪要标题和内容')
    expect((wrapper.get('[data-testid="document-minutes-title"]').element as HTMLInputElement).value)
      .toBe('B 项目待录纪要')
    expect((wrapper.get('[data-testid="document-minutes-content"]').element as HTMLTextAreaElement).value)
      .toBe('B 项目尚未提交内容')
  })

  it('A 项目文字纪要追加延迟返回时不刷新或关闭 B 项目弹窗', async () => {
    const document = (projectCode: string, id: number, title: string) => ({
      id,
      project_code: projectCode,
      category: 'planning_minutes',
      title,
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-01T01:00:00+00:00',
      updated_at: '2026-09-01T01:00:00+00:00',
    })
    const aDocument = document('PROJECT-A', 12, 'A 项目纪要')
    const bDocument = document('PROJECT-B', 22, 'B 项目纪要')
    const aVersion = deferred<Response>()
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push(path)
      if (path.includes('/api/projects/PROJECT-A/documents?page=')) {
        return jsonResponse({ items: [aDocument], total: 1, page: 1, page_size: 100 })
      }
      if (path.includes('/api/projects/PROJECT-B/documents?page=')) {
        return jsonResponse({ items: [bDocument], total: 1, page: 1, page_size: 100 })
      }
      if (path === '/api/projects/PROJECT-A/documents/12/versions' && init?.method === 'POST') {
        return aVersion.promise
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'PROJECT-A' })
    await settle()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-minutes-version-open-12"]')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('A 项目 V2 内容')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await wrapper.setProps({ projectCode: 'PROJECT-B' })
    await settle()

    await clickDocumentAction(wrapper, 22, '[data-testid="document-minutes-version-open-22"]')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('B 项目待追加内容')
    aVersion.resolve(jsonResponse({
      id: 32,
      version_number: 2,
      original_filename: 'planning-minutes.txt',
      content_type: 'text/plain',
      size_bytes: 12,
      sha256: '1'.repeat(64),
      notes: null,
      created_at: '2026-09-01T02:00:00+00:00',
    }, 201))
    await settle()

    expect(requests).not.toContain('/api/projects/PROJECT-B/documents/12')
    expect(wrapper.text()).not.toContain('已保存 A 项目纪要 V2')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text())
      .toContain('1 份资料 · 1 个历史版本')
    const bDialog = wrapper.get('[aria-label="追加文字纪要版本"]')
    expect(bDialog.isVisible()).toBe(true)
    expect((wrapper.get('[data-testid="document-minutes-content"]').element as HTMLTextAreaElement).value)
      .toBe('B 项目待追加内容')
    expect(wrapper.find('[data-testid="document-refresh-warning"]').exists()).toBe(false)
  })

  it('商务面板真实加载并登记报价、合同、计划、到账和作废', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      const method = init?.method ?? 'GET'
      if (path.includes('/quotes?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (path.includes('/contracts?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (path.endsWith('/document-version-options')) return jsonResponse([])
      if (path.endsWith('/payments')) return jsonResponse(projectDashboard.receivables)
      if (path.endsWith('/quotes') && method === 'POST') {
        return jsonResponse({
          id: 7, project_code: 'SY-2026-001', version_number: 1, status: 'draft',
          quote_date: '2026-08-31', amount_cents: 1280000, valid_until: null,
          notes: null, document_version_ids: [], revision: 1,
          created_at: '2026-08-31T01:00:00+00:00', updated_at: '2026-08-31T01:00:00+00:00',
        }, 201)
      }
      if (path.endsWith('/contracts') && method === 'POST') return jsonResponse({ id: 8 }, 201)
      if (path.includes('/payment-terms/')) return jsonResponse({})
      if (path.endsWith('/receipts') && method === 'POST') return jsonResponse({ id: 9 }, 201)
      if (path.endsWith('/void')) return jsonResponse({ id: 9, status: 'voided' })
      throw new Error(`unexpected ${method} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectCommercialPanel, {
      operating: {
        stages: projectDashboard.stages,
        commercial: projectDashboard.commercial,
        costs: projectDashboard.costs,
        profit: projectDashboard.profit,
        receivables: projectDashboard.receivables,
        todos: projectDashboard.todos,
      },
      projectCode: 'SY-2026-001',
      customerCompany: { id: 1, name: '苏州出发科技' },
    })
    await settle()

    expect(requests.map(([path]) => path)).toEqual(expect.arrayContaining([
      '/api/projects/SY-2026-001/quotes?page=1&page_size=100',
      '/api/projects/SY-2026-001/contracts?page=1&page_size=100',
      '/api/projects/SY-2026-001/payments',
      '/api/projects/SY-2026-001/document-version-options',
    ]))
    expect(wrapper.text()).not.toContain('演示')
    expect(wrapper.text()).not.toContain('真实后端')

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('12800.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    const quote = requests.find(([path, init]) => path.endsWith('/quotes') && init?.method === 'POST')
    expect(JSON.parse(String(quote?.[1]?.body))).toMatchObject({ amount_cents: 1280000 })
    expect((quote?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('到账 POST 成功但款项刷新失败时关闭弹窗并明确提示不要重复提交', async () => {
    let paymentReads = 0
    let receiptPosts = 0
    const signedContract = {
      id: 8,
      project_code: 'SY-2026-001',
      contract_no: 'HT-001',
      title: '项目合同',
      customer_company_id: 1,
      customer_company_name: '苏州出发科技',
      signed_on: '2026-08-30',
      total_amount_cents: 1280000,
      final_delivery_on: null,
      status: 'signed',
      notes: null,
      document_version_ids: [],
      allocations: [{
        id: 81,
        contract_id: 8,
        project_code: 'SY-2026-001',
        allocated_amount_cents: 1280000,
        revision: 1,
      }],
      revision: 1,
      created_at: '2026-08-30T01:00:00+00:00',
      updated_at: '2026-08-30T01:00:00+00:00',
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path.includes('/quotes?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (path.includes('/contracts?page=')) return jsonResponse({ items: [signedContract], total: 1, page: 1, page_size: 100 })
      if (path.endsWith('/document-version-options')) return jsonResponse([])
      if (path.endsWith('/payments')) {
        paymentReads += 1
        return paymentReads === 1
          ? jsonResponse(projectDashboard.receivables)
          : jsonResponse({ detail: '刷新款项失败' }, 503)
      }
      if (path.endsWith('/receipts') && method === 'POST') {
        receiptPosts += 1
        return jsonResponse({
          id: 9,
          project_code: 'SY-2026-001',
          contract_allocation_id: 81,
          milestone: 'advance',
          received_on: '2026-08-31',
          amount_cents: 1280000,
          payment_method: 'bank_transfer',
          reference_no: null,
          notes: null,
          status: 'active',
          voided_on: null,
          void_reason: null,
          revision: 1,
          created_at: '2026-08-31T01:00:00+00:00',
          updated_at: '2026-08-31T01:00:00+00:00',
        }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectCommercialPanel, {
      operating: {
        stages: projectDashboard.stages,
        commercial: projectDashboard.commercial,
        costs: projectDashboard.costs,
        profit: projectDashboard.profit,
        receivables: projectDashboard.receivables,
        todos: projectDashboard.todos,
      },
      projectCode: 'SY-2026-001',
      customerCompany: { id: 1, name: '苏州出发科技' },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    await wrapper.get('[data-testid="receipt-create-open"]').trigger('click')
    await wrapper.get('[data-testid="receipt-amount"]').setValue('12800.00')
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    await settle()

    expect(receiptPosts).toBe(1)
    expect(wrapper.get('[aria-label="登记到账"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="commercial-refresh-warning"]').text())
      .toContain('已保存，但刷新失败，请刷新页面')
  })

  it('文档版本 POST 成功但详情刷新失败时关闭弹窗并阻止原表单重复提交', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'site_survey',
      title: '现场测绘',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T01:00:00+00:00',
    }
    let versionPosts = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [document], total: 1, page: 1, page_size: 100 })
      }
      if (path.endsWith('/documents/12/versions') && method === 'POST') {
        versionPosts += 1
        return jsonResponse({
          id: 32,
          version_number: 2,
          original_filename: 'survey-v2.dwg',
          content_type: 'application/acad',
          size_bytes: 2,
          sha256: '1'.repeat(64),
          notes: null,
          created_at: '2026-08-31T02:00:00+00:00',
        }, 201)
      }
      if (path.endsWith('/documents/12') && method === 'GET') {
        return jsonResponse({ detail: '刷新文档详情失败' }, 503)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-version-open-12"]')
    const fileInput = wrapper.get('[data-testid="document-version-file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['v2'], 'survey-v2.dwg', { type: 'application/acad' })],
    })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="document-version-save"]').trigger('click')
    await settle()

    expect(versionPosts).toBe(1)
    expect(wrapper.get('[aria-label="追加文档版本"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="document-refresh-warning"]').text())
      .toContain('已保存，但刷新失败，请刷新页面')
  })

  it('资料台账按页筛选并高亮纪要命中，筛选失败时保留上次成功结果', async () => {
    const document = (id: number, title: string, searchExcerpt: string | null = null) => ({
      id,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title,
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T01:00:00+00:00',
      search_excerpt: searchExcerpt,
    })
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      requests.push(path)
      const url = new URL(path, 'http://localhost')
      const search = url.searchParams.get('search')
      if (search === '网络失败') throw new TypeError('disconnected')
      if (search === '十月十五日') {
        return jsonResponse({
          items: [document(9, '项目启动会', '客户确认最终交付日期为十月十五日。')],
          total: 1,
          page: 1,
          page_size: 20,
        })
      }
      if (url.searchParams.get('page') === '2') {
        return jsonResponse({
          items: [document(21, '第二页纪要')],
          total: 21,
          page: 2,
          page_size: 20,
        })
      }
      return jsonResponse({
        items: [document(1, '第一页纪要')],
        total: 21,
        page: 1,
        page_size: 20,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    expect(requests).toEqual([
      '/api/projects/SY-2026-001/documents?page=1&page_size=20&archived=active',
    ])
    expect(wrapper.text()).toContain('第一页纪要')
    expect(wrapper.text()).not.toContain('第二页纪要')

    await wrapper.get('[data-testid="document-pagination"] .btn-next').trigger('click')
    await settle()
    expect(requests[requests.length - 1]).toContain('page=2&page_size=20')
    expect(wrapper.text()).toContain('第二页纪要')

    await wrapper.get('[data-testid="document-search-input"]').setValue('十月十五日')
    await wrapper.get('[data-testid="document-search-submit"]').trigger('click')
    await settle()
    expect(requests[requests.length - 1]).toContain('search=%E5%8D%81%E6%9C%88%E5%8D%81%E4%BA%94%E6%97%A5')
    expect(wrapper.get('[data-testid="document-search-excerpt-9"]').text()).toContain('十月十五日')
    expect(wrapper.get('[data-testid="document-search-excerpt-9"] mark').text()).toBe('十月十五日')

    await wrapper.get('[data-testid="document-search-input"]').setValue('网络失败')
    await wrapper.get('[data-testid="document-search-submit"]').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('项目启动会')
    expect(wrapper.get('[data-testid="document-refresh-warning"]').text())
      .toContain('仍显示上一次成功读取的资料')
  })

  it('窄屏资料卡片保留完整操作语义并提供含标题的无障碍名称', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title: '项目启动会纪要',
      notes: null,
      latest_version_number: 2,
      archived_at: null,
      revision: 2,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T02:00:00+00:00',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [document], total: 1, page: 1, page_size: 20,
    })))

    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    const cards = wrapper.get('[data-testid="document-card-list"]')
    expect(cards.text()).toContain('项目启动会纪要')
    expect(cards.text()).toContain('项目策划纪要')
    expect(wrapper.get('[data-testid="document-mobile-preview-open-12"]').attributes('aria-label'))
      .toBe('预览项目启动会纪要')
    expect(wrapper.get('[data-testid="document-mobile-actions-12"]').attributes('aria-label'))
      .toBe('打开项目启动会纪要的资料操作')
  })

  it('资料编辑弹窗未修改直接关闭，填写或选择文件后底部取消统一确认放弃', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title: '项目启动会纪要',
      notes: '原备注',
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-08-31T01:00:00+00:00',
      updated_at: '2026-08-31T01:00:00+00:00',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [document], total: 1, page: 1, page_size: 20,
    })))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    const findDialog = (title: string) => {
      const dialog = wrapper.findAllComponents(ElDialog)
        .find((candidate) => candidate.props('title') === title)
      if (!dialog) throw new Error(`未找到弹窗 ${title}`)
      expect(typeof dialog.props('beforeClose')).toBe('function')
      expect(dialog.props('closeOnClickModal')).toBe(true)
      expect(dialog.props('closeOnPressEscape')).toBe(true)
      expect(dialog.props('showClose')).toBe(true)
      return dialog
    }
    const cancelDirtyDialog = async (title: string, cancelTestId: string) => {
      const dialog = findDialog(title)
      const previousConfirmCount = confirm.mock.calls.length
      await wrapper.get(`[data-testid="${cancelTestId}"]`).trigger('click')
      await settle()
      expect(confirm).toHaveBeenCalledTimes(previousConfirmCount + 1)
      expect(dialog.props('modelValue')).toBe(false)
    }

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    const cleanDialog = findDialog('新建逻辑文档')
    await wrapper.get('[data-testid="document-create-cancel"]').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(cleanDialog.props('modelValue')).toBe(false)

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('尚未上传的协议')
    await cancelDirtyDialog('新建逻辑文档', 'document-create-cancel')

    await wrapper.get('[data-testid="document-minutes-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('尚未保存的纪要')
    await cancelDirtyDialog('录入文字会议纪要', 'document-minutes-cancel')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-edit-open-12"]')
    await wrapper.get('[data-testid="document-edit-title"]').setValue('已修改但未保存的标题')
    await cancelDirtyDialog('编辑文档信息', 'document-edit-cancel')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-version-open-12"]')
    const fileInput = wrapper.get('[data-testid="document-version-file"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['V2'], 'minutes-v2.txt', { type: 'text/plain' })],
    })
    await fileInput.trigger('change')
    await cancelDirtyDialog('追加文档版本', 'document-version-cancel')

    await clickDocumentAction(wrapper, 12, '[data-testid="document-archive-open-12"]')
    await wrapper.get('[data-testid="document-archive-reason"]').setValue('暂不使用')
    await cancelDirtyDialog('归档逻辑文档', 'document-archive-cancel')
  })

  it('资料弹窗右上角、Esc 和遮罩使用同一未保存确认，拒绝放弃时保持打开', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [], total: 0, page: 1, page_size: 20,
    })))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('不要丢失')
    const dialog = wrapper.findAllComponents(ElDialog)
      .find((candidate) => candidate.props('title') === '新建逻辑文档')
    if (!dialog) throw new Error('未找到新建资料弹窗')
    const beforeClose = dialog.props('beforeClose')
    if (typeof beforeClose !== 'function') throw new Error('新建资料弹窗缺少 beforeClose')
    const done = vi.fn()
    beforeClose(done)
    await settle()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(done).not.toHaveBeenCalled()
    expect(dialog.props('modelValue')).toBe(true)
  })

  it('普通资料创建结果未知后锁定首次项目、输入和同一文件，放弃失败不丢安全重试入口', async () => {
    const file = new File(['contract'], 'contract.pdf', { type: 'application/pdf' })
    const repository = {
      listDocuments: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 }),
      createDocument: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      discardCreateDocument: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    } as unknown as ProjectOperatingRepository
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001', repository })
    await settle()

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('原合同')
    const fileInput = wrapper.get('[data-testid="document-create-file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="document-create-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="document-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="document-create-title"]').attributes('disabled')).toBeDefined()
    expect(fileInput.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="document-create-save"]').text()).toBe('原样重试')
    const firstCall = vi.mocked(repository.createDocument).mock.calls[0]!

    await wrapper.get('[data-testid="document-create-title"]').setValue('误改合同')
    await wrapper.get('[data-testid="document-create-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.createDocument).mock.calls[1]).toEqual(firstCall)
    expect(vi.mocked(repository.createDocument).mock.calls[1]![1]).toBe(firstCall[1])
    expect(vi.mocked(repository.createDocument).mock.calls[1]![1].file).toBe(file)

    await wrapper.get('[data-testid="document-create-abandon-pending"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="document-create-uncertain"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="document-create-title"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="document-create-abandon-pending"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="document-create-uncertain"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="document-create-title"]').attributes('disabled')).toBeUndefined()
  })

  it('普通资料创建结果未知后卸载重开仍恢复原文件并原样重试', async () => {
    const file = new File(['contract'], 'contract.pdf', { type: 'application/pdf' })
    const created = {
      id: 13,
      project_code: 'SY-2026-001',
      category: 'other',
      title: '原合同',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-04T01:00:00+00:00',
      updated_at: '2026-09-04T01:00:00+00:00',
      versions: [],
    }
    const repository = {
      listDocuments: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 }),
      createDocument: vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(created),
      discardCreateDocument: vi.fn().mockReturnValue(true),
    } as unknown as ProjectOperatingRepository
    const firstWrapper = mountComponent(ProjectDocumentsPanel, {
      projectCode: 'SY-2026-001',
      repository,
    })
    await settle()

    await firstWrapper.get('[data-testid="document-create-open"]').trigger('click')
    await firstWrapper.get('[data-testid="document-create-title"]').setValue('原合同')
    const fileInput = firstWrapper.get('[data-testid="document-create-file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await firstWrapper.get('[data-testid="document-create-save"]').trigger('click')
    await settle()
    const firstCall = vi.mocked(repository.createDocument).mock.calls[0]!
    firstWrapper.unmount()

    const reopenedWrapper = mountComponent(ProjectDocumentsPanel, {
      projectCode: 'SY-2026-001',
      repository,
    })
    await settle()

    expect(reopenedWrapper.get('[data-testid="document-create-uncertain"]').text()).toContain('结果未知')
    expect(reopenedWrapper.get('[data-testid="document-create-title"]').element).toHaveProperty('value', '原合同')
    expect(reopenedWrapper.get('[data-testid="document-create-save"]').text()).toBe('原样重试')
    await reopenedWrapper.get('[data-testid="document-create-save"]').trigger('click')
    await settle()

    expect(vi.mocked(repository.createDocument).mock.calls[1]).toEqual(firstCall)
    expect(vi.mocked(repository.createDocument).mock.calls[1]![1]).toBe(firstCall[1])
    expect(firstCall[1].file).toBe(file)
    expect(reopenedWrapper.find('[data-testid="document-create-uncertain"]').exists()).toBe(false)
  })

  it('普通资料追加版本结果未知后锁定原文档、revision 和同一文件，放弃失败保持锁定', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'site_survey',
      title: '现场测绘',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 3,
      created_at: '2026-09-04T01:00:00+00:00',
      updated_at: '2026-09-04T01:00:00+00:00',
    }
    const file = new File(['drawing'], 'survey-v2.dwg', { type: 'application/acad' })
    const repository = {
      listDocuments: vi.fn().mockResolvedValue({ items: [document], total: 1, page: 1, page_size: 20 }),
      addDocumentVersion: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      discardAddDocumentVersion: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    } as unknown as ProjectOperatingRepository
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001', repository })
    await settle()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-version-open-12"]')
    const fileInput = wrapper.get('[data-testid="document-version-file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="document-version-notes"]').setValue('原版本说明')
    await wrapper.get('[data-testid="document-version-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="document-version-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="document-version-notes"]').attributes('disabled')).toBeDefined()
    expect(fileInput.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="document-version-save"]').text()).toBe('原样重试')
    const firstCall = vi.mocked(repository.addDocumentVersion).mock.calls[0]!

    await wrapper.get('[data-testid="document-version-notes"]').setValue('误改说明')
    await wrapper.get('[data-testid="document-version-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.addDocumentVersion).mock.calls[1]).toEqual(firstCall)
    expect(vi.mocked(repository.addDocumentVersion).mock.calls[1]![2]).toBe(firstCall[2])
    expect(firstCall[1]).toBe(12)
    expect(firstCall[2].expected_revision).toBe(3)
    expect(firstCall[2].file).toBe(file)

    await wrapper.get('[data-testid="document-version-abandon-pending"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="document-version-uncertain"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="document-version-notes"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="document-version-abandon-pending"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="document-version-uncertain"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="document-version-notes"]').attributes('disabled')).toBeUndefined()
  })

  it('切换项目或卸载后下载 Blob 迟到时不会触发浏览器下载', async () => {
    const document = (projectCode: string, id: number) => ({
      id,
      project_code: projectCode,
      category: 'other',
      title: `${projectCode} 资料`,
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-04T01:00:00+00:00',
      updated_at: '2026-09-04T01:00:00+00:00',
    })
    const detail = (projectCode: string, id: number) => ({
      ...document(projectCode, id),
      versions: [{
        id: id + 100,
        version_number: 1,
        original_filename: `${projectCode}.pdf`,
        content_type: 'application/pdf',
        size_bytes: 4,
        sha256: '0'.repeat(64),
        notes: null,
        created_at: '2026-09-04T01:00:00+00:00',
      }],
    })
    const makeRepository = (
      projectCode: string,
      id: number,
      lateDownload: ReturnType<typeof deferred<Blob>>,
    ) => ({
      listDocuments: vi.fn().mockResolvedValue({
        items: [document(projectCode, id)], total: 1, page: 1, page_size: 20,
      }),
      getDocument: vi.fn().mockResolvedValue(detail(projectCode, id)),
      downloadDocumentVersion: vi.fn().mockReturnValue(lateDownload.promise),
    }) as unknown as ProjectOperatingRepository
    const createObjectUrl = vi.fn(() => 'blob:late-document')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    const projectDownload = deferred<Blob>()
    const repositoryA = makeRepository('PROJECT-A', 12, projectDownload)
    const repositoryB = makeRepository('PROJECT-B', 22, deferred<Blob>())
    const wrapper = mountComponent(ProjectDocumentsPanel, {
      projectCode: 'PROJECT-A',
      repository: repositoryA,
    })
    await settle()
    await clickDocumentAction(wrapper, 12, '[data-testid="document-download-12"]')
    await vi.waitFor(() => expect(repositoryA.downloadDocumentVersion).toHaveBeenCalled())

    await wrapper.setProps({ projectCode: 'PROJECT-B', repository: repositoryB })
    await settle()
    projectDownload.resolve(new Blob(['late']))
    await settle()
    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()

    const unmountDownload = deferred<Blob>()
    const repositoryC = makeRepository('PROJECT-C', 32, unmountDownload)
    const unmountedWrapper = mountComponent(ProjectDocumentsPanel, {
      projectCode: 'PROJECT-C',
      repository: repositoryC,
    })
    await settle()
    await clickDocumentAction(unmountedWrapper, 32, '[data-testid="document-download-32"]')
    await vi.waitFor(() => expect(repositoryC.downloadDocumentVersion).toHaveBeenCalled())
    unmountedWrapper.unmount()
    unmountDownload.resolve(new Blob(['late-after-unmount']))
    await settle()

    expect(createObjectUrl).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('文字纪要创建结果未知后锁定原内容，并用同一 File 和幂等键原样重试', async () => {
    const created = {
      id: 13,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title: '启动会纪要',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-04T01:00:00+00:00',
      updated_at: '2026-09-04T01:00:00+00:00',
      versions: [{
        id: 31,
        version_number: 1,
        original_filename: 'planning-minutes.txt',
        content_type: 'text/plain',
        size_bytes: 12,
        sha256: '0'.repeat(64),
        notes: null,
        created_at: '2026-09-04T01:00:00+00:00',
      }],
    }
    const attempts: RequestInit[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 })
      }
      if (path.endsWith('/documents') && init?.method === 'POST') {
        attempts.push(init)
        if (attempts.length === 1) throw new TypeError('disconnected')
        return jsonResponse(created, 201)
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    await wrapper.get('[data-testid="document-minutes-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-title"]').setValue('启动会纪要')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('客户确认十月交付。')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="document-minutes-uncertain"]').text()).toContain('结果未知')
    expect(wrapper.get('[data-testid="document-minutes-title"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="document-minutes-content"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="document-minutes-save"]').text()).toBe('原样重试')

    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()

    expect(attempts).toHaveLength(2)
    const firstKey = (attempts[0]?.headers as Record<string, string>)['Idempotency-Key']
    const secondKey = (attempts[1]?.headers as Record<string, string>)['Idempotency-Key']
    expect(secondKey).toBe(firstKey)
    const firstBody = attempts[0]?.body as FormData
    const secondBody = attempts[1]?.body as FormData
    expect(secondBody.get('category')).toBe(firstBody.get('category'))
    expect(secondBody.get('title')).toBe(firstBody.get('title'))
    expect(secondBody.get('notes')).toBe(firstBody.get('notes'))
    expect(secondBody.get('file')).toBe(firstBody.get('file'))
  })

  it('文字纪要追加结果未知后可精确放弃，再修改内容并使用新幂等键提交', async () => {
    const document = {
      id: 12,
      project_code: 'SY-2026-001',
      category: 'planning_minutes',
      title: '启动会纪要',
      notes: null,
      latest_version_number: 1,
      archived_at: null,
      revision: 1,
      created_at: '2026-09-04T01:00:00+00:00',
      updated_at: '2026-09-04T01:00:00+00:00',
    }
    const attempts: RequestInit[] = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [document], total: 1, page: 1, page_size: 20 })
      }
      if (path.endsWith('/documents/12/versions') && init?.method === 'POST') {
        attempts.push(init)
        if (attempts.length === 1) throw new TypeError('disconnected')
        return jsonResponse({
          id: 32,
          version_number: 2,
          original_filename: 'planning-minutes.txt',
          content_type: 'text/plain',
          size_bytes: 12,
          sha256: '1'.repeat(64),
          notes: null,
          created_at: '2026-09-04T02:00:00+00:00',
        }, 201)
      }
      if (path.endsWith('/documents/12') && init?.method === undefined) {
        return jsonResponse({
          ...document,
          latest_version_number: 2,
          revision: 2,
          versions: [],
        })
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    await clickDocumentAction(wrapper, 12, '[data-testid="document-minutes-version-open-12"]')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('客户先确认十月交付。')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()
    const firstKey = (attempts[0]?.headers as Record<string, string>)['Idempotency-Key']
    expect(wrapper.get('[data-testid="document-minutes-save"]').text()).toBe('原样重试')

    await wrapper.get('[data-testid="document-minutes-abandon-pending"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="document-minutes-content"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('客户改为十一月交付。')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await settle()

    expect(attempts).toHaveLength(2)
    expect((attempts[1]?.headers as Record<string, string>)['Idempotency-Key']).not.toBe(firstKey)
    const firstFile = (attempts[0]?.body as FormData).get('file') as File
    const secondFile = (attempts[1]?.body as FormData).get('file') as File
    expect(secondFile).not.toBe(firstFile)
    await expect(readBlob(secondFile)).resolves.toBe('客户改为十一月交付。')
  })
})
