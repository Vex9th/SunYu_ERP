import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CompanyCenter from '../components/CompanyCenter.vue'
import ProjectCenter from '../components/ProjectCenter.vue'
import ProjectDashboard from '../components/ProjectDashboard.vue'
import ProjectCommercialPanel from '../components/project/ProjectCommercialPanel.vue'
import ProjectOverviewPanel from '../components/project/ProjectOverviewPanel.vue'
import { MockProjectRepository } from '../repositories/project.mock'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

const company = {
  id: 1,
  name: '苏州出发科技',
  taxpayer_id: '91320000TEST',
  registered_address: '苏州市工业园区',
  registered_phone: '0512-88886666',
  bank_name: '建设银行苏州分行',
  bank_account: '622200001234',
  notes: '年度框架客户',
  created_at: '2026-08-28T01:00:00+00:00',
  updated_at: '2026-08-28T01:00:00+00:00',
}

const contact = {
  id: 11,
  company_id: 1,
  name: '王工',
  phone: '13800138000',
  email: 'wang@example.com',
  position: '项目经理',
  notes: null,
  created_at: '2026-08-28T01:10:00+00:00',
  updated_at: '2026-08-28T01:10:00+00:00',
}

const project = {
  id: 21,
  project_code: 'SY-2026-001',
  company_id: 1,
  name: '装配线改造',
  description: '自动化装配线',
  status: 'active',
  archive_reason: null,
  archived_at: null,
  created_at: '2026-08-28T02:00:00+00:00',
  updated_at: '2026-08-28T02:00:00+00:00',
  company_name: company.name,
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountComponent(component: object, props: Record<string, unknown> = {}): VueWrapper {
  return mount(component, {
    attachTo: document.body,
    props,
    global: { plugins: [ElementPlus] },
  })
}

describe('CompanyCenter', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('完整展示载入、错误、重试和空状态', async () => {
    let rejectLoad!: (reason: Error) => void
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((_, reject) => { rejectLoad = reject }))
      .mockResolvedValueOnce(jsonResponse([]))

    const wrapper = mountComponent(CompanyCenter)
    expect(wrapper.get('[data-testid="companies-loading"]').text()).toContain('正在读取')

    rejectLoad(new Error('断网'))
    await settle()
    expect(wrapper.get('[data-testid="companies-error"]').text()).toContain('无法连接本地服务')

    await wrapper.get('[data-testid="companies-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="companies-empty"]').text()).toContain('暂无客户')
  })

  it('新增与编辑公司始终提交精确字段并修剪空值', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ ...company, contact_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse({ ...company, id: 2, name: '昆山新客户', taxpayer_id: null }))
      .mockResolvedValueOnce(jsonResponse([
        { ...company, contact_count: 0 },
        { ...company, id: 2, name: '昆山新客户', taxpayer_id: null, contact_count: 0 },
      ]))
      .mockResolvedValueOnce(jsonResponse({ ...company, name: '苏州出发科技更新', contacts: [] }))
      .mockResolvedValueOnce(jsonResponse([{ ...company, name: '苏州出发科技更新', contact_count: 0 }]))

    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('  昆山新客户  ')
    await wrapper.get('[data-testid="company-taxpayer-id"]').setValue('   ')
    await wrapper.get('[data-testid="company-phone"]').setValue(' 0512-12345678 ')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/companies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '昆山新客户',
          taxpayer_id: null,
          registered_address: null,
          registered_phone: '0512-12345678',
          bank_name: null,
          bank_account: null,
          notes: null,
        }),
      }),
    ])

    await wrapper.get('[data-testid="company-edit-1"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue(' 苏州出发科技更新 ')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/companies/1')
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: 'PUT' }))
  })

  it('删除公司需确认，409 时保留列表和可读错误', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ ...company, contact_count: 2 }]))
      .mockResolvedValueOnce(jsonResponse({ detail: '公司已被项目使用' }, 409))

    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-delete-1"]').trigger('click')
    expect(wrapper.get('[data-testid="company-delete-dialog"]').text()).toContain('苏州出发科技')
    await wrapper.get('[data-testid="company-delete-confirm"]').trigger('click')
    await settle()

    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/companies/1',
      expect.objectContaining({ method: 'DELETE' }),
    ])
    expect(wrapper.text()).toContain('公司已被项目使用')
    expect(wrapper.text()).toContain('苏州出发科技')
  })

  it('详情中允许两个同名联系人并支持新增、编辑和删除', async () => {
    const secondContact = { ...contact, id: 12 }
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies' && method === 'GET') {
        return jsonResponse([{ ...company, contact_count: 2 }])
      }
      if (url === '/api/companies/1' && method === 'GET') {
        return jsonResponse({ ...company, contacts: [contact, secondContact] })
      }
      if (url === '/api/companies/1/contacts' && method === 'POST') {
        return jsonResponse({ ...contact, id: 13 }, 201)
      }
      if (url === '/api/companies/1/contacts/11' && method === 'PUT') {
        return jsonResponse({ ...contact, position: '甲方负责人' })
      }
      if (url === '/api/companies/1/contacts/12' && method === 'DELETE') {
        return emptyResponse()
      }
      throw new Error(`unexpected ${method} ${url}`)
    })

    const wrapper = mountComponent(CompanyCenter)
    await settle()
    expect(wrapper.find('.company-mobile-list').exists()).toBe(true)
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain('年度框架客户')
    expect(wrapper.findAll('[data-testid^="contact-edit-"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="contact-phone-value-11"]').classes()).toContain('contact-phone-value')
    expect(wrapper.get('[data-testid="company-detail-drawer"]').attributes('style')).toContain('min(100vw, 760px)')
    expect(wrapper.get('[data-testid="company-detail-content"]').classes()).toContain('company-detail-content')
    expect(wrapper.get('[data-testid="company-contact-table"]').classes()).toContain('company-contact-table')
    expect(wrapper.find('.contact-mobile-list').text()).toContain('13800138000')
    expect(wrapper.get('[data-testid="contact-edit-11"]').element.closest('td')?.classList).not.toContain('el-table-fixed-column--right')
    expect(wrapper.find('.company-contact-table-scroll').exists()).toBe(true)

    await wrapper.get('[data-testid="contact-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contact-name"]').setValue(' 王工 ')
    await wrapper.get('[data-testid="contact-phone"]').setValue('   ')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/companies/1/contacts' && init?.method === 'POST')
    expect(createCall?.[1]?.body).toBe(JSON.stringify({
      name: '王工', phone: null, email: null, position: null, notes: null,
    }))

    await wrapper.get('[data-testid="contact-edit-11"]').trigger('click')
    await wrapper.get('[data-testid="contact-position"]').setValue(' 甲方负责人 ')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    expect(fetchMock.mock.calls.some(([url, init]) =>
      url === '/api/companies/1/contacts/11' && init?.method === 'PUT')).toBe(true)

    await wrapper.get('[data-testid="contact-delete-12"]').trigger('click')
    await wrapper.get('[data-testid="contact-delete-confirm"]').trigger('click')
    await settle()
    expect(fetchMock.mock.calls.some(([url, init]) =>
      url === '/api/companies/1/contacts/12' && init?.method === 'DELETE')).toBe(true)
  })

  it('业务请求 401 时上报会话过期', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: '会话已过期' }, 401))
    const wrapper = mountComponent(CompanyCenter)
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['会话已过期']])
  })

  it('公司详情首次读取失败后可原地重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ ...company, contact_count: 0 }]))
      .mockResolvedValueOnce(jsonResponse({ detail: '详情服务暂时不可用' }, 503))
      .mockResolvedValueOnce(jsonResponse({ ...company, contacts: [] }))

    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-detail-error"]').text()).toContain('详情服务暂时不可用')

    await wrapper.get('[data-testid="company-detail-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain('苏州出发科技')
  })

  it('关闭 A 详情后快速打开 B，A 迟到结果不得覆盖 B', async () => {
    let resolveA!: (response: Response) => void
    const companyB = { ...company, id: 2, name: '昆山 B 公司' }
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/companies') {
        return jsonResponse([
          { ...company, contact_count: 0 },
          { ...companyB, contact_count: 0 },
        ])
      }
      if (url === '/api/companies/1') {
        return new Promise<Response>((resolve) => { resolveA = resolve })
      }
      if (url === '/api/companies/2') {
        return jsonResponse({ ...companyB, contacts: [] })
      }
      throw new Error(`unexpected ${url}`)
    })

    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await wrapper.get('[data-testid="company-detail-drawer"] .el-drawer__close-btn').trigger('click')
    await wrapper.get('[data-testid="company-detail-2"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain('昆山 B 公司')

    resolveA(jsonResponse({ ...company, contacts: [] }))
    await settle()
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain('昆山 B 公司')
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).not.toContain('苏州出发科技')
  })

  it('旧公司详情请求迟到 401 仍必须上报会话过期', async () => {
    let resolveA!: (response: Response) => void
    const companyB = { ...company, id: 2, name: '昆山 B 公司' }
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/companies') return jsonResponse([{ ...company, contact_count: 0 }, { ...companyB, contact_count: 0 }])
      if (url === '/api/companies/1') return new Promise<Response>((resolve) => { resolveA = resolve })
      if (url === '/api/companies/2') return jsonResponse({ ...companyB, contacts: [] })
      throw new Error(`unexpected ${url}`)
    })
    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await wrapper.get('[data-testid="company-detail-2"]').trigger('click')
    await settle()
    resolveA(jsonResponse({ detail: '详情会话已过期' }, 401))
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['详情会话已过期']])
  })

  it('联系人操作失败后关闭重开不保留旧错误', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (url === '/api/companies/1' && method === 'GET') return jsonResponse({ ...company, contacts: [contact] })
      if (url === '/api/companies/1/contacts' && method === 'POST') {
        return jsonResponse({ detail: '联系人保存失败' }, 503)
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contact-name"]').setValue('新联系人')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="contact-action-error"]').text()).toContain('联系人保存失败')

    await wrapper.get('[data-testid="contact-dialog"] .el-dialog__headerbtn').trigger('click')
    await wrapper.get('[data-testid="contact-edit-11"]').trigger('click')
    expect(wrapper.find('[data-testid="contact-action-error"]').exists()).toBe(false)
  })

  it('初始公司 GET 未完成时新建成功，旧结果不得覆盖刷新列表', async () => {
    let resolveInitial!: (response: Response) => void
    let companyGets = 0
    const newCompany = { ...company, id: 2, name: '新建公司', contact_count: 0 }
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies' && method === 'GET') {
        companyGets += 1
        if (companyGets === 1) {
          return new Promise<Response>((resolve) => { resolveInitial = resolve })
        }
        return jsonResponse([newCompany])
      }
      if (url === '/api/companies' && method === 'POST') {
        return jsonResponse({ ...newCompany, contacts: [] }, 201)
      }
      throw new Error(`unexpected ${method} ${url}`)
    })

    const wrapper = mountComponent(CompanyCenter)
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('新建公司')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()
    expect(companyGets).toBe(2)
    expect(wrapper.text()).toContain('新建公司')

    resolveInitial(jsonResponse([]))
    await settle()
    expect(wrapper.text()).toContain('新建公司')
    expect(wrapper.find('[data-testid="companies-empty"]').exists()).toBe(false)
  })

  it('旧代公司列表迟到 401 仍上报会话过期', async () => {
    let resolveInitial!: (response: Response) => void
    let companyGets = 0
    const newCompany = { ...company, id: 2, name: '新建公司', contact_count: 0 }
    fetchMock.mockImplementation(async (input, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') {
        companyGets += 1
        if (companyGets === 1) return new Promise<Response>((resolve) => { resolveInitial = resolve })
        return jsonResponse([newCompany])
      }
      return jsonResponse({ ...newCompany, contacts: [] }, 201)
    })
    const wrapper = mountComponent(CompanyCenter)
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('新建公司')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    resolveInitial(jsonResponse({ detail: '旧列表会话已过期' }, 401))
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['旧列表会话已过期']])
    expect(wrapper.text()).toContain('新建公司')
  })

  it('公司保存迟到时不得关闭或污染后来打开的公司表单', async () => {
    let resolveSave!: (response: Response) => void
    const companyB = { ...company, id: 2, name: '昆山 B 公司', contact_count: 0 }
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies' && method === 'GET') {
        return jsonResponse([{ ...company, contact_count: 0 }, companyB])
      }
      if (url === '/api/companies/1' && method === 'PUT') {
        return new Promise<Response>((resolve) => { resolveSave = resolve })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-edit-1"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('A 公司已修改')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    expect(wrapper.find('[data-testid="company-form-drawer"] .el-drawer__close-btn').exists()).toBe(false)

    wrapper.findAllComponents({ name: 'ElDrawer' })[0]?.vm.$emit('update:modelValue', false)
    await wrapper.get('[data-testid="company-edit-2"]').trigger('click')
    await settle()
    expect((wrapper.get('[data-testid="company-name"]').element as HTMLInputElement).value).toBe('昆山 B 公司')

    resolveSave(jsonResponse({ ...company, name: 'A 公司已修改', contacts: [] }))
    await settle()
    expect(wrapper.get('[data-testid="company-form-drawer"]').isVisible()).toBe(true)
    expect((wrapper.get('[data-testid="company-name"]').element as HTMLInputElement).value).toBe('昆山 B 公司')
  })

  it('公司与联系人弹层使用窄屏安全宽度', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ...company, contact_count: 0 }]))
    const wrapper = mountComponent(CompanyCenter)
    await settle()
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="company-form-drawer"]').attributes('style')).toContain('min(92vw, 520px)')
  })
})

