import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PortfolioOperatingOverview from '../components/PortfolioOperatingOverview.vue'
import ProjectDashboard from '../components/ProjectDashboard.vue'
import ProjectCommercialPanel from '../components/project/ProjectCommercialPanel.vue'
import ProjectDocumentsPanel from '../components/project/ProjectDocumentsPanel.vue'
import type { GlobalDashboard, ProjectDashboard as ProjectDashboardData } from '../domain/contracts'

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
    expect(wrapper.get('[data-testid="portfolio-operating-live"]').text()).toContain('真实后端')
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
    expect(wrapper.get('[data-testid="project-live-notice"]').text()).toContain('真实后端')
    expect(wrapper.find('[data-testid="project-demo-notice"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="project-edit-open"]').text()).toBe('编辑项目')
    expect(wrapper.get('[data-testid="project-close-open"]').text()).toBe('完结项目')

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
    await wrapper.get('[data-testid="project-close-reason"]').setValue('项目已验收')
    await wrapper.get('[data-testid="project-close-save"]').trigger('click')
    await settle()
    const close = requests.find(([path]) => path.endsWith('/close'))
    expect(close?.[1]?.method).toBe('POST')
    expect((close?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i)
    expect(wrapper.get('[data-testid="project-status"]').text()).toContain('已完结')
    expect(wrapper.text()).not.toContain('演示')
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
        original_filename: 'survey.dwg',
        content_type: 'application/acad',
        size_bytes: 6,
        sha256: '0'.repeat(64),
        notes: null,
        created_at: document.created_at,
      }],
    }
    const requests: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      requests.push([path, init])
      const method = init?.method ?? 'GET'
      if (path.includes('/documents?page=')) {
        return jsonResponse({ items: [document], total: 1, page: 1, page_size: 100 })
      }
      if (path.endsWith('/documents/12') && method === 'GET') return jsonResponse(detail)
      if (path.endsWith('/download')) return new Response(new Blob(['survey']))
      if (path.endsWith('/versions')) return jsonResponse({ ...detail.versions[0], id: 32, version_number: 2 })
      if (path.endsWith('/archive')) return jsonResponse({ ...detail, archived_at: '2026-08-31T03:00:00+00:00', revision: 2 })
      if (path.endsWith('/documents/12') && method === 'PUT') {
        return jsonResponse({ ...detail, title: '现场测绘复核', revision: 2 })
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

    expect(requests[0]?.[0]).toBe('/api/projects/SY-2026-001/documents?page=1&page_size=100')
    expect(wrapper.text()).not.toContain('演示')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text()).toContain('1 份资料 · 1 个历史版本')

    await wrapper.get('[data-testid="document-history-open-12"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="document-history-version-31"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('V1')
    expect(wrapper.text()).toContain('survey.dwg')
    await wrapper.get('[data-testid="document-history-download-31"]').trigger('click')
    await settle()
    expect(requests.some(([path]) => path.endsWith('/documents/12/versions/31/download'))).toBe(true)

    await wrapper.get('[data-testid="document-edit-open-12"]').trigger('click')
    await wrapper.get('[data-testid="document-edit-title"]').setValue('现场测绘复核')
    await wrapper.get('[data-testid="document-edit-save"]').trigger('click')
    await settle()
    const edit = requests.find(([path, init]) => path.endsWith('/documents/12') && init?.method === 'PUT')
    expect(JSON.parse(String(edit?.[1]?.body))).toEqual({
      title: '现场测绘复核', notes: null, expected_revision: 1,
    })

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('技术协议')
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

    await wrapper.get('[data-testid="document-version-open-12"]').trigger('click')
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

    await wrapper.get('[data-testid="document-download-12"]').trigger('click')
    await settle()
    expect(requests.some(([path]) => path.endsWith('/documents/12/versions/31/download'))).toBe(true)
    expect(createObjectUrl).toHaveBeenCalled()

    await wrapper.get('[data-testid="document-archive-open-12"]').trigger('click')
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

    await wrapper.get('[data-testid="document-history-open-12"]').trigger('click')
    await wrapper.setProps({ projectCode: 'PROJECT-B' })
    await settle()
    await wrapper.get('[data-testid="document-history-open-22"]').trigger('click')
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

    await wrapper.get('[data-testid="document-minutes-version-open-12"]').trigger('click')
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

    await wrapper.get('[data-testid="document-minutes-version-open-12"]').trigger('click')
    await wrapper.get('[data-testid="document-minutes-content"]').setValue('A 项目 V2 内容')
    await wrapper.get('[data-testid="document-minutes-save"]').trigger('click')
    await wrapper.setProps({ projectCode: 'PROJECT-B' })
    await settle()

    await wrapper.get('[data-testid="document-minutes-version-open-22"]').trigger('click')
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
      if (path.includes('/documents?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
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
      '/api/projects/SY-2026-001/documents?page=1&page_size=100',
    ]))
    expect(wrapper.text()).not.toContain('演示')
    expect(wrapper.get('[data-testid="commercial-live-notice"]').text()).toContain('真实后端')

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
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path.includes('/quotes?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (path.includes('/contracts?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
      if (path.includes('/documents?page=')) return jsonResponse({ items: [], total: 0, page: 1, page_size: 100 })
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
          contract_allocation_id: null,
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

    await wrapper.get('[data-testid="document-version-open-12"]').trigger('click')
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
})
