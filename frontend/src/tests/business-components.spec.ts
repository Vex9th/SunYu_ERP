import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CompanyCenter from '../components/CompanyCenter.vue'
import ProjectCenter from '../components/ProjectCenter.vue'
import ProjectDashboard from '../components/ProjectDashboard.vue'

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
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-detail-drawer"]').text()).toContain('年度框架客户')
    expect(wrapper.findAll('[data-testid^="contact-edit-"]')).toHaveLength(2)

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

    const filter = wrapper.getComponent({ name: 'ElRadioGroup' })
    filter.vm.$emit('update:modelValue', 'archived')
    filter.vm.$emit('change', 'archived')
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/projects?status=archived')).toBe(true)
    expect(wrapper.text()).toContain('已归档')

    filter.vm.$emit('update:modelValue', 'all')
    filter.vm.$emit('change', 'all')
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
    wrapper.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 1)
    await wrapper.get('[data-testid="project-description"]').setValue('   ')
    await wrapper.get('[data-testid="project-save"]').trigger('click')
    await settle()
    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      url === '/api/projects' && init?.method === 'POST')
    expect(createCall?.[1]?.body).toBe(JSON.stringify({
      project_code: 'SY-2026-002', company_id: 1, name: '新项目', description: null,
    }))

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
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain('项目列表暂时失败')

    resolveCompany(jsonResponse({ detail: '迟到的会话过期' }, 401))
    await settle()
    expect(wrapper.emitted('session-expired')).toEqual([['迟到的会话过期']])
  })

  it('重试新数据先到时，旧代迟到结果不得覆盖', async () => {
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
    await wrapper.get('[data-testid="projects-retry"]').trigger('click')
    await settle()
    expect(wrapper.text()).toContain('SY-NEW')
    expect(wrapper.text()).toContain('新公司')

    resolveOldCompany(jsonResponse([{ ...company, contact_count: 0 }]))
    await settle()
    expect(wrapper.text()).toContain('SY-NEW')
    expect(wrapper.text()).toContain('新公司')
    expect(wrapper.text()).not.toContain('旧代项目失败')
  })
})

describe('ProjectDashboard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('只展示真实项目资料、联系人和文档统计', async () => {
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
    await settle()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/SY-2026-001/dashboard',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    expect(wrapper.text()).toContain('当前展示已录入的项目基础资料与文档统计')
    expect(wrapper.text()).toContain('装配线改造')
    expect(wrapper.text()).toContain('王工')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('5')
    expect(wrapper.text()).not.toContain('Projects/secret')
    expect(wrapper.text()).not.toContain('secret.pdf')
    expect(wrapper.text()).not.toContain('never-show')
    expect(wrapper.text()).not.toContain('利润')
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
    expect(wrapper.get('[data-testid="contacts-empty"]').text()).toContain('暂无联系人')
    expect(wrapper.get('[data-testid="documents-empty"]').text()).toContain('暂无文档')

    await wrapper.setProps({ projectCode: '测 试/002' })
    await settle()
    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).toBe(
      '/api/projects/%E6%B5%8B%20%E8%AF%95%2F002/dashboard',
    )
    await wrapper.get('[data-testid="project-dashboard-back"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
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
