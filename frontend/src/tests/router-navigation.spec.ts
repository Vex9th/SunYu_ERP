import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { defineComponent } from 'vue'
import { createMemoryHistory, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from '../App.vue'
import DashboardPanel from '../components/DashboardPanel.vue'
import ProjectDashboard from '../components/ProjectDashboard.vue'
import { createAppRouter } from '../router'

function testRouter(): Router {
  return createAppRouter(createMemoryHistory())
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const projectDashboard = {
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

const dashboardProps = {
  overview: null,
  loading: false,
  overviewError: null,
  requestError: null,
  systemRequestError: null,
  successNotice: null,
  backupBusy: false,
  saveBusy: false,
  logoutBusy: false,
}

const systemOverview = {
  data_directory: 'D:\\SunYu ERP\\Data',
  database_path: 'D:\\SunYu ERP\\Data\\sunyu.sqlite3',
  scheduler: { alive: true, last_error_at: null, last_error_code: null },
  backup: {
    enabled: true,
    directory: 'D:\\Backups',
    interval_hours: 24,
    retention_days: 30,
    last_run: null,
  },
}

function dashboardStubs() {
  return {
    HomeWorkbench: true,
    ProjectCenter: true,
    CompanyCenter: true,
    InventoryCenter: true,
    ProjectDashboard: defineComponent({
      props: { projectCode: { type: String, required: true } },
      template: '<div data-testid="routed-project">{{ projectCode }}</div>',
    }),
  }
}

async function mountProjectDashboard(router: Router): Promise<VueWrapper> {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(projectDashboard)))
  const wrapper = mount(ProjectDashboard, {
    attachTo: document.body,
    props: { projectCode: 'SY-2026-001' },
    global: {
      plugins: [ElementPlus, router],
      stubs: {
        ProjectOverviewPanel: {
          template: '<div data-testid="project-home-content">项目首页</div>',
        },
        ProjectRecordsPanel: true,
        ProjectDocumentsPanel: {
          template: '<div data-testid="project-documents-content">资料与设计</div>',
        },
        ProjectCommercialPanel: {
          template: '<div data-testid="project-commercial-content">报价与收款</div>',
        },
        ProcurementWorkspace: {
          template: '<div data-testid="project-procurement-content">procurement</div>',
        },
        WorkforceCenter: {
          template: '<div data-testid="project-workforce-content">workforce</div>',
        },
        DeliveryWorkspace: {
          template: '<div data-testid="project-delivery-content">delivery</div>',
        },
      },
    },
  })
  await vi.waitFor(() => {
    expect(wrapper.find('[data-testid="project-workspace-tabs"]').exists()).toBe(true)
  })
  return wrapper
}

describe('项目深链接导航', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('发布路由包含项目、资料列表和资料详情地址', () => {
    const router = testRouter()

    expect(router.resolve('/projects').name).toBe('projects')
    expect(router.resolve('/companies').name).toBe('companies')
    expect(router.resolve('/inventory').name).toBe('inventory')
    expect(router.resolve('/settings').name).toBe('settings')
    expect(router.resolve('/projects/SY-2026-001').name).toBe('project')
    expect(router.resolve('/projects/SY-2026-001/documents').name).toBe('project-documents')
    expect(router.resolve('/projects/SY-2026-001/commercial').name).toBe('project-commercial')
    expect(router.resolve('/projects/SY-2026-001/procurement').name).toBe('project-procurement')
    expect(router.resolve('/projects/SY-2026-001/workforce').name).toBe('project-workforce')
    expect(router.resolve('/projects/SY-2026-001/delivery').name).toBe('project-delivery')
    expect(router.resolve('/projects/SY-2026-001/documents/12?version=3').name).toBe('project-document')
    expect(router.resolve('/projects/SY-2026-001/documents/12?version=3').query.version).toBe('3')
  })

  it('未知地址展示友好 404 页面并提供返回首页入口', async () => {
    const router = testRouter()
    await router.push('/missing-page')
    await router.isReady()

    const wrapper = mount(defineComponent({ template: '<router-view />' }), {
      attachTo: document.body,
      global: { plugins: [ElementPlus, router] },
    })

    expect(router.currentRoute.value.name).toBe('not-found')
    expect(wrapper.get('[data-testid="not-found-page"]').text()).toContain('页面不存在')
    expect(document.activeElement).toBe(wrapper.get('h1').element)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      authenticated: false,
      password_configured: true,
    })))
    await wrapper.get('[data-testid="not-found-home"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('home'))
  })

  it('真实 App 入口登录后也会渲染 404，而不是回退到总览', async () => {
    const router = testRouter()
    await router.push('/missing-page')
    await router.isReady()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, password_configured: true }))
      .mockResolvedValueOnce(jsonResponse(systemOverview)))

    const wrapper = mount(App, {
      attachTo: document.body,
      global: { plugins: [ElementPlus, router] },
    })

    await vi.waitFor(() => expect(wrapper.find('[data-testid="app-loading"]').exists()).toBe(false))
    expect(wrapper.get('[data-testid="not-found-page"]').text()).toContain('页面不存在')
    expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  })

  it.each([
    ['/projects', 'projects'],
    ['/companies', 'companies'],
    ['/inventory', 'inventory'],
    ['/settings', 'system'],
  ])('直接打开 %s 时恢复对应的全局页面', async (path, testId) => {
    const router = testRouter()
    await router.push(path)
    await router.isReady()

    const wrapper = mount(DashboardPanel, {
      props: dashboardProps,
      global: {
        plugins: [ElementPlus, router],
        stubs: {
          ...dashboardStubs(),
          ProjectCenter: { template: '<div data-testid="projects">projects</div>' },
          CompanyCenter: { template: '<div data-testid="companies">companies</div>' },
          InventoryCenter: { template: '<div data-testid="inventory">inventory</div>' },
        },
      },
    })

    if (testId === 'system') {
      expect(wrapper.find('[data-testid="scheduler-status"]').exists()).toBe(false)
      expect(wrapper.get('.system-settings').isVisible()).toBe(true)
    } else {
      expect(wrapper.get(`[data-testid="${testId}"]`).isVisible()).toBe(true)
    }
  })

  it('直接打开资料详情地址时自动进入对应项目', async () => {
    const router = testRouter()
    await router.push('/projects/SY-2026-001/documents/12?version=3')
    await router.isReady()

    const wrapper = mount(DashboardPanel, {
      props: dashboardProps,
      global: { plugins: [ElementPlus, router], stubs: dashboardStubs() },
    })

    expect(wrapper.get('[data-testid="routed-project"]').text()).toBe('SY-2026-001')
  })

  it('退出项目页面后把焦点还给原项目入口', async () => {
    const router = testRouter()
    await router.push('/projects')
    await router.isReady()
    const wrapper = mount(DashboardPanel, {
      attachTo: document.body,
      props: dashboardProps,
      global: {
        plugins: [ElementPlus, router],
        stubs: {
          ...dashboardStubs(),
          ProjectCenter: defineComponent({
            emits: ['open-dashboard'],
            template: '<button data-testid="project-dashboard-SY-2026-001" @click="$emit(\'open-dashboard\', \'SY-2026-001\')">进入项目</button>',
          }),
          ProjectDashboard: defineComponent({
            emits: ['back'],
            template: '<button data-testid="dashboard-project-back" @click="$emit(\'back\')">返回</button>',
          }),
        },
      },
    })
    const origin = wrapper.get('[data-testid="project-dashboard-SY-2026-001"]')
    await origin.trigger('focus')
    await origin.trigger('click')
    await wrapper.get('[data-testid="dashboard-project-back"]').trigger('click')

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(origin.element)
    })
  })

  it('资料标签更新地址，离开后回到项目地址，浏览器后退会恢复资料标签', async () => {
    const router = testRouter()
    await router.push('/projects/SY-2026-001')
    await router.isReady()
    const wrapper = await mountProjectDashboard(router)

    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents')
      expect(wrapper.get('[data-testid="project-documents-content"]').isVisible()).toBe(true)
    })

    await wrapper.get('[data-testid="project-nav-commercial"]').trigger('click')
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/commercial')
      expect(wrapper.get('[data-testid="project-commercial-content"]').isVisible()).toBe(true)
    })

    router.back()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents')
      expect(wrapper.get('[data-testid="project-documents-content"]').isVisible()).toBe(true)
    })
  })

  it.each([
    ['project-commercial', '/projects/SY-2026-001/commercial', 'project-nav-commercial', 'project-commercial-content'],
    ['project-procurement', '/projects/SY-2026-001/procurement', 'project-nav-procurement', 'project-procurement-content'],
    ['project-workforce', '/projects/SY-2026-001/workforce', 'project-nav-workforce', 'project-workforce-content'],
    ['project-delivery', '/projects/SY-2026-001/delivery', 'project-nav-delivery', 'project-delivery-content'],
  ])('直接打开 %s 时恢复项目业务标签', async (_name, path, navTestId, contentTestId) => {
    const router = testRouter()
    await router.push(path)
    await router.isReady()
    const wrapper = await mountProjectDashboard(router)

    expect(wrapper.find(`[data-testid="${navTestId}"]`).exists()).toBe(true)
    expect(wrapper.get(`[data-testid="${contentTestId}"]`).isVisible()).toBe(true)
  })

  it('直接打开资料详情地址时自动选中资料与设计', async () => {
    const router = testRouter()
    await router.push('/projects/SY-2026-001/documents/12?version=3')
    await router.isReady()
    const wrapper = await mountProjectDashboard(router)

    expect(wrapper.get('[data-testid="project-documents-content"]').isVisible()).toBe(true)
  })

  it('没有 Router provider 时既有组件仍可挂载', () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {})))

    expect(() => mount(DashboardPanel, {
      props: dashboardProps,
      global: { plugins: [ElementPlus], stubs: dashboardStubs() },
    })).not.toThrow()
    expect(() => mount(ProjectDashboard, {
      props: { projectCode: 'SY-2026-001' },
      global: { plugins: [ElementPlus] },
    })).not.toThrow()
  })

  it('备份执行期间锁定全部设置，并保留概况刷新前的未保存草稿', async () => {
    const wrapper = mount(DashboardPanel, {
      props: { ...dashboardProps, overview: systemOverview },
      global: { plugins: [ElementPlus], stubs: dashboardStubs() },
    })
    await wrapper.get('[data-testid="nav-system"]').trigger('click')
    await wrapper.get('[data-testid="backup-directory"]').setValue('D:\\Draft')
    await wrapper.setProps({ backupBusy: true })

    expect(wrapper.get('[data-testid="backup-enabled"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-directory"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-interval"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="backup-retention"] input').attributes('disabled')).toBeDefined()

    await wrapper.setProps({
      overview: {
        ...systemOverview,
        backup: {
          ...systemOverview.backup,
          last_run: {
            status: 'success',
            started_at: '2026-09-04T10:00:00+08:00',
            finished_at: '2026-09-04T10:01:00+08:00',
            target_path: 'D:\\Backups\\run',
            error_message: null,
          },
        },
      },
    })

    expect((wrapper.get('[data-testid="backup-directory"]').element as HTMLInputElement).value).toBe('D:\\Draft')
  })
})