describe('ProjectCenter', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('默认并行读取在建项目和公司，并支持三种筛选', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/companies') return jsonResponse([{ ...company, contact_count: 1 }])
      if (url.includes('status=active')) return jsonResponse([project])
      if (url.includes('status=archived')) return jsonResponse([{ ...project, status: 'archived' }])
      if (url.includes('status=all')) return jsonResponse([project, { ...project, id: 22, status: 'archived' }])
      throw new Error(`unexpected ${url}`)
    })

    const wrapper = mountComponent(ProjectCenter)
    await settle()
    expect(fetchMock.mock.calls.slice(0, 2).map(([url]) => url)).toEqual(expect.arrayContaining([
      '/api/projects?status=active', '/api/companies',
    ]))
    expect(wrapper.text()).toContain('在建')
    expect(wrapper.find('[data-testid="project-list-stack"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="project-company-cell-21"]').text()).toContain(company.name)
    expect(wrapper.get('[data-testid="project-mobile-card-21"]').text()).toContain('SY-2026-001')
    expect(wrapper.get('[data-testid="project-mobile-card-21"]').text()).toContain(company.name)
    expect(wrapper.get('[data-testid="project-mobile-open-SY-2026-001"]').text()).toContain('进入项目')

    await wrapper.get('[data-testid="project-filter"] input[value="archived"]').setValue(true)
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/projects?status=archived')).toBe(true)
    expect(wrapper.text()).toContain('已归档')

    await wrapper.get('[data-testid="project-filter"] input[value="all"]').setValue(true)
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/projects?status=all')).toBe(true)
  })

  it('新建项目提交精确字段，归档后刷新并可进入独立仪表台', async () => {
    let archiveResolve!: (response: Response) => void
    let archived = false
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies') return jsonResponse([{ ...company, contact_count: 0 }])
      if (url === '/api/projects?status=active') return jsonResponse(archived ? [] : [project])
      if (url === '/api/projects' && method === 'POST') return jsonResponse(project, 201)
      if (url === '/api/projects/SY-2026-001/archive' && method === 'POST') {
        return new Promise<Response>((resolve) => {
          archiveResolve = (response) => {
            archived = true
            resolve(response)
          }
        })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })

    const wrapper = mountComponent(ProjectCenter)
    await settle()
    await wrapper.get('[data-testid="project-create-open"]').trigger('click')
    await wrapper.get('[data-testid="project-code"]').setValue(' SY-2026-002 ')
    await wrapper.get('[data-testid="project-name"]').setValue(' 新项目 ')
    await wrapper.get('[data-testid="project-company"]').trigger('click')
    await settle()
    const companyOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'),
    ).find((item) => item.textContent?.includes(company.name))
    expect(companyOption).toBeDefined()
    companyOption?.click()
    await settle()
    await wrapper.get('[data-testid="project-description"]').setValue('   ')
    await wrapper.get('[data-testid="project-save"]').trigger('click')
    await settle()
    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/projects' && init?.method === 'POST')
    expect(createCall?.[1]?.body).toBe(JSON.stringify({
      project_code: 'SY-2026-002', company_id: 1, name: '新项目', description: null,
    }))

    expect(wrapper.get('[data-testid="project-dashboard-SY-2026-001"]').text()).toBe('装配线改造')
    await wrapper.get('[data-testid="project-dashboard-SY-2026-001"]').trigger('click')
    expect(wrapper.emitted('open-dashboard')).toEqual([['SY-2026-001']])

    await wrapper.get('[data-testid="project-archive-SY-2026-001"]').trigger('click')
    await wrapper.get('[data-testid="archive-reason"]').setValue('   ')
    const confirm = wrapper.get('[data-testid="archive-confirm"]')
    await confirm.trigger('click')
    await confirm.trigger('click')
    expect(fetchMock.mock.calls.filter(([url]) =>
      url === '/api/projects/SY-2026-001/archive')).toHaveLength(1)
    expect(confirm.attributes('disabled')).toBeDefined()
    archiveResolve(jsonResponse({ ...project, status: 'archived' }))
    await settle()
    expect(fetchMock.mock.calls.filter(([url]) =>
      url === '/api/projects?status=active')).toHaveLength(3)
    expect(wrapper.find('[data-testid="project-dashboard-SY-2026-001"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="projects-empty"]').text()).toContain('暂无在建项目')
  })

  it('列表错误保留在页面，401 则上报会话过期', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/companies') return jsonResponse([])
      return jsonResponse({ detail: '项目服务暂时不可用' }, 503)
    })
    const wrapper = mountComponent(ProjectCenter)
    await settle()
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain('项目服务暂时不可用')
    expect(wrapper.emitted('session-expired')).toBeUndefined()

    fetchMock.mockImplementation(async () =>
      jsonResponse({ detail: '请重新登录' }, 401))
    await wrapper.get('[data-testid="projects-retry"]').trigger('click')
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['请重新登录']])
  })

  it('初始并行请求先返回 500 后迟到 401 仍上报会话过期', async () => {
    let resolveCompany!: (response: Response) => void
    fetchMock.mockImplementation(async (input) => {
      if (String(input).startsWith('/api/projects')) {
        return jsonResponse({ detail: '项目列表暂时失败' }, 500)
      }
      return new Promise<Response>((resolve) => { resolveCompany = resolve })
    })
    const wrapper = mountComponent(ProjectCenter)
    await settle()
    expect(wrapper.get('[data-testid="projects-loading"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="projects-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="projects-retry"]').exists()).toBe(false)

    resolveCompany(jsonResponse({ detail: '迟到的会话过期' }, 401))
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['迟到的会话过期']])
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain('项目列表暂时失败')
    expect(wrapper.get('[data-testid="projects-retry"]').isVisible()).toBe(true)
  })

  it('旧代整轮结束后重试原子提交新项目和公司', async () => {
    let resolveOldCompany!: (response: Response) => void
    let projectCalls = 0
    let companyCalls = 0
    const newCompany = { ...company, id: 2, name: '新公司', contact_count: 0 }
    const newProject = { ...project, id: 22, project_code: 'SY-NEW', company_id: 2, company_name: '新公司' }
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('/api/projects')) {
        projectCalls += 1
        return projectCalls === 1
          ? jsonResponse({ detail: '旧代项目失败' }, 500)
          : jsonResponse([newProject])
      }
      companyCalls += 1
      if (companyCalls === 1) {
        return new Promise<Response>((resolve) => { resolveOldCompany = resolve })
      }
      return jsonResponse([newCompany])
    })

    const wrapper = mountComponent(ProjectCenter)
    await settle()
    expect(wrapper.get('[data-testid="projects-loading"]').isVisible()).toBe(true)
    resolveOldCompany(jsonResponse([{ ...company, contact_count: 0 }]))
    await settle()
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain('旧代项目失败')

    await wrapper.get('[data-testid="projects-retry"]').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('SY-NEW')
    expect(wrapper.text()).toContain('新公司')
    expect(wrapper.text()).not.toContain('旧代项目失败')
  })

  it('新建项目迟到成功不得关闭后来重新打开的表单', async () => {
    let resolveCreate!: (response: Response) => void
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/companies') return jsonResponse([{ ...company, contact_count: 0 }])
      if (url === '/api/projects?status=active') return jsonResponse([])
      if (url === '/api/projects' && method === 'POST') {
        return new Promise<Response>((resolve) => { resolveCreate = resolve })
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const wrapper = mountComponent(ProjectCenter)
    await settle()
    await wrapper.get('[data-testid="project-create-open"]').trigger('click')
    await wrapper.get('[data-testid="project-code"]').setValue('SY-LATE')
    await wrapper.get('[data-testid="project-name"]').setValue('迟到项目')
    await wrapper.get('[data-testid="project-company"]').trigger('click')
    await settle()
    const option = document.body.querySelector<HTMLElement>('.el-select-dropdown__item')
    option?.click()
    await wrapper.get('[data-testid="project-save"]').trigger('click')
    expect(wrapper.find('[data-testid="project-form-dialog"] .el-dialog__headerbtn').exists()).toBe(false)

    wrapper.findAllComponents({ name: 'ElDialog' })[0]?.vm.$emit('update:modelValue', false)
    await wrapper.get('[data-testid="project-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="project-code"]').element as HTMLInputElement).value).toBe('')

    resolveCreate(jsonResponse({ ...project, project_code: 'SY-LATE', name: '迟到项目' }, 201))
    await settle()
    expect(wrapper.get('[data-testid="project-form-dialog"]').isVisible()).toBe(true)
    expect((wrapper.get('[data-testid="project-code"]').element as HTMLInputElement).value).toBe('')
  })

  it('项目弹层使用窄屏安全宽度', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/api/companies' ? jsonResponse([]) : jsonResponse([]))
    const wrapper = mountComponent(ProjectCenter)
    await settle()
    await wrapper.get('[data-testid="project-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="project-form-dialog"]').attributes('style')).toContain('min(92vw, 560px)')
  })
})

