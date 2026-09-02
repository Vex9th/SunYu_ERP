import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { defineComponent } from 'vue'
import { createMemoryHistory, type Router } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
        ProjectRecordsPanel: {
          template: '<div data-testid="project-documents-content">资料与设计</div>',
        },
        ProjectDocumentsPanel: true,
        ProjectCommercialPanel: {
          template: '<div data-testid="project-commercial-content">报价与收款</div>',
        },
        ProcurementWorkspace: true,
        WorkforceCenter: true,
        DeliveryWorkspace: true,
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

    expect(router.resolve('/projects/SY-2026-001').name).toBe('project')
    expect(router.resolve('/projects/SY-2026-001/documents').name).toBe('project-documents')
    expect(router.resolve('/projects/SY-2026-001/documents/12?version=3').name).toBe('project-document')
    expect(router.resolve('/projects/SY-2026-001/documents/12?version=3').query.version).toBe('3')
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
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001')
      expect(wrapper.get('[data-testid="project-commercial-content"]').isVisible()).toBe(true)
    })

    router.back()
    await vi.waitFor(() => {
      expect(router.currentRoute.value.fullPath).toBe('/projects/SY-2026-001/documents')
      expect(wrapper.get('[data-testid="project-documents-content"]').isVisible()).toBe(true)
    })
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
})
