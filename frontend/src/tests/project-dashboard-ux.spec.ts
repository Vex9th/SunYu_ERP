import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectDashboard from '../components/ProjectDashboard.vue'
import type { ProjectOperatingRepository } from '../repositories/project-operating.live'

const project = {
  id: 21,
  project_code: 'SY-2026-001',
  company_id: 1,
  company_name: '甲公司',
  name: '装配线改造',
  description: null,
  status: 'active',
  closure_type: null,
  archive_reason: null,
  archived_at: null,
  revision: 4,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
}

function dashboard(projectRecord: Record<string, unknown> = project) {
  return {
    project: projectRecord,
    company: { id: 1, name: '甲公司' },
    contacts: [],
    documents: { document_count: 0, version_count: 0, categories: [] },
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
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

const childStub = defineComponent({
  props: { readonly: Boolean },
  emits: ['changed'],
  template: '<button data-testid="child-change" :data-readonly="String(readonly)" @click="$emit(\'changed\')">change</button>',
})

function mountDashboard(): VueWrapper {
  return mount(ProjectDashboard, {
    attachTo: document.body,
    props: { projectCode: 'SY-2026-001' },
    global: {
      plugins: [ElementPlus],
      stubs: {
        ProjectOverviewPanel: childStub,
        ProjectRecordsPanel: true,
        ProjectDocumentsPanel: childStub,
        ProjectCommercialPanel: childStub,
        ProcurementWorkspace: childStub,
        WorkforceCenter: childStub,
        DeliveryWorkspace: childStub,
      },
    },
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('项目工作页关键交互', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('编辑项目先校验必填，并允许改换客户', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard())
      if (path === '/api/companies') return jsonResponse([
        { id: 1, name: '甲公司' },
        { id: 2, name: '乙公司' },
      ])
      if (init?.method === 'PUT') {
        return jsonResponse({ ...project, company_id: 2, company_name: '乙公司', name: '新名称', revision: 5 })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-edit-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await vi.waitFor(() => expect(requests.some(([path]) => path === '/api/companies')).toBe(true))
    await wrapper.get('[data-testid="project-edit-name"]').setValue('   ')
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    expect(wrapper.text()).toContain('请输入项目名称并选择客户')
    expect(requests.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await wrapper.get('[data-testid="project-edit-name"]').setValue(' 新名称 ')
    await wrapper.get('[data-testid="project-edit-company"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    Array.from(document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'))
      .find((item) => item.textContent?.includes('乙公司'))?.click()
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await vi.waitFor(() => expect(requests.some(([, init]) => init?.method === 'PUT')).toBe(true))

    const update = requests.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({ company_id: 2, name: '新名称' })
  })

  it('项目编辑和完结弹窗只在实际改动后确认放弃', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard())
      if (path === '/api/companies') return jsonResponse([{ id: 1, name: '甲公司' }])
      throw new Error(`unexpected ${path}`)
    }))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-edit-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await wrapper.get('[data-testid="project-edit-cancel"]').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="编辑项目"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await wrapper.get('[data-testid="project-edit-description"]').setValue('新说明')
    await wrapper.get('[data-testid="project-edit-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="编辑项目"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="完结项目"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-reason"]').setValue('客户暂停')
    const closeDialog = wrapper.findAllComponents(ElDialog)
      .find((candidate) => candidate.props('title') === '完结项目')
    if (!closeDialog) throw new Error('未找到完结项目弹窗')
    const beforeClose = closeDialog.props('beforeClose')
    if (typeof beforeClose !== 'function') throw new Error('完结项目弹窗缺少 beforeClose')
    const done = vi.fn()
    beforeClose(done)
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('项目恢复弹窗干净取消直接关闭，改动后再确认', async () => {
    const archived = {
      ...project,
      status: 'archived',
      closure_type: 'cancelled',
      archive_reason: '客户暂停',
      archived_at: '2026-09-03T00:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(dashboard(archived))))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    await wrapper.get('[data-testid="project-restore-cancel"]').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="恢复项目"]').isVisible()).toBe(false)

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    await wrapper.get('[data-testid="project-restore-reason"]').setValue('重新启动')
    await wrapper.get('[data-testid="project-restore-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="恢复项目"]').isVisible()).toBe(false)
  })

  it('项目编辑或完结返回 401 时退出当前会话', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard())
      if (path === '/api/companies') return jsonResponse([{ id: 1, name: '甲公司' }])
      if (init?.method === 'PUT') return jsonResponse({ detail: '请重新登录' }, 401)
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-edit-open"]').exists()).toBe(true))
    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="project-edit-save"]').attributes('disabled')).toBeUndefined())
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('session-expired')).toEqual([['请重新登录']]))
  })

  it('归档项目显示只读提示并把只读状态传给业务页', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(dashboard({
      ...project,
      status: 'archived',
      closure_type: null,
      archived_at: '2026-09-03T00:00:00Z',
    }))))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-archive-readonly"]').exists()).toBe(true))

    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已归档')
    expect(wrapper.find('[data-testid="project-edit-open"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="child-change"]').attributes('data-readonly')).toBe('true')
  })

  it('子页面写入成功以及切回项目首页都会重读仪表台', async () => {
    let dashboardLoads = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).endsWith('/dashboard')) {
        dashboardLoads += 1
        return jsonResponse(dashboard())
      }
      throw new Error(`unexpected ${String(input)}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-nav-commercial"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-nav-commercial"]').trigger('click')
    const visibleChange = wrapper.findAll('[data-testid="child-change"]').find((item) => item.isVisible())
    expect(visibleChange).toBeDefined()
    await visibleChange?.trigger('click')
    await vi.waitFor(() => expect(dashboardLoads).toBe(2))
    await wrapper.get('[data-testid="project-nav-home"]').trigger('click')
    await vi.waitFor(() => expect(dashboardLoads).toBe(3))
  })

  it.each([
    ['completed', '已完结项目', '原完结记录会保留在审计历史'],
    ['cancelled', '已取消项目', '原取消记录会保留在审计历史'],
  ])('归档项目 %s 可填写原因恢复为在建', async (closureType, warning, auditNote) => {
    const requests: Array<[string, RequestInit | undefined]> = []
    const archived = {
      ...project,
      status: 'archived',
      closure_type: closureType,
      archive_reason: '历史原因',
      archived_at: '2026-09-03T00:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard(archived))
      if (path.endsWith('/restore')) {
        return jsonResponse({
          ...archived,
          status: 'active',
          closure_type: null,
          archive_reason: null,
          archived_at: null,
          revision: 5,
        })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    const dialog = wrapper.get('[aria-label="恢复项目"]')
    expect(dialog.text()).toContain(warning)
    expect(dialog.text()).toContain(auditNote)
    expect(dialog.get('[data-testid="project-restore-save"]').attributes('disabled')).toBeDefined()
    await dialog.get('[data-testid="project-restore-reason"]').setValue('客户确认继续实施')
    await dialog.get('[data-testid="project-restore-save"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="project-status"]').text()).toContain('在建'))

    const restore = requests.find(([path]) => path.endsWith('/restore'))
    expect(restore?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(restore?.[1]?.body))).toEqual({
      reason: '客户确认继续实施',
      expected_revision: 4,
    })
    expect((restore?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('项目恢复结果未知时锁定原请求并使用同一幂等键原样重试', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    let dashboardRead = 0
    let restoreAttempt = 0
    const archived = {
      ...project,
      status: 'archived',
      closure_type: 'cancelled',
      archive_reason: '客户暂停',
      archived_at: '2026-09-03T00:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) {
        dashboardRead += 1
        return jsonResponse(dashboard(archived))
      }
      if (path.endsWith('/restore')) {
        restoreAttempt += 1
        if (restoreAttempt === 1) throw new TypeError('response lost')
        return jsonResponse({
          ...archived,
          status: 'active',
          closure_type: null,
          archive_reason: null,
          archived_at: null,
          revision: 5,
        })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    await wrapper.get('[data-testid="project-restore-reason"]').setValue('恢复施工')
    await wrapper.get('[data-testid="project-restore-save"]').trigger('click')
    await vi.waitFor(() => expect(dashboardRead).toBe(2))

    expect(wrapper.find('[data-testid="project-restore-save"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-restore-cancel"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="project-restore-reason"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="project-restore-original-retry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="project-status"]').text()).toContain('在建'))

    const restoreCalls = requests.filter(([path]) => path.endsWith('/restore'))
    expect(restoreCalls).toHaveLength(2)
    expect(restoreCalls[0]?.[1]?.body).toBe(restoreCalls[1]?.[1]?.body)
    expect((restoreCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((restoreCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('项目恢复收到 2xx 非法 JSON 时核对状态并使用原请求重试', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    let restoreAttempt = 0
    const archived = {
      ...project,
      status: 'archived',
      closure_type: 'cancelled',
      archive_reason: '客户暂停',
      archived_at: '2026-09-03T00:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard(archived))
      if (path.endsWith('/restore')) {
        restoreAttempt += 1
        if (restoreAttempt === 1) {
          return new Response('{malformed', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return jsonResponse({
          ...archived,
          status: 'active',
          closure_type: null,
          archive_reason: null,
          archived_at: null,
          revision: 5,
        })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    await wrapper.get('[data-testid="project-restore-reason"]').setValue('恢复施工')
    await wrapper.get('[data-testid="project-restore-save"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-original-retry"]').exists()).toBe(true))
    await wrapper.get('[data-testid="project-restore-original-retry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="project-status"]').text()).toContain('在建'))

    const restoreCalls = requests.filter(([path]) => path.endsWith('/restore'))
    expect(restoreCalls).toHaveLength(2)
    expect(restoreCalls[0]?.[1]?.body).toBe(restoreCalls[1]?.[1]?.body)
    expect((restoreCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((restoreCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('项目完结收到 2xx 非法 JSON 时核对状态并使用原请求重试', async () => {
    const requests: Array<[string, RequestInit | undefined]> = []
    let closeAttempt = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      if (path.endsWith('/dashboard')) return jsonResponse(dashboard())
      if (path.endsWith('/close')) {
        closeAttempt += 1
        if (closeAttempt === 1) {
          return new Response('{malformed', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return jsonResponse({
          ...project,
          status: 'archived',
          closure_type: 'cancelled',
          archive_reason: '客户暂停',
          archived_at: '2026-09-03T00:00:00Z',
          revision: 5,
        })
      }
      throw new Error(`unexpected ${path}`)
    }))
    const wrapper = mountDashboard()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-close-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-type"] input[value="cancelled"]').setValue(true)
    await wrapper.get('[data-testid="project-close-reason"]').setValue('客户暂停')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-close-original-retry"]').exists()).toBe(true))
    expect(wrapper.get('[data-testid="project-close-cancel"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="project-close-original-retry"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已取消'))

    const closeCalls = requests.filter(([path]) => path.endsWith('/close'))
    expect(closeCalls).toHaveLength(2)
    expect(closeCalls[0]?.[1]?.body).toBe(closeCalls[1]?.[1]?.body)
    expect((closeCalls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
      .toBe((closeCalls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'])
  })

  it('恢复请求在途时切换仓储，迟到响应不得改写新仓储状态', async () => {
    const oldRestore = deferred<typeof project>()
    const archived = {
      ...project,
      status: 'archived',
      closure_type: 'cancelled',
      archive_reason: '客户暂停',
      archived_at: '2026-09-03T00:00:00Z',
    }
    const nextArchived = {
      ...archived,
      name: '新仓储项目',
      archive_reason: '新仓储保持归档',
      revision: 8,
    }
    const oldRepository = {
      getProjectDashboard: vi.fn(async () => dashboard(archived)),
      restoreProject: vi.fn(async () => oldRestore.promise),
    } as unknown as ProjectOperatingRepository
    const nextRepository = {
      getProjectDashboard: vi.fn(async () => dashboard(nextArchived)),
      restoreProject: vi.fn(),
    } as unknown as ProjectOperatingRepository
    const wrapper = mount(ProjectDashboard, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository: oldRepository },
      global: {
        plugins: [ElementPlus],
        stubs: {
          ProjectOverviewPanel: childStub,
          ProjectDocumentsPanel: childStub,
          ProjectCommercialPanel: childStub,
          ProcurementWorkspace: childStub,
          WorkforceCenter: childStub,
          DeliveryWorkspace: childStub,
        },
      },
    })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-restore-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-restore-open"]').trigger('click')
    await wrapper.get('[data-testid="project-restore-reason"]').setValue('恢复旧项目')
    await wrapper.get('[data-testid="project-restore-save"]').trigger('click')
    await wrapper.setProps({ repository: nextRepository })
    await vi.waitFor(() => expect(wrapper.text()).toContain('新仓储项目'))

    oldRestore.resolve({
      ...project,
      status: 'active',
      closure_type: null,
      archive_reason: null,
      archived_at: null,
      revision: 5,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已取消')
    expect(wrapper.text()).toContain('新仓储项目')
    expect(nextRepository.restoreProject).not.toHaveBeenCalled()
  })

  it('A 项目编辑迟到失败不得解锁或污染 B 项目正在保存的表单', async () => {
    const projectA = { ...project, project_code: 'SY-A', name: 'A 项目' }
    const projectB = { ...project, project_code: 'SY-B', name: 'B 项目', revision: 7 }
    const updateA = deferred<typeof projectA>()
    const updateB = deferred<typeof projectB>()
    const repositoryA = {
      getProjectDashboard: vi.fn(async () => dashboard(projectA)),
      updateProject: vi.fn(async () => updateA.promise),
    } as unknown as ProjectOperatingRepository
    const repositoryB = {
      getProjectDashboard: vi.fn(async () => dashboard(projectB)),
      updateProject: vi.fn(async () => updateB.promise),
    } as unknown as ProjectOperatingRepository
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([
      { id: 1, name: '甲公司' },
    ])))
    const wrapper = mount(ProjectDashboard, {
      attachTo: document.body,
      props: { projectCode: 'SY-A', repository: repositoryA },
      global: {
        plugins: [ElementPlus],
        stubs: {
          ProjectOverviewPanel: childStub,
          ProjectDocumentsPanel: childStub,
          ProjectCommercialPanel: childStub,
          ProcurementWorkspace: childStub,
          WorkforceCenter: childStub,
          DeliveryWorkspace: childStub,
        },
      },
    })
    await vi.waitFor(() => expect(wrapper.text()).toContain('A 项目'))

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="project-edit-save"]').attributes('disabled')).toBeUndefined()
    })
    await wrapper.get('[data-testid="project-edit-name"]').setValue('A 修改中')
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await vi.waitFor(() => expect(repositoryA.updateProject).toHaveBeenCalledTimes(1))

    await wrapper.setProps({ projectCode: 'SY-B', repository: repositoryB })
    await vi.waitFor(() => expect(wrapper.text()).toContain('B 项目'))
    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="project-edit-save"]').attributes('disabled')).toBeUndefined()
    })
    await wrapper.get('[data-testid="project-edit-name"]').setValue('B 修改中')
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await vi.waitFor(() => expect(repositoryB.updateProject).toHaveBeenCalledTimes(1))
    expect(wrapper.get('[data-testid="project-edit-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="project-edit-cancel"]').attributes('disabled')).toBeDefined()

    updateA.reject(new Error('A 项目保存失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((wrapper.get('[data-testid="project-edit-name"]').element as HTMLInputElement).value)
      .toBe('B 修改中')
    expect(wrapper.text()).not.toContain('A 项目保存失败')
    expect(wrapper.get('[data-testid="project-edit-save"]').attributes('disabled')).toBeDefined()

    updateB.resolve({ ...projectB, name: 'B 修改中', revision: 8 })
    await vi.waitFor(() => expect(wrapper.text()).toContain('B 修改中'))
    expect(wrapper.get('[aria-label="编辑项目"]').isVisible()).toBe(false)
  })
})