describe('ProjectDashboard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('成本完整度使用冻结状态，未接通时不标成完整', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    snapshot.costs = {
      material_consumed_cents: null,
      labor_cents: null,
      field_material_cents: null,
      total_cents: null,
      procurement_committed_cents: null,
      procurement_received_cents: null,
      procurement_paid_cents: null,
      completeness: 'unavailable',
    }
    snapshot.profit.actual_cost_cents = null
    snapshot.profit.actual_profit_cents = null
    snapshot.profit.margin_basis_points = null

    const wrapper = mountComponent(ProjectOverviewPanel, { operating: snapshot })

    expect(wrapper.get('[data-testid="project-cost-completeness"]').text()).toContain('成本尚未接通')
    expect(wrapper.get('[data-testid="project-demo-finance"]').text()).toContain('--')
    expect(wrapper.text()).not.toContain('成本口径完整')
  })

  it('项目首页默认只显示阶段摘要，打开后可维护完整流程', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    const wrapper = mountComponent(ProjectOverviewPanel, { operating: snapshot, projectCode: 'SY-2026-001' })

    const summary = wrapper.get('[data-testid="project-stage-summary"]')
    expect(summary.text()).toContain('当前阶段')
    expect(summary.text()).toContain('机械设计')
    expect(summary.text()).toContain('整体进度')
    expect(summary.text()).toContain('6 / 18')
    expect(summary.text()).toContain('下一步')
    expect(summary.text()).toContain('电气设计')
    expect(summary.text()).toContain('待办 2')
    expect(wrapper.find('[data-testid="project-stages"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('编辑排期')
    expect(wrapper.text()).not.toContain('变更状态')

    await wrapper.get('[data-testid="project-stage-flow-open"]').trigger('click')
    expect(wrapper.get('[data-testid="project-stages"]').isVisible()).toBe(true)
    expect(wrapper.findAll('[data-testid^="stage-row-"]')).toHaveLength(18)
    expect(wrapper.text()).toContain('编辑排期')
    expect(wrapper.text()).toContain('变更状态')
  })

  it('所有阶段已完成或跳过时，当前阶段和下一步都明确表示流程完成', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    snapshot.stages = snapshot.stages.map((stage, index) => ({
      ...stage,
      status: index === snapshot.stages.length - 1 ? 'skipped' : 'completed',
    }))

    const wrapper = mountComponent(ProjectOverviewPanel, { operating: snapshot })
    const summary = wrapper.get('[data-testid="project-stage-summary"]')

    expect(summary.get('[data-testid="project-current-stage"]').text()).toContain('已完成全部流程')
    expect(summary.get('[data-testid="project-next-stage"]').text()).toContain('已完成全部流程')
  })

  it('阶段数组为空时，当前阶段和下一步都显示暂无数据', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    snapshot.stages = []

    const wrapper = mountComponent(ProjectOverviewPanel, { operating: snapshot })
    const summary = wrapper.get('[data-testid="project-stage-summary"]')

    expect(summary.get('[data-testid="project-current-stage"]').text()).toContain('暂无阶段数据')
    expect(summary.get('[data-testid="project-next-stage"]').text()).toContain('暂无阶段数据')
  })

  it('末尾阶段阻塞且无后继时，不得误报全部完成', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    snapshot.stages = snapshot.stages.map((stage, index) => ({
      ...stage,
      status: index === snapshot.stages.length - 1 ? 'blocked' : 'completed',
    }))

    const wrapper = mountComponent(ProjectOverviewPanel, { operating: snapshot })
    const summary = wrapper.get('[data-testid="project-stage-summary"]')

    expect(summary.get('[data-testid="project-current-stage"]').text()).toContain('收尾')
    expect(summary.get('[data-testid="project-next-stage"]').text()).toContain('等待解除阻塞')
    expect(summary.text()).not.toContain('已完成全部流程')
  })

  it('共享合同只汇总当前项目分摊，不带入其他项目收入', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    snapshot.commercial.contracts[0]?.allocations.push({
      id: 32,
      contract_id: 21,
      project_code: 'SY-2026-OTHER',
      amount_cents: 50000000,
    })

    const wrapper = mountComponent(ProjectCommercialPanel, {
      operating: snapshot,
      projectCode: 'SY-2026-001',
      customerCompany: { id: 1, name: '演示客户单位' },
    })
    await settle()

    expect(wrapper.text()).toContain('¥2,680,000.00')
    expect(wrapper.text()).not.toContain('¥3,180,000.00')
  })

  it('生产环境保留六个项目直达页并区分真实基础资料与演示经营数据', async () => {
    vi.stubEnv('DEV', false)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      company,
      contacts: [contact],
      documents: { document_count: 0, version_count: 0, categories: [] },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountComponent(ProjectDashboard, { projectCode: project.project_code })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-live-notice"]').exists()).toBe(true)
    })

    expect(wrapper.get('[data-testid="project-demo-notice"]').text()).toContain('演示数据')
    expect(wrapper.findAll('[data-testid^="project-nav-"]').map((item) => item.text())).toEqual([
      '项目首页', '资料与设计', '报价与收款', '采购', '施工与调试', '验收与售后',
    ])
    expect(wrapper.get('[data-testid="project-panel-overview"]').isVisible()).toBe(true)
    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-records-panel"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="project-records-panel"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="project-records-panel"]').text()).not.toContain('项目文档统计')
    expect(wrapper.get('[data-testid="project-nav-documents"]').text()).toBe('资料与设计')
    expect(wrapper.find('.project-section-collapse').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('项目工作页可编辑基本资料并按完成或取消正常完结', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      company,
      contacts: [contact],
      documents: { document_count: 0, version_count: 0, categories: [] },
    })))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: project.project_code })
    await vi.waitFor(() => expect(wrapper.find('[data-testid="project-edit-open"]').exists()).toBe(true))

    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    await wrapper.get('[data-testid="project-edit-name"]').setValue('装配线整体升级')
    await wrapper.get('[data-testid="project-edit-description"]').setValue('机械与电气同步改造')
    await wrapper.get('[data-testid="project-edit-save"]').trigger('click')
    await settle()
    expect(wrapper.get('.project-identity').text()).toContain('装配线整体升级')
    expect(wrapper.get('.project-identity').text()).toContain('机械与电气同步改造')

    await wrapper.get('[data-testid="project-close-open"]').trigger('click')
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收并完成收尾')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
    expect(wrapper.text()).toContain('项目已验收并完成收尾')
    expect(wrapper.text()).toContain('演示数据')
  })

  it('超长项目编号和金额保持完整渲染', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => {})))
    const longCode = `SY${'LONGCODE'.repeat(16)}`
    const dashboard = mountComponent(ProjectDashboard, { projectCode: longCode })

    const snapshot = (await new MockProjectRepository().getOperatingSnapshot(longCode)).data
    snapshot.profit.actual_profit_cents = 9_000_000_000_000_000
    const overview = mountComponent(ProjectOverviewPanel, { operating: snapshot })

    expect(dashboard.get('.project-identity .el-text').text()).toContain(longCode)
    expect(overview.findAll('.metric-value strong')[3]?.text()).toContain('90,000,000,000,000.00')
  })

  it('项目工作区以六个直达页承载真实资料和开发预览，且不使用折叠区', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      company,
      contacts: [contact],
      documents: {
        document_count: 2,
        version_count: 5,
        categories: [{ category: 'planning_notes', document_count: 2, version_count: 5 }],
      },
      stored_relative_path: 'Projects/secret',
      original_filename: 'secret.pdf',
      hash: 'never-show',
      session_secret: 'never-show',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: project.project_code })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-live-notice"]').exists()).toBe(true)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/SY-2026-001/dashboard',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="project-live-notice"]').text()).toContain('真实后端')
    expect(wrapper.get('[data-testid="project-demo-notice"]').text()).toContain('演示数据')
    expect(wrapper.findAll('[data-testid^="project-nav-"]').map((item) => item.text())).toEqual([
      '项目首页', '资料与设计', '报价与收款', '采购', '施工与调试', '验收与售后',
    ])
    expect(wrapper.find('.project-section-collapse').exists()).toBe(false)
    expect(wrapper.text()).toContain('装配线改造')
    expect(wrapper.text()).not.toContain('Projects/secret')
    expect(wrapper.text()).not.toContain('secret.pdf')
    expect(wrapper.text()).not.toContain('never-show')
    expect(wrapper.get('[data-testid="project-demo-finance"]').text()).toContain('合同分摊额')
    expect(wrapper.get('[data-testid="project-demo-finance"]').text()).toContain('实际成本')
    expect(wrapper.get('[data-testid="project-demo-finance"]').text()).toContain('实际利润')
    expect(wrapper.get('[data-testid="project-demo-costs"]').text()).toContain('已领用库存成本')
    expect(wrapper.get('[data-testid="project-demo-costs"]').text()).toContain('采购承诺（不计利润）')
    expect(wrapper.get('[data-testid="project-demo-todos"]').text()).toContain('严重 · 2026-09-02')
    expect(wrapper.get('[data-testid="project-demo-todos"]').text()).toContain('警告 · 2026-11-30')
    expect(wrapper.find('[data-testid="project-stages"]').exists()).toBe(false)

    await wrapper.get('[data-testid="project-nav-workforce"]').trigger('click')
    expect(wrapper.get('[data-testid="project-panel-overview"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="project-stages"]').exists()).toBe(false)

    await wrapper.get('[data-testid="project-nav-procurement"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="procurement-workspace"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="procurement-workspace"]').isVisible()).toBe(true)

    await wrapper.get('[data-testid="project-nav-workforce"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="workforce-center"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="workforce-center"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="field-workspace-nav"]').text()).toContain('今日施工')
    expect(wrapper.get('[data-testid="field-workspace-nav"]').text()).toContain('调试与变更')
    await wrapper.get('[data-testid="field-workspace-commissioning"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="delivery-commissioning-panel"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="delivery-commissioning-panel"]').isVisible()).toBe(true)

    await wrapper.get('[data-testid="project-nav-delivery"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="delivery-workspace"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="delivery-workspace"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="delivery-tab-commissioning"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="delivery-commissioning-panel"]').isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="delivery-tab-acceptance"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="delivery-acceptance-panel"]').isVisible()).toBe(true)

    await wrapper.get('[data-testid="project-nav-commercial"]').trigger('click')
    expect(wrapper.get('[data-testid="project-demo-commercial"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="project-demo-commercial"]').text()).toContain('SYHT-2026-018')
    expect(wrapper.get('[data-testid="project-demo-receivables"]').text()).toContain('预付款')

    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    expect(wrapper.get('[data-testid="project-records-panel"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="project-records-panel"]').text()).toContain('王工')
    expect(wrapper.get('[data-testid="project-records-panel"]').text()).not.toContain('项目文档统计')

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-documents-panel"]').exists()).toBe(true)
    })
    expect(wrapper.get('[data-testid="project-documents-panel"]').isVisible()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('展示联系人和文档空态，项目编号变更时重新读取', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      project,
      company,
      contacts: [],
      documents: { document_count: 0, version_count: 0, categories: [] },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()
    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    expect(wrapper.get('[data-testid="contacts-empty"]').text()).toContain('暂无联系人')
    expect(wrapper.find('[data-testid="documents-empty"]').exists()).toBe(false)

    await wrapper.setProps({ projectCode: '测 试/002' })
    await settle()
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).toBe(
      '/api/projects/%E6%B5%8B%20%E8%AF%95%2F002/dashboard',
    )
    await wrapper.get('[data-testid="project-dashboard-back"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })

  it('切换项目时立即清理旧项目预览和演示操作弹窗', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        project,
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...project, project_code: 'SY-B', name: 'B 项目' },
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: project.project_code })
    await vi.waitFor(() => expect(wrapper.text()).toContain('装配线改造'))

    expect(wrapper.get('[data-testid="project-edit-open"]').text()).toContain('演示')
    expect(wrapper.get('[data-testid="project-close-open"]').text()).toContain('演示')
    await wrapper.get('[data-testid="project-edit-open"]').trigger('click')
    expect(wrapper.get('[aria-label="编辑项目 · 演示"]').isVisible()).toBe(true)

    await wrapper.setProps({ projectCode: 'SY-B' })
    expect(wrapper.get('.project-identity h1').text()).toBe('SY-B')
    expect(wrapper.get('[aria-label="编辑项目 · 演示"]').isVisible()).toBe(false)
    await vi.waitFor(() => expect(wrapper.get('.project-identity h1').text()).toBe('B 项目'))
  })

  it('连续切换项目时重新挂载文档预览并读取 B 项目台账', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        project,
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
      }))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...project, project_code: 'SY-B', name: 'B 项目' },
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: project.project_code })

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-nav-documents"]').exists()).toBe(true)
    })
    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="project-documents-panel"]').exists()).toBe(true)
    })
    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('仅属于 A 的文档')
    const createFile = wrapper.get('[data-testid="document-create-file"]')
    Object.defineProperty(createFile.element, 'files', {
      configurable: true,
      value: [new File(['demo'], 'only-a.pdf', { type: 'application/pdf' })],
    })
    await createFile.trigger('change')
    await wrapper.get('[data-testid="document-create-save"]').trigger('click')
    expect(wrapper.text()).toContain('仅属于 A 的文档')

    await wrapper.setProps({ projectCode: 'SY-B' })
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('B 项目')
    })
    await wrapper.get('[data-testid="project-nav-documents"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.get('[data-testid="project-documents-panel"]').text()).toContain('现场测绘记录')
    })

    expect(wrapper.text()).not.toContain('仅属于 A 的文档')
    expect(wrapper.get('[data-testid="project-documents-panel"]').text()).toContain('现场测绘记录')
  })

  it('仪表台 401 上报会话过期', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ detail: '会话失效' }, 401),
    ))
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['会话失效']])
  })

  it('项目编号连续切换时忽略旧请求的迟到结果', async () => {
    let resolveFirst!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...project, project_code: 'SY-2026-002', name: '第二个项目' },
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-2026-001' })

    await wrapper.setProps({ projectCode: 'SY-2026-002' })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('第二个项目')

    resolveFirst(jsonResponse({
      project: { ...project, name: '迟到的旧项目' },
      company,
      contacts: [],
      documents: { document_count: 0, version_count: 0, categories: [] },
    }))
    await settle()
    expect(wrapper.text()).toContain('第二个项目')
    expect(wrapper.text()).not.toContain('迟到的旧项目')
  })

  it('切换到 B 后 A 请求迟到 401 仍上报会话过期', async () => {
    let resolveA!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveA = resolve }))
      .mockResolvedValueOnce(jsonResponse({
        project: { ...project, project_code: 'SY-B', name: 'B 项目' },
        company,
        contacts: [],
        documents: { document_count: 0, version_count: 0, categories: [] },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(ProjectDashboard, { projectCode: 'SY-A' })
    await wrapper.setProps({ projectCode: 'SY-B' })
    await settle()

    resolveA(jsonResponse({ detail: 'A 请求的会话已过期' }, 401))
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['A 请求的会话已过期']])
  })
})
