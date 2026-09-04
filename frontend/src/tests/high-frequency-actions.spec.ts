import { mount } from '@vue/test-utils'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CompanyCenter from '../components/CompanyCenter.vue'
import DeliveryWorkspace from '../components/delivery/DeliveryWorkspace.vue'
import PortfolioOperatingOverview from '../components/PortfolioOperatingOverview.vue'
import ProjectCenter from '../components/ProjectCenter.vue'
import type { DeliveryWorkspaceRepository } from '../repositories/delivery.live'
import { MockWorkforceRepository } from '../repositories/workforce'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const company = {
  id: 1, name: '苏州设备厂', taxpayer_id: null, registered_address: null,
  registered_phone: null, bank_name: null, bank_account: null, notes: null,
  revision: 1, contact_count: 0, contacts: [], created_at: '', updated_at: '',
}

afterEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('高频操作直达', () => {
  it('公司与项目表单干净时直接关闭，填写后才确认放弃', async () => {
    const companyFetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === '/api/companies') return response([])
      throw new Error(`unexpected ${String(input)}`)
    })
    vi.stubGlobal('fetch', companyFetch)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const companyWrapper = mount(CompanyCenter, {
      attachTo: document.body,
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await companyWrapper.get('[data-testid="company-create-open"]').trigger('click')
    await companyWrapper.get('[data-testid="company-cancel"]').trigger('click')
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(companyWrapper.get('[data-testid="company-form-drawer"]').isVisible()).toBe(false)

    await companyWrapper.get('[data-testid="company-create-open"]').trigger('click')
    await companyWrapper.get('[data-testid="company-name"]').setValue('尚未保存的公司')
    await companyWrapper.get('[data-testid="company-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(companyWrapper.get('[data-testid="company-form-drawer"]').isVisible()).toBe(false)
    companyWrapper.unmount()

    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      if (String(input) === '/api/companies') return response([{ ...company, contacts: undefined }])
      if (String(input) === '/api/projects?status=active') return response([])
      throw new Error(`unexpected ${String(input)}`)
    }))
    const projectWrapper = mount(ProjectCenter, {
      attachTo: document.body,
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await projectWrapper.get('[data-testid="project-create-open"]').trigger('click')
    await projectWrapper.get('[data-testid="project-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(projectWrapper.get('[data-testid="project-form-dialog"]').isVisible()).toBe(false)

    await projectWrapper.get('[data-testid="project-create-open"]').trigger('click')
    await projectWrapper.get('[data-testid="project-name"]').setValue('尚未保存的项目')
    await projectWrapper.get('[data-testid="project-cancel"]').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(projectWrapper.get('[data-testid="project-form-dialog"]').isVisible()).toBe(false)
  })

  it('新建公司成功后直接打开该公司详情，可继续新增联系人', async () => {
    let companyReads = 0
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/companies' && (init?.method ?? 'GET') === 'GET') {
        companyReads += 1
        return response(companyReads === 1 ? [] : [{ ...company, contacts: undefined }])
      }
      if (path === '/api/companies' && init?.method === 'POST') return response(company, 201)
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(CompanyCenter, { attachTo: document.body, global: { plugins: [ElementPlus] } })
    await settle()

    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue(company.name)
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="company-detail-drawer"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain(company.name)
    expect(wrapper.get('[data-testid="contact-create-open"]').isVisible()).toBe(true)
  })

  it('新建项目成功后直接进入新项目，不要求回列表再查找', async () => {
    const project = {
      id: 9, project_code: 'SY-NEW', company_id: 1, company_name: company.name,
      name: '新项目', description: null, status: 'active', closure_type: null,
      archive_reason: null, archived_at: null, revision: 1, created_at: '', updated_at: '',
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path === '/api/companies') return response([{ ...company, contacts: undefined }])
      if (path === '/api/projects?status=active') return response([])
      if (path === '/api/projects' && init?.method === 'POST') return response(project, 201)
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ProjectCenter, { attachTo: document.body, global: { plugins: [ElementPlus] } })
    await settle()

    await wrapper.get('[data-testid="project-create-open"]').trigger('click')
    await wrapper.get('[data-testid="project-code"]').setValue(project.project_code)
    await wrapper.get('[data-testid="project-name"]').setValue(project.name)
    await wrapper.get('[data-testid="project-company"]').trigger('click')
    await settle()
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'))
      .find((item) => item.textContent?.includes(company.name))
    expect(option).toBeDefined()
    option?.click()
    await wrapper.get('[data-testid="project-save"]').trigger('click')
    await settle()

    expect(wrapper.emitted('open-dashboard')).toEqual([[project.project_code]])
  })

  it('首页经营待办带项目时显示明确的进入项目按钮', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response({
      generated_at: '2026-09-04T00:00:00+08:00',
      summary: {
        active_project_count: 1, overdue_receivable_count: 1, upcoming_delivery_count: 0,
        contracted_amount_cents: 10000, received_amount_cents: 0, outstanding_receivable_cents: 10000,
      },
      projects: [],
      todos: [{
        code: 'final_payment_overdue', severity: 'danger', project_code: 'SY-001',
        due_on: '2026-09-01', title: '尾款逾期', description: '尚未收齐尾款',
      }],
      backup: { healthy: true, last_success_at: null, message: null },
    })))
    const wrapper = mount(PortfolioOperatingOverview, {
      attachTo: document.body,
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="todo-open-project-SY-001-final_payment_overdue"]').trigger('click')
    expect(wrapper.emitted('open-project')).toEqual([['SY-001']])
  })

  it('验收页直接展示尾款收款摘要并可进入登记到账', async () => {
    const repository = Object.assign(new MockWorkforceRepository(), {
      getDeliverySummary: vi.fn(async () => ({
        source: 'demo' as const,
        data: {
          project_code: 'SY-001',
          final_payment: {
            due_on: '2026-09-30', planned_amount_cents: 500000,
            received_amount_cents: 300000, outstanding_amount_cents: 200000,
          },
        },
      })),
    }) as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-001', scope: 'delivery', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    expect(wrapper.get('[data-testid="delivery-final-payment-summary"]').text()).toContain('¥2,000.00')
    await wrapper.get('[data-testid="delivery-open-final-payment"]').trigger('click')
    expect(wrapper.emitted('open-commercial')).toHaveLength(1)
  })
})
