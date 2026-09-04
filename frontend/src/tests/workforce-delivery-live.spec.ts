import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  optionalYuanToCents,
  signedYuanToCents,
} from '../domain/workforce'

import {
  createHttpWorkforceWorkspaceRepository,
} from '../repositories/workforce.live'
import {
  createHttpDeliveryRepository,
} from '../repositories/delivery.live'

const key = '018f3e40-1234-7000-8000-123456789abc'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body))
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, string> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return init?.headers as Record<string, string>
}

async function expectRetriableDeliveryCreate(
  fetchMock: ReturnType<typeof vi.fn>,
  path: string,
  payload: unknown,
  files: readonly File[],
  submit: () => Promise<void>,
  discard: () => boolean,
): Promise<void> {
  const matchingCalls = (): [string, RequestInit][] => fetchMock.mock.calls.filter(
    ([request, init]) => String(request) === path && init?.method === 'POST',
  ) as [string, RequestInit][]

  await expect(submit()).rejects.toThrow('无法连接本地服务')
  const first = matchingCalls()[0]?.[1]
  expect(first).toBeDefined()
  const firstKey = (first?.headers as Record<string, string>)['Idempotency-Key']

  await expect(submit()).rejects.toThrow('无法连接本地服务')
  const retry = matchingCalls()[1]?.[1]
  expect((retry?.headers as Record<string, string>)['Idempotency-Key']).toBe(firstKey)
  if (files.length > 0) {
    expect(retry?.body).toBeInstanceOf(FormData)
    expect(JSON.parse(String((retry?.body as FormData).get('payload')))).toEqual(payload)
    expect((retry?.body as FormData).getAll('files')).toEqual(files)
  } else {
    expect(JSON.parse(String(retry?.body))).toEqual(payload)
  }

  expect(discard()).toBe(true)
  await expect(submit()).rejects.toThrow('无法连接本地服务')
  const replacement = matchingCalls()[2]?.[1]
  expect((replacement?.headers as Record<string, string>)['Idempotency-Key'])
    .not.toBe(firstKey)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('施工现场真实 API 仓储', () => {
  it('组合读取人员、排单、上工、日报和垫资，不使用演示回退', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpWorkforceWorkspaceRepository()
      .getWorkforcePreview('SY/2026-001')

    expect(result.source).toBe('live')
    expect(result.data).toEqual({
      project_code: 'SY/2026-001',
      workers: [], crew_assignments: [], labor_entries: [],
      site_daily_reports: [], material_advances: [],
    })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/workers?page=1&page_size=200&status=all',
      '/api/projects/SY%2F2026-001/crew-assignments?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/labor-entries?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/site-daily-reports?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/material-advances?page=1&page_size=200',
    ])
  })

  it('当天批量覆盖提交后端 revision，并携带可重试幂等键', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [{ id: 7, name: '张工', phone: null, notes: null,
        status: 'active', inactive_on: null, inactive_reason: null, revision: 1,
        created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [{ id: 3, project_code: 'SY-001', worker_id: 7,
        worker_name: '张工', worker_phone: null, role: '电工', scheduled_start_on: '2026-08-01',
        scheduled_end_on: null, pay_basis: 'daily', rate_cents: 50000, notes: null,
        status: 'active', revision: 2, created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [{ id: 9, assignment_id: 3, worker_id: 7,
        worker_name: '张工', work_date: '2026-08-31', attendance_status: 'present',
        day_fraction: '1.000', work_minutes: null, pay_basis: 'daily', rate_cents: 50000,
        cost_cents: 50000, work_summary: '旧记录', notes: null, status: 'active', revision: 3,
        project_code: 'SY-001', created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({
        work_date: '2026-08-31',
        items: [{ id: 9, assignment_id: 3, worker_id: 7, worker_name: '张工',
          work_date: '2026-08-31', attendance_status: 'present', day_fraction: '1.000',
          work_minutes: null, pay_basis: 'daily', rate_cents: 50000, cost_cents: 50000,
          work_summary: '接线', notes: null, status: 'active', revision: 4,
          project_code: 'SY-001', created_at: '', updated_at: '' }],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await repository.saveLaborEntriesBatch('SY-001', {
      work_date: '2026-08-31',
      entries: [{ assignment_id: 3, attendance_status: 'present', day_fraction: '1.000',
        work_minutes: null, work_summary: '接线', notes: null }],
    })

    expect(fetchMock).toHaveBeenLastCalledWith('/api/projects/SY-001/labor-entries/batch', expect.objectContaining({ method: 'POST' }))
    expect(requestHeaders(fetchMock, 5)['Idempotency-Key']).toBe(key)
    expect(requestBody(fetchMock, 5)).toMatchObject({
      entries: [expect.objectContaining({ expected_revision: 3 })],
    })
  })

  it('作废上工更正使用原记录 revision，并映射后端 replacement 审计关系', async () => {
    const assignment = {
      id: 3, project_code: 'SY-001', worker_id: 7, worker_name: '张工', worker_phone: null,
      role: '电工', scheduled_start_on: '2026-08-01', scheduled_end_on: null,
      pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'active', revision: 2,
      created_at: '', updated_at: '',
    }
    const voided = {
      id: 9, assignment_id: 3, worker_id: 7, worker_name: '张工', replaces_entry_id: null,
      work_date: '2026-08-31', attendance_status: 'present', day_fraction: '1.000',
      work_minutes: null, pay_basis: 'daily', rate_cents: 50000, cost_cents: 50000,
      work_summary: 'A：错误记录', notes: null, status: 'voided', void_reason: '工时录错',
      voided_at: '2026-08-31T03:00:00+00:00', revision: 4, project_code: 'SY-001',
      created_at: '', updated_at: '',
    }
    const replacement = {
      ...voided, id: 10, replaces_entry_id: 9, status: 'active', void_reason: null,
      voided_at: null, day_fraction: '0.500', cost_cents: 25000,
      work_summary: 'B：更正记录', revision: 1,
    }
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ ...emptyPage, items: [assignment], total: 1 }))
      .mockResolvedValueOnce(response({ ...emptyPage, items: [voided], total: 1 }))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ work_date: '2026-08-31', items: [replacement] }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    const saved = await repository.saveLaborEntriesBatch('SY-001', {
      work_date: '2026-08-31',
      entries: [{
        assignment_id: 3, attendance_status: 'present', day_fraction: '0.500',
        work_minutes: null, work_summary: 'B：更正记录', notes: null,
      }],
    })

    expect(requestBody(fetchMock, 5)).toMatchObject({
      entries: [expect.objectContaining({ expected_revision: 4 })],
    })
    expect(saved.data[0]).toMatchObject({
      entry_id: 10, replaces_entry_id: 9, status: 'active', work_summary: 'B：更正记录',
    })
  })

  it('日报真实响应保留确认版本与重开事件', async () => {
    const report = {
      id: 2, project_code: 'SY-001', work_date: '2026-08-31', location: '一号车间',
      weather: '晴', work_summary: 'B：当前正文', blockers: null, next_plan: null, notes: null,
      status: 'draft', confirmed_at: null, revision: 4, created_at: '', updated_at: '',
      versions: [{
        id: 6, version_number: 1, work_date: '2026-08-31', location: '一号车间',
        weather: '晴', work_summary: 'A：确认正文', blockers: null, next_plan: null,
        notes: null, confirmed_at: '2026-08-31T01:00:00+00:00', created_at: '',
      }],
      events: [
        { id: 7, from_status: 'draft', to_status: 'confirmed', reason: null, report_version_id: 6, occurred_at: '', created_at: '' },
        { id: 8, from_status: 'confirmed', to_status: 'draft', reason: '补录漏项', report_version_id: 6, occurred_at: '', created_at: '' },
      ],
    }
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ ...emptyPage, items: [report], total: 1 }))
      .mockResolvedValueOnce(response(emptyPage))
    vi.stubGlobal('fetch', fetchMock)

    const preview = await createHttpWorkforceWorkspaceRepository().getWorkforcePreview('SY-001')

    expect(preview.data.site_daily_reports[0]).toMatchObject({
      work_summary: 'B：当前正文',
      versions: [expect.objectContaining({ version_number: 1, work_summary: 'A：确认正文' })],
      events: [
        expect.objectContaining({ report_version_id: 6, to_status: 'confirmed' }),
        expect.objectContaining({ report_version_id: 6, to_status: 'draft' }),
      ],
    })
  })

  it('重新启用、排单流转、单条编辑和作废都使用当前资源 revision', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const inactiveWorker = {
      id: 8, name: '李工', phone: null, notes: null, status: 'inactive',
      inactive_on: '2026-08-30', inactive_reason: '暂停接单', revision: 4,
      created_at: '', updated_at: '',
    }
    const assignment = {
      id: 3, project_code: 'SY-001', worker_id: 8, worker_name: '李工',
      worker_phone: null, role: '电工', scheduled_start_on: '2026-08-01',
      scheduled_end_on: null, pay_basis: 'daily', rate_cents: 50000, notes: null,
      status: 'planned', revision: 5, created_at: '', updated_at: '',
    }
    const labor = {
      id: 9, assignment_id: 3, worker_id: 8, worker_name: '李工',
      work_date: '2026-08-29', attendance_status: 'present', day_fraction: '1.000',
      work_minutes: null, pay_basis: 'daily', rate_cents: 50000, cost_cents: 50000,
      work_summary: '旧记录', notes: null, status: 'active', void_reason: null,
      voided_at: null, revision: 6, project_code: 'SY-001', created_at: '', updated_at: '',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [inactiveWorker], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [assignment], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [labor], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response(inactiveWorker))
      .mockResolvedValueOnce(response({ ...inactiveWorker, status: 'active', inactive_on: null, inactive_reason: null, revision: 5 }))
      .mockResolvedValueOnce(response({ ...assignment, status: 'active', revision: 6 }))
      .mockResolvedValueOnce(response({ ...labor, day_fraction: '0.500', cost_cents: 25000, revision: 7 }))
      .mockResolvedValueOnce(response({ ...labor, status: 'voided', void_reason: '重复登记', revision: 8 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await repository.setWorkerStatus(8, 'active')
    await repository.setCrewAssignmentStatus('SY-001', 3, 'active', null)
    await repository.updateLaborEntry('SY-001', 9, {
      assignment_id: 3, work_date: '2026-08-29', attendance_status: 'present',
      day_fraction: '0.500', work_minutes: null, work_summary: '改为半天', notes: null,
    })
    await repository.voidLaborEntry('SY-001', 9, '重复登记')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workers?page=1&page_size=200&status=all')
    expect(requestBody(fetchMock, 6)).toEqual({ expected_revision: 4 })
    expect(requestBody(fetchMock, 7)).toMatchObject({ to_status: 'active', expected_revision: 5 })
    expect(requestBody(fetchMock, 8)).toMatchObject({ expected_revision: 6, day_fraction: '0.500' })
    expect(requestBody(fetchMock, 9)).toEqual({ reason: '重复登记', expected_revision: 7 })
    expect(requestHeaders(fetchMock, 6)['Idempotency-Key']).toBe(key)
    expect(requestHeaders(fetchMock, 7)['Idempotency-Key']).toBe(key)
    expect(requestHeaders(fetchMock, 9)['Idempotency-Key']).toBe(key)
  })

  it('取消排单将用户填写的原因原样交给 transition API', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const assignment = {
      id: 3, project_code: 'SY-001', worker_id: 8, worker_name: '李工',
      worker_phone: null, role: '电工', scheduled_start_on: '2026-08-01',
      scheduled_end_on: null, pay_basis: 'daily', rate_cents: 50000, notes: null,
      status: 'planned', revision: 5, created_at: '', updated_at: '',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [assignment], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ ...assignment, status: 'cancelled', revision: 6 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await repository.setCrewAssignmentStatus('SY-001', 3, 'cancelled', '客户要求暂停进场')

    expect(requestBody(fetchMock, 5)).toMatchObject({
      to_status: 'cancelled',
      reason: '客户要求暂停进场',
      expected_revision: 5,
    })
  })

  it('日报保存使用 PUT revision；垫资自动提交行金额；报销使用幂等 POST', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [{ id: 2, project_code: 'SY-001', work_date: '2026-08-31',
        location: null, weather: null, work_summary: '旧日报', blockers: null, next_plan: null,
        notes: null, status: 'draft', confirmed_at: null, revision: 2,
        created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ work_date: '2026-08-31', revision: 3 }))
      .mockResolvedValueOnce(response({ id: 8, revision: 1, items: [], reimbursements: [] }))
      .mockResolvedValueOnce(response({ id: 11, advance_revision: 2 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await repository.saveSiteDailyReport('SY-001', {
      work_date: '2026-08-31', location: null, weather: null,
      work_summary: '安装', blockers: null, next_plan: null, notes: null,
    })
    await repository.saveMaterialAdvance('SY-001', {
      worker_id: 7, spent_on: '2026-08-31', vendor_name: '五金店',
      items: [{ name: '扎带', specification: null, brand: null, quantity: '2.000',
        unit: '包', unit_price_cents: 3500 }], notes: null, document_version_ids: [],
    })
    await repository.recordMaterialAdvanceReimbursement('SY-001', 8, {
      amount_cents: 7000, reimbursed_on: '2026-08-31', payment_method: 'cash', notes: null,
    })

    expect(fetchMock.mock.calls[5]?.[0]).toBe('/api/projects/SY-001/site-daily-reports/2026-08-31')
    expect((fetchMock.mock.calls[5]?.[1] as RequestInit).method).toBe('PUT')
    expect(requestBody(fetchMock, 5)).toMatchObject({ expected_revision: 2 })
    expect(requestBody(fetchMock, 6)).toMatchObject({
      items: [expect.objectContaining({ line_amount_cents: 7000 })],
    })
    expect(requestHeaders(fetchMock, 6)['Idempotency-Key']).toBe(key)
    expect(fetchMock.mock.calls[7]?.[0]).toBe('/api/projects/SY-001/material-advances/8/reimbursements')
    expect(requestHeaders(fetchMock, 7)['Idempotency-Key']).toBe(key)
  })

  it('排单编辑和日报重新打开都使用预览中的最新 revision', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const assignment = {
      id: 3, project_code: 'SY-001', worker_id: 7, worker_name: '张工', worker_phone: null,
      role: '电工', scheduled_start_on: '2026-08-01', scheduled_end_on: '2026-09-30',
      pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'planned', revision: 5,
      created_at: '', updated_at: '',
    }
    const report = {
      id: 2, project_code: 'SY-001', work_date: '2026-08-31', location: null,
      weather: null, work_summary: '安装', blockers: null, next_plan: null, notes: null,
      status: 'confirmed', confirmed_at: '2026-08-31T01:00:00+00:00', revision: 3,
      created_at: '', updated_at: '',
    }
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/crew-assignments?page=1&page_size=200')) {
        return response({ ...emptyPage, items: [assignment], total: 1 })
      }
      if (path.endsWith('/site-daily-reports?page=1&page_size=200')) {
        return response({ ...emptyPage, items: [report], total: 1 })
      }
      if (path.endsWith('/crew-assignments/3') && init?.method === 'PUT') {
        return response({ ...assignment, role: '调试', revision: 6 })
      }
      if (path.endsWith('/site-daily-reports/2026-08-31/reopen')) {
        return response({ ...report, status: 'draft', confirmed_at: null, revision: 4 })
      }
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await repository.updateCrewAssignment('SY-001', 3, {
      worker_id: 7, role: '调试', scheduled_start_on: '2026-08-01',
      scheduled_end_on: '2026-09-30', pay_basis: 'daily', rate_cents: 55000, notes: null,
    })
    await repository.reopenSiteDailyReport('SY-001', '2026-08-31', '补充漏项')

    const editCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/crew-assignments/3'))
    const reopenCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/site-daily-reports/2026-08-31/reopen'))
    expect((editCall?.[1] as RequestInit).method).toBe('PUT')
    expect(JSON.parse(String((editCall?.[1] as RequestInit).body))).toMatchObject({
      role: '调试', expected_revision: 5,
    })
    expect(JSON.parse(String((reopenCall?.[1] as RequestInit).body))).toEqual({
      reason: '补充漏项', expected_revision: 3,
    })
    expect((reopenCall?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
  })

  it('报销冲销网络结果未知时安全重试，并用返回值恢复父垫资可编辑状态', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const reimbursement = {
      id: 11, advance_id: 8, amount_cents: 1000, reimbursed_on: '2026-08-31',
      payment_method: 'cash', notes: '现金报销', status: 'active', void_reason: null,
      voided_at: null, revision: 4, created_at: '', updated_at: '',
    }
    const advance = {
      id: 8, project_code: 'SY-001', worker_id: 7, worker_name: '张工',
      spent_on: '2026-08-31', vendor_name: '五金店', total_amount_cents: 3000,
      reimbursed_amount_cents: 1000, outstanding_amount_cents: 2000, notes: null,
      status: 'partial', void_reason: null, voided_at: null, document_version_ids: [],
      revision: 6, created_at: '', updated_at: '',
      items: [{ id: 1, line_number: 1, name: '扎带', specification: null, brand: null,
        quantity: '1.000', unit: '包', unit_price_cents: 3000, line_amount_cents: 3000 }],
      reimbursements: [reimbursement],
    }
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    let voidAttempts = 0
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/material-advances?page=1&page_size=200')) {
        return response({ ...emptyPage, items: [advance], total: 1 })
      }
      if (path.endsWith('/material-advances/8') && (init?.method ?? 'GET') === 'GET') return response(advance)
      if (path.endsWith('/reimbursements/11/void')) {
        voidAttempts += 1
        if (voidAttempts === 1) throw new TypeError('network disconnected')
        return response({
          ...reimbursement,
          status: 'voided', void_reason: '付款方式错误', voided_at: '2026-08-31T03:00:00+00:00',
          revision: 5, advance_status: 'unreimbursed', advance_reimbursed_amount_cents: 0,
          advance_outstanding_amount_cents: 3000, advance_revision: 7,
        })
      }
      if (path.endsWith('/material-advances/8') && init?.method === 'PUT') {
        return response({ ...advance, reimbursed_amount_cents: 0, outstanding_amount_cents: 3000,
          status: 'unreimbursed', revision: 8, reimbursements: [{ ...reimbursement, status: 'voided' }] })
      }
      if (path.endsWith('/material-advances/8/void')) {
        return response({ ...advance, reimbursed_amount_cents: 0, outstanding_amount_cents: 3000,
          status: 'voided', void_reason: '重复登记', voided_at: '2026-08-31T03:00:00+00:00',
          revision: 9, reimbursements: [{ ...reimbursement, status: 'voided' }] })
      }
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview('SY-001')

    await expect(repository.voidMaterialAdvanceReimbursement('SY-001', 8, 11, '付款方式错误'))
      .rejects.toThrow('无法连接本地服务')
    await repository.voidMaterialAdvanceReimbursement('SY-001', 8, 11, '付款方式错误')
    await repository.updateMaterialAdvance('SY-001', 8, {
      worker_id: 7, spent_on: '2026-08-31', vendor_name: '更正五金店',
      items: [{ name: '扎带', specification: null, brand: null, quantity: '1.000', unit: '包', unit_price_cents: 3000 }],
      notes: null, document_version_ids: [],
    })
    await repository.voidMaterialAdvance('SY-001', 8, '重复登记')

    const voidCalls = fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/reimbursements/11/void'))
    expect(voidCalls).toHaveLength(2)
    expect((voidCalls[0]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect((voidCalls[1]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect(JSON.parse(String((voidCalls[0]?.[1] as RequestInit).body))).toEqual({
      reason: '付款方式错误', expected_revision: 4,
    })
    const updateCall = fetchMock.mock.calls.find(([path, init]) => (
      String(path).endsWith('/material-advances/8') && init?.method === 'PUT'
    ))
    expect(JSON.parse(String((updateCall?.[1] as RequestInit).body))).toMatchObject({
      expected_revision: 7,
    })
    const voidAdvanceCall = fetchMock.mock.calls.find(([path]) => (
      String(path).endsWith('/material-advances/8/void')
    ))
    expect(JSON.parse(String((voidAdvanceCall?.[1] as RequestInit).body))).toEqual({
      reason: '重复登记', expected_revision: 8,
    })
  })

  it('上工记录超过 200 条时继续拉取后续页，不把首页当完整汇总', async () => {
    const firstPageItems = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1, assignment_id: index + 1, worker_id: index + 1,
      worker_name: `施工员${index + 1}`, work_date: '2026-08-31',
      attendance_status: 'present', day_fraction: '1.000', work_minutes: null,
      pay_basis: 'daily', rate_cents: 10000, cost_cents: 10000,
      work_summary: null, notes: null, status: 'active', revision: 1,
      project_code: 'SY-001', created_at: '', updated_at: '',
    }))
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.includes('/labor-entries?page=1')) {
        return response({ items: firstPageItems, total: 201, page: 1, page_size: 200 })
      }
      if (path.includes('/labor-entries?page=2')) {
        return response({ items: [{ ...firstPageItems[0], id: 201, assignment_id: 201, worker_id: 201 }], total: 201, page: 2, page_size: 200 })
      }
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpWorkforceWorkspaceRepository().getWorkforcePreview('SY-001')

    expect(result.data.labor_entries).toHaveLength(201)
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toContain(
      '/api/projects/SY-001/labor-entries?page=2&page_size=200',
    )
  })

  it('人员、排单、日报和垫资超过 200 条时全部读取，垫资详情有界并发', async () => {
    const pageIds = (page: number) => page === 1
      ? Array.from({ length: 200 }, (_, index) => index + 1)
      : [201]
    let activeAdvanceDetails = 0
    let maxAdvanceDetailConcurrency = 0
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      const page = path.includes('page=2') ? 2 : 1
      if (path.startsWith('/api/workers?')) {
        return response({
          items: pageIds(page).map((id) => ({ id, name: `施工员${id}`, phone: null, notes: null, status: 'active', revision: 1 })),
          total: 201, page, page_size: 200,
        })
      }
      if (path.includes('/crew-assignments?')) {
        return response({
          items: pageIds(page).map((id) => ({
            id, project_code: 'SY-001', worker_id: id, worker_name: `施工员${id}`,
            worker_phone: null, role: '电工', scheduled_start_on: '2026-08-01', scheduled_end_on: null,
            pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'active', revision: 1,
          })),
          total: 201, page, page_size: 200,
        })
      }
      if (path.includes('/site-daily-reports?')) {
        return response({
          items: pageIds(page).map((id) => ({
            id, project_code: 'SY-001', work_date: `2026-${String(Math.ceil(id / 28)).padStart(2, '0')}-${String(((id - 1) % 28) + 1).padStart(2, '0')}`,
            location: null, weather: null, work_summary: `日报${id}`, blockers: null, next_plan: null,
            notes: null, status: 'draft', confirmed_at: null, revision: 1, created_at: '', updated_at: '',
            versions: [], events: [],
          })),
          total: 201, page, page_size: 200,
        })
      }
      if (path.includes('/material-advances?')) {
        return response({
          items: pageIds(page).map((id) => ({ id })), total: 201, page, page_size: 200,
        })
      }
      if (path.includes('/material-advances/')) {
        const id = Number(path.split('/').pop())
        activeAdvanceDetails += 1
        maxAdvanceDetailConcurrency = Math.max(maxAdvanceDetailConcurrency, activeAdvanceDetails)
        await new Promise((resolve) => setTimeout(resolve, 0))
        activeAdvanceDetails -= 1
        return response({
          id, project_code: 'SY-001', worker_id: id, worker_name: `施工员${id}`,
          spent_on: '2026-08-31', vendor_name: `商户${id}`, total_amount_cents: 1000,
          reimbursed_amount_cents: 0, outstanding_amount_cents: 1000, notes: null,
          status: 'unreimbursed', void_reason: null, voided_at: null, document_version_ids: [],
          revision: 1, created_at: '', updated_at: '', items: [], reimbursements: [],
        })
      }
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpWorkforceWorkspaceRepository().getWorkforcePreview('SY-001')

    expect(result.data.workers).toHaveLength(201)
    expect(result.data.crew_assignments).toHaveLength(201)
    expect(result.data.site_daily_reports).toHaveLength(201)
    expect(result.data.material_advances).toHaveLength(201)
    expect(maxAdvanceDetailConcurrency).toBeGreaterThan(1)
    expect(maxAdvanceDetailConcurrency).toBeLessThanOrEqual(8)
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([
      '/api/workers?page=2&page_size=200&status=all',
      '/api/projects/SY-001/crew-assignments?page=2&page_size=200',
      '/api/projects/SY-001/site-daily-reports?page=2&page_size=200',
      '/api/projects/SY-001/material-advances?page=2&page_size=200',
    ]))
  })

  it('单个施工子域读取失败时保留其他区块并标记缺口', async () => {
    const worker = { id: 7, name: '张工', phone: null, notes: null, status: 'active', revision: 1 }
    const assignment = {
      id: 3, project_code: 'SY-001', worker_id: 7, worker_name: '张工', worker_phone: null,
      role: '电工', scheduled_start_on: '2026-08-01', scheduled_end_on: null,
      pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'active', revision: 1,
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.startsWith('/api/workers?')) return response({ items: [worker], total: 1, page: 1, page_size: 200 })
      if (path.includes('/crew-assignments?')) return response({ items: [assignment], total: 1, page: 1, page_size: 200 })
      if (path.includes('/site-daily-reports?')) throw new TypeError('network disconnected')
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpWorkforceWorkspaceRepository().getWorkforcePreview('SY-001')

    expect(result.data.workers).toEqual([expect.objectContaining({ worker_id: 7, name: '张工' })])
    expect(result.data.crew_assignments).toEqual([expect.objectContaining({ assignment_id: 3 })])
    expect(result.data.site_daily_reports).toEqual([])
    expect(result.data.load_warnings).toEqual([{
      section: 'site_daily_reports',
      message: expect.stringContaining('施工日报读取失败'),
    }])
  })

  it('项目 A 慢请求晚于项目 B 返回时，B 的上工 revision 不被覆盖', async () => {
    let resolveProjectALabor!: (value: Response) => void
    const projectALabor = new Promise<Response>((resolve) => { resolveProjectALabor = resolve })
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.includes('/projects/A/labor-entries')) return projectALabor
      if (path === '/api/workers?page=1&page_size=200') {
        return response({ items: [{ id: 7, name: '张工', phone: null, notes: null, status: 'active', revision: 1 }], total: 1, page: 1, page_size: 200 })
      }
      if (path.includes('/projects/B/crew-assignments')) {
        return response({ items: [{ id: 3, project_code: 'B', worker_id: 7, worker_name: '张工', worker_phone: null, role: '电工', scheduled_start_on: '2026-08-01', scheduled_end_on: null, pay_basis: 'daily', rate_cents: 50000, notes: null, status: 'active', revision: 2 }], total: 1, page: 1, page_size: 200 })
      }
      if (path.includes('/projects/B/labor-entries')) {
        return response({ items: [{ id: 9, assignment_id: 3, worker_id: 7, worker_name: '张工', work_date: '2026-08-31', attendance_status: 'present', day_fraction: '1.000', work_minutes: null, pay_basis: 'daily', rate_cents: 50000, cost_cents: 50000, work_summary: null, notes: null, status: 'active', revision: 22, project_code: 'B' }], total: 1, page: 1, page_size: 200 })
      }
      if (path.endsWith('/projects/B/labor-entries/batch')) {
        return response({ work_date: '2026-08-31', items: [] })
      }
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()
    const projectARequest = repository.getWorkforcePreview('A')
    await Promise.resolve()
    await repository.getWorkforcePreview('B')
    resolveProjectALabor(response({ items: [], total: 0, page: 1, page_size: 200 }))
    await projectARequest

    await repository.saveLaborEntriesBatch('B', {
      work_date: '2026-08-31',
      entries: [{ assignment_id: 3, attendance_status: 'present', day_fraction: '1.000', work_minutes: null, work_summary: null, notes: null }],
    })

    const batchCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/projects/B/labor-entries/batch'))
    expect(JSON.parse(String((batchCall?.[1] as RequestInit).body))).toMatchObject({
      entries: [expect.objectContaining({ expected_revision: 22 })],
    })
  })
})

describe('交付真实 API 仓储', () => {
  it('调试、变更、验收和售后未知结果原样重试，明确放弃后换幂等键', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (init?.method === 'POST') throw new TypeError('network disconnected')
      if (String(path).endsWith('/drawing-signoffs')) return response([])
      if (String(path).endsWith('/warranty')) return response(null)
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY/001')
    const commissioningInput = {
      started_at: '2026-09-03T01:00:00.000Z', ended_at: null,
      status: 'in_progress' as const, summary: '原调试结果', issues: null,
      next_action: null, notes: null, document_version_ids: [],
    }
    const commissioningFile = new File(['commissioning'], '调试记录.pdf', {
      type: 'application/pdf',
    })
    const changeInput = {
      source: 'customer_request' as const, title: '原变更', description: '原说明',
      reason: '客户要求', contract_delta_cents: 0, estimated_cost_delta_cents: 0,
      schedule_delta_days: 0, proposed_on: '2026-09-03', notes: null,
      document_version_ids: [],
    }
    const changeFile = new File(['change'], '变更单.pdf', { type: 'application/pdf' })
    const acceptanceInput = {
      acceptance_type: 'pre_acceptance' as const,
      scheduled_on: '2026-09-10', notes: '原验收计划',
    }
    const afterSalesInput = {
      reported_on: '2026-09-03', service_on: null, reason: '原报修原因',
      contact_name: '张工', contact_phone: '13800000000', coverage_type: 'paid' as const,
      notes: null,
    }

    await expectRetriableDeliveryCreate(
      fetchMock,
      '/api/projects/SY%2F001/commissioning-sessions',
      commissioningInput,
      [commissioningFile],
      () => repository.saveCommissioningSession('SY/001', commissioningInput, [commissioningFile]),
      () => repository.discardSaveCommissioningSession('SY/001', commissioningInput, [commissioningFile]),
    )
    await expectRetriableDeliveryCreate(
      fetchMock,
      '/api/projects/SY%2F001/engineering-changes',
      changeInput,
      [changeFile],
      () => repository.saveEngineeringChange('SY/001', changeInput, [changeFile]),
      () => repository.discardSaveEngineeringChange('SY/001', changeInput, [changeFile]),
    )
    await expectRetriableDeliveryCreate(
      fetchMock,
      '/api/projects/SY%2F001/acceptances',
      acceptanceInput,
      [],
      () => repository.saveAcceptance('SY/001', acceptanceInput),
      () => repository.discardSaveAcceptance('SY/001', acceptanceInput),
    )
    await expectRetriableDeliveryCreate(
      fetchMock,
      '/api/projects/SY%2F001/after-sales',
      afterSalesInput,
      [],
      () => repository.saveAfterSalesCase('SY/001', afterSalesInput),
      () => repository.discardSaveAfterSalesCase('SY/001', afterSalesInput),
    )
  })

  it('发票失败后可按 JSON 或同一批 File 显式放弃待重试语义', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (init?.method === 'POST') throw new TypeError('network disconnected')
      if (String(path).endsWith('/drawing-signoffs')) return response([])
      if (String(path).endsWith('/warranty')) return response(null)
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY-001')
    const input = {
      invoice_type: 'contract_payment' as const, status: 'recorded' as const,
      requested_on: null, recorded_on: '2026-09-03', invoice_number: null,
      amount_cents: null, counterparty_name: null, notes: null, document_version_ids: [],
    }
    const file = new File(['pdf'], '发票.pdf', { type: 'application/pdf' })

    await expect(repository.saveInvoice('SY-001', input, [file])).rejects.toThrow('无法连接本地服务')
    expect(repository.discardSaveInvoice('SY-001', input, [file])).toBe(true)
    await expect(repository.saveInvoice('SY-001', input)).rejects.toThrow('无法连接本地服务')
    expect(repository.discardSaveInvoice('SY-001', input)).toBe(true)
  })

  it('组合读取会签、调试、变更、验收、质保、发票和售后', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpDeliveryRepository().getDeliveryPreview('SY/2026-001')

    expect(result.source).toBe('live')
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/SY%2F2026-001/drawing-signoffs',
      '/api/projects/SY%2F2026-001/commissioning-sessions?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/engineering-changes?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/acceptances?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/warranty',
      '/api/projects/SY%2F2026-001/invoices?page=1&page_size=200',
      '/api/projects/SY%2F2026-001/after-sales?page=1&page_size=200',
    ])
  })

  it('交付子域超过 200 条时继续读取后续分页，不把页面误称为全部', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const commissioning = (id: number) => ({
      id, project_code: 'SY-001', started_at: '2026-09-03T09:00:00+08:00',
      ended_at: null, status: 'completed' as const, summary: `调试 ${id}`,
      issues: null, next_action: null, notes: null, document_version_ids: [],
      revision: 1, created_at: '', updated_at: '',
    })
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      const url = String(path)
      if (url.endsWith('/drawing-signoffs')) return response([])
      if (url.endsWith('/warranty')) return response(null)
      if (url.includes('/commissioning-sessions?page=1')) {
        return response({ items: Array.from({ length: 200 }, (_, index) => commissioning(index + 1)), total: 201, page: 1, page_size: 200 })
      }
      if (url.includes('/commissioning-sessions?page=2')) {
        return response({ items: [commissioning(201)], total: 201, page: 2, page_size: 200 })
      }
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpDeliveryRepository().getDeliveryPreview('SY-001')

    expect(result.data.commissioning_sessions).toHaveLength(201)
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toContain(
      '/api/projects/SY-001/commissioning-sessions?page=2&page_size=200',
    )
  })

  it('单个交付子域读取失败时保留其他成功区块并明确标记不完整', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      const url = String(path)
      if (url.endsWith('/drawing-signoffs')) return response([])
      if (url.endsWith('/warranty')) return response(null)
      if (url.includes('/engineering-changes')) throw new TypeError('network disconnected')
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpDeliveryRepository().getDeliveryPreview('SY-001')

    expect(result.data.engineering_changes).toEqual([])
    expect(result.data.load_warnings).toEqual([
      expect.stringContaining('工程变更读取失败'),
    ])
    expect(result.data.commissioning_sessions).toEqual([])
  })

  it('同项目刷新单个交付子域失败时保留上次成功结果', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const change = {
      id: 4, project_code: 'SY-001', change_number: 1, source: 'site_condition',
      title: '保留的工程变更', description: '旧说明', reason: '现场变化',
      contract_delta_cents: 0, estimated_cost_delta_cents: 0, schedule_delta_days: 0,
      proposed_on: '2026-09-01', notes: null, document_version_ids: [],
      status: 'proposed', revision: 4, created_at: '', updated_at: '',
    }
    let refresh = false
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      const url = String(path)
      if (url.endsWith('/drawing-signoffs')) return response([])
      if (url.endsWith('/warranty')) return response(null)
      if (url.includes('/engineering-changes')) {
        if (refresh) throw new TypeError('network disconnected')
        return response({ ...emptyPage, items: [change], total: 1 })
      }
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()

    const initial = await repository.getDeliveryPreview('SY-001')
    refresh = true
    const afterFailure = await repository.getDeliveryPreview('SY-001')

    expect(initial.data.engineering_changes[0]?.title).toBe('保留的工程变更')
    expect(afterFailure.data.engineering_changes[0]?.title).toBe('保留的工程变更')
    expect(afterFailure.data.load_warnings).toEqual([
      expect.stringContaining('当前显示上次结果'),
    ])
  })

  it('后端质保续费价格为 null 时，页面模型保留 null 而不归一化为 0', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({
        id: 1, project_id: 1, acceptance_id: 1,
        starts_on: '2026-09-01', duration_months: 12,
        renewal_price_cents: null, notes: null,
        ends_on: '2027-09-01', days_remaining: 365, status: 'active',
        revision: 3, created_at: '', updated_at: '',
      }))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createHttpDeliveryRepository().getDeliveryPreview('SY-001')

    expect(result.data.warranty?.renewal_price_cents).toBeNull()
  })

  it('项目发票带文件时发送 multipart payload 和重复 files', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ id: 9, project_code: 'SY-001', revision: 1 }))
      .mockResolvedValueOnce(response({ id: 10, project_code: 'SY-001', revision: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY-001')
    const input = {
      invoice_type: 'contract_payment' as const, status: 'recorded' as const,
      requested_on: null, recorded_on: '2026-09-03', invoice_number: null,
      amount_cents: null, counterparty_name: null, notes: null, document_version_ids: [],
    }
    const files = [
      new File(['one'], '发票正面.jpg', { type: 'image/jpeg' }),
      new File(['two'], '发票.pdf', { type: 'application/pdf' }),
    ]

    await repository.saveInvoice('SY-001', input, files)

    const init = fetchMock.mock.calls[7]?.[1] as RequestInit
    expect(init.headers).not.toMatchObject({ 'Content-Type': 'application/json' })
    const form = init.body as FormData
    expect(form.get('payload')).toBe(JSON.stringify(input))
    expect(form.getAll('files')).toEqual(files)

    await repository.saveInvoice('SY-001', input)
    const jsonInit = fetchMock.mock.calls[8]?.[1] as RequestInit
    expect(jsonInit.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(jsonInit.body))).toEqual(input)
  })

  it('补录计划中发票调用 PUT 并携带缓存版本号', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const planned = {
      id: 9, project_code: 'SY-001', invoice_type: 'contract_payment' as const,
      status: 'planned' as const, requested_on: null, recorded_on: null,
      invoice_number: null, amount_cents: null, counterparty_name: null,
      notes: '只上传图片', document_version_ids: [77], void_reason: null,
      revision: 4, created_at: '', updated_at: '',
    }
    const recorded = {
      ...planned, status: 'recorded' as const, requested_on: '2026-09-10',
      recorded_on: '2026-09-10', invoice_number: 'INV-9', amount_cents: 123456,
      revision: 5,
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ ...emptyPage, items: [planned], total: 1 }))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(recorded))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY-001')

    await repository.updateInvoice('SY-001', 9, {
      invoice_type: 'contract_payment', status: 'recorded',
      requested_on: '2026-09-10', recorded_on: '2026-09-10',
      invoice_number: 'INV-9', amount_cents: 123456, counterparty_name: null,
      notes: '只上传图片', document_version_ids: [77],
    })

    expect(fetchMock.mock.calls[7]?.[0]).toBe('/api/projects/SY-001/invoices/9')
    const init = fetchMock.mock.calls[7]?.[1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toMatchObject({
      status: 'recorded', invoice_number: 'INV-9', amount_cents: 123456,
      document_version_ids: [77], expected_revision: 4,
    })
  })

  it('图纸会签和完成验收带文件时直传 multipart，无文件仍使用原 JSON 接口', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const signoff = {
      id: 3, project_code: 'SY-001', discipline: 'mechanical' as const,
      status: 'pending' as const, confirmed_on: null, not_required_reason: null,
      notes: null, document_version_ids: [], revision: 4, created_at: '', updated_at: '',
    }
    const acceptance = {
      id: 8, project_code: 'SY-001', acceptance_type: 'pre_acceptance' as const,
      scheduled_on: '2026-09-03', performed_on: null, status: 'scheduled' as const,
      notes: null, document_version_ids: [], revision: 5, created_at: '', updated_at: '',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([signoff]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ ...emptyPage, items: [acceptance], total: 1 }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ ...signoff, status: 'confirmed', revision: 5 }))
      .mockResolvedValueOnce(response({ ...signoff, status: 'confirmed', revision: 6 }))
      .mockResolvedValueOnce(response({ acceptance: { ...acceptance, status: 'passed', revision: 6 }, warranty: null }))
      .mockResolvedValueOnce(response({ acceptance: { ...acceptance, status: 'failed', revision: 7 }, warranty: null }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY-001')
    const signoffInput = {
      status: 'confirmed' as const, confirmed_on: '2026-09-03',
      not_required_reason: null, notes: null, document_version_ids: [],
    }
    const completionInput = {
      status: 'passed' as const, performed_on: '2026-09-03', notes: null,
      document_version_ids: [], warranty: null,
    }
    const drawing = new File(['dwg'], '机械最终版.dwg', { type: 'application/acad' })
    const proof = new File(['pdf'], '验收单.pdf', { type: 'application/pdf' })

    await repository.saveDrawingSignoff('SY-001', 'mechanical', signoffInput, [drawing])
    await repository.saveDrawingSignoff('SY-001', 'mechanical', signoffInput)
    await repository.completeAcceptance('SY-001', 8, completionInput, [proof])
    await repository.completeAcceptance('SY-001', 8, { ...completionInput, status: 'failed' })

    const signoffMultipart = fetchMock.mock.calls[7]?.[1] as RequestInit
    expect(signoffMultipart.method).toBe('PUT')
    expect(signoffMultipart.headers).toMatchObject({ 'Idempotency-Key': key })
    expect(signoffMultipart.body).toBeInstanceOf(FormData)
    expect(JSON.parse(String((signoffMultipart.body as FormData).get('payload'))))
      .toMatchObject({ ...signoffInput, expected_revision: 4 })
    expect((signoffMultipart.body as FormData).getAll('files')).toEqual([drawing])

    const signoffJson = fetchMock.mock.calls[8]?.[1] as RequestInit
    expect(signoffJson.method).toBe('PUT')
    expect(signoffJson.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(signoffJson.body))).toMatchObject({ expected_revision: 5 })

    const acceptanceMultipart = fetchMock.mock.calls[9]?.[1] as RequestInit
    expect(acceptanceMultipart.method).toBe('POST')
    expect(acceptanceMultipart.headers).toMatchObject({ 'Idempotency-Key': key })
    expect(acceptanceMultipart.body).toBeInstanceOf(FormData)
    expect(JSON.parse(String((acceptanceMultipart.body as FormData).get('payload'))))
      .toMatchObject({ result: 'passed', expected_revision: 5 })
    expect((acceptanceMultipart.body as FormData).getAll('files')).toEqual([proof])

    const acceptanceJson = fetchMock.mock.calls[10]?.[1] as RequestInit
    expect(acceptanceJson.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(acceptanceJson.body))).toMatchObject({ result: 'failed', expected_revision: 6 })
  })

  it('新增调试和工程变更可在表单内直接上传附件', async () => {
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response(emptyPage))
      .mockResolvedValueOnce(response({ id: 4, project_code: 'SY-001', revision: 1 }))
      .mockResolvedValueOnce(response({ id: 7, project_code: 'SY-001', revision: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('SY-001')
    const commissioningInput = {
      started_at: '2026-09-03T09:00', ended_at: null, status: 'in_progress' as const,
      summary: null, issues: null, next_action: null, notes: null, document_version_ids: [],
    }
    const changeInput = {
      source: 'site_condition' as const, title: '增加护栏', description: '现场增补', reason: '安全要求',
      contract_delta_cents: 10000, estimated_cost_delta_cents: 6000,
      schedule_delta_days: 2, proposed_on: '2026-09-03', notes: null, document_version_ids: [],
    }
    const commissioningFile = new File(['pdf'], '调试记录.pdf', { type: 'application/pdf' })
    const changeFile = new File(['docx'], '增补确认单.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })

    await repository.saveCommissioningSession('SY-001', commissioningInput, [commissioningFile])
    await repository.saveEngineeringChange('SY-001', changeInput, [changeFile])

    const commissioningRequest = fetchMock.mock.calls[7]?.[1] as RequestInit
    expect(commissioningRequest.body).toBeInstanceOf(FormData)
    expect((commissioningRequest.body as FormData).getAll('files')).toEqual([commissioningFile])
    expect(JSON.parse(String((commissioningRequest.body as FormData).get('payload'))))
      .toMatchObject({ status: 'in_progress', document_version_ids: [] })
    const changeRequest = fetchMock.mock.calls[8]?.[1] as RequestInit
    expect(changeRequest.body).toBeInstanceOf(FormData)
    expect((changeRequest.body as FormData).getAll('files')).toEqual([changeFile])
    expect(JSON.parse(String((changeRequest.body as FormData).get('payload'))))
      .toMatchObject({ title: '增加护栏', document_version_ids: [] })
  })

  it('POST 携带幂等键，PUT 与状态流转携带当前 expected_revision', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ items: [{ id: 4, project_code: 'SY-001',
        started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'in_progress',
        summary: null, issues: null, next_action: null, notes: null,
        document_version_ids: [], revision: 5, created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ items: [], total: 0, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ items: [{ id: 5, project_code: 'SY-001',
        reported_on: '2026-08-31', service_on: null, reason: '故障', contact_name: null,
        contact_phone: null, coverage_type: 'warranty', is_under_warranty: true,
        status: 'open', resolution: null, completed_at: null, notes: null,
        document_version_ids: [], revision: 3, created_at: '', updated_at: '' }], total: 1, page: 1, page_size: 200 }))
      .mockResolvedValueOnce(response({ id: 6, revision: 1 }))
      .mockResolvedValueOnce(response({ id: 4, revision: 6 }))
      .mockResolvedValueOnce(response({ id: 5, revision: 4 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    const preview = await repository.getDeliveryPreview('SY-001')

    expect(preview.data.after_sales[0]?.is_under_warranty).toBe(true)

    await repository.saveCommissioningSession('SY-001', {
      started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'in_progress',
      summary: null, issues: null, next_action: null, notes: null, document_version_ids: [],
    })
    await repository.updateCommissioningSession('SY-001', 4, {
      started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'blocked',
      summary: null, issues: '待料', next_action: null, notes: null, document_version_ids: [],
    })
    await repository.setAfterSalesStatus('SY-001', 5, 'completed', '更换完成')

    expect(requestHeaders(fetchMock, 7)['Idempotency-Key']).toBe(key)
    expect(requestBody(fetchMock, 8)).toMatchObject({ expected_revision: 5 })
    expect(requestHeaders(fetchMock, 9)['Idempotency-Key']).toBe(key)
    expect(requestBody(fetchMock, 9)).toMatchObject({
      to_status: 'completed', expected_revision: 3, resolution: '更换完成',
    })
  })

  it('变更、验收和售后纠错使用缓存 revision，验收取消结果未知时原样重试', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(key)
    const emptyPage = { items: [], total: 0, page: 1, page_size: 200 }
    const change = {
      id: 4, project_code: 'SY-001', change_number: 1, source: 'site_condition',
      title: '旧标题', description: '旧说明', reason: '现场变化', contract_delta_cents: 0,
      estimated_cost_delta_cents: 0, schedule_delta_days: 0, proposed_on: '2026-09-01',
      notes: null, document_version_ids: [], status: 'proposed', revision: 4,
      created_at: '', updated_at: '',
    }
    const acceptance = {
      id: 8, project_code: 'SY-001', acceptance_type: 'pre_acceptance', status: 'scheduled',
      scheduled_on: '2026-09-10', performed_on: null, notes: null, document_version_ids: [],
      cancel_reason: null, cancelled_at: null, revision: 5, created_at: '', updated_at: '',
    }
    const afterSales = {
      id: 9, project_code: 'SY-001', reported_on: '2026-09-01', service_on: null,
      reason: '无信号', contact_name: '张经理', contact_phone: '13900000000',
      coverage_type: 'paid', is_under_warranty: false, notes: null, status: 'open',
      resolution: null, completed_at: null, document_version_ids: [], revision: 6,
      created_at: '', updated_at: '',
    }
    let cancelAttempts = 0
    let rescheduleAttempts = 0
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/drawing-signoffs')) return response([])
      if (path.endsWith('/warranty')) return response(null)
      if (path.includes('/engineering-changes?')) {
        return response({ ...emptyPage, items: [change], total: 1 })
      }
      if (path.includes('/acceptances?')) {
        return response({ ...emptyPage, items: [acceptance], total: 1 })
      }
      if (path.includes('/after-sales?')) {
        return response({ ...emptyPage, items: [afterSales], total: 1 })
      }
      if (path.endsWith('/engineering-changes/4') && init?.method === 'PUT') {
        return response({ ...change, title: '新标题', revision: 5 })
      }
      if (path.endsWith('/acceptances/8/reschedule') && init?.method === 'POST') {
        rescheduleAttempts += 1
        if (rescheduleAttempts === 1) throw new TypeError('network disconnected')
        return response({ ...acceptance, scheduled_on: '2026-09-20', revision: 6 })
      }
      if (path.endsWith('/acceptances/8/cancel')) {
        cancelAttempts += 1
        if (cancelAttempts === 1) throw new TypeError('network disconnected')
        return response({
          ...acceptance, status: 'cancelled', performed_on: '2026-09-03',
          cancel_reason: '客户改期', cancelled_at: '2026-09-03', revision: 7,
        })
      }
      if (path.endsWith('/after-sales/9') && init?.method === 'PUT') {
        return response({ ...afterSales, reason: '传感器无信号', revision: 7 })
      }
      return response(emptyPage)
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    const preview = await repository.getDeliveryPreview('SY-001')

    expect(preview.data.acceptances[0]).toMatchObject({ cancel_reason: null, cancelled_at: null })
    expect(preview.data.after_sales[0]).toMatchObject({ completed_at: null })
    await repository.updateEngineeringChange('SY-001', 4, {
      source: 'site_condition', title: '新标题', description: '旧说明', reason: '现场变化',
      contract_delta_cents: 0, estimated_cost_delta_cents: 0, schedule_delta_days: 0,
      proposed_on: '2026-09-01', notes: null, document_version_ids: [],
    })
    const rescheduleInput = {
      acceptance_type: 'pre_acceptance', scheduled_on: '2026-09-20', notes: null,
    } as const
    await expect(repository.rescheduleAcceptance('SY-001', 8, rescheduleInput, '客户要求延后验收'))
      .rejects.toThrow('无法连接本地服务')
    await repository.rescheduleAcceptance('SY-001', 8, rescheduleInput, '客户要求延后验收')
    await expect(repository.cancelAcceptance('SY-001', 8, '客户改期')).rejects.toThrow('无法连接本地服务')
    await repository.cancelAcceptance('SY-001', 8, '客户改期')
    await repository.updateAfterSalesCase('SY-001', 9, {
      reported_on: '2026-09-01', service_on: null, reason: '传感器无信号',
      contact_name: '张经理', contact_phone: '13900000000', coverage_type: 'paid', notes: null,
    })

    const changeCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/engineering-changes/4'))
    const acceptanceCalls = fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/acceptances/8/reschedule'))
    const cancelCalls = fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/acceptances/8/cancel'))
    const afterSalesCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/after-sales/9'))
    expect(requestInitBody(changeCall)).toMatchObject({ title: '新标题', expected_revision: 4 })
    expect(acceptanceCalls).toHaveLength(2)
    expect(requestInitBody(acceptanceCalls[0])).toEqual(requestInitBody(acceptanceCalls[1]))
    expect(requestInitBody(acceptanceCalls[0])).toMatchObject({
      scheduled_on: '2026-09-20', reason: '客户要求延后验收', expected_revision: 5,
    })
    expect((acceptanceCalls[0]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect((acceptanceCalls[1]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect(cancelCalls).toHaveLength(2)
    expect(requestInitBody(cancelCalls[0])).toEqual(requestInitBody(cancelCalls[1]))
    expect(requestInitBody(cancelCalls[0])).toMatchObject({ reason: '客户改期', expected_revision: 6 })
    expect((cancelCalls[0]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect((cancelCalls[1]?.[1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': key })
    expect(requestInitBody(afterSalesCall)).toMatchObject({ reason: '传感器无信号', expected_revision: 6 })
  })

  it('项目 A 慢请求晚于项目 B 返回时，B 的交付 revision 不被覆盖', async () => {
    let resolveProjectASignoffs!: (value: Response) => void
    const projectASignoffs = new Promise<Response>((resolve) => { resolveProjectASignoffs = resolve })
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/A/drawing-signoffs')) return projectASignoffs
      if (path.includes('/projects/B/commissioning-sessions?')) {
        return response({ items: [{ id: 4, project_code: 'B', started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'in_progress', summary: null, issues: null, next_action: null, notes: null, document_version_ids: [], revision: 55 }], total: 1, page: 1, page_size: 200 })
      }
      if (path.endsWith('/projects/B/commissioning-sessions/4')) return response({ id: 4, revision: 56 })
      if (path.endsWith('/warranty')) return response(null)
      if (path.endsWith('/drawing-signoffs')) return response([])
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    const projectARequest = repository.getDeliveryPreview('A')
    await Promise.resolve()
    await repository.getDeliveryPreview('B')
    resolveProjectASignoffs(response([]))
    await projectARequest

    await repository.updateCommissioningSession('B', 4, {
      started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'completed',
      summary: null, issues: null, next_action: null, notes: null, document_version_ids: [],
    })

    const updateCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/projects/B/commissioning-sessions/4'))
    expect(JSON.parse(String((updateCall?.[1] as RequestInit).body))).toMatchObject({ expected_revision: 55 })
  })

  it('项目 A 写入在途时切到 B 再回 A，旧 A 响应不得覆盖新会话 revision', async () => {
    let resolveOldWrite!: (value: Response) => void
    const oldWrite = new Promise<Response>((resolve) => { resolveOldWrite = resolve })
    let aPreviewCount = 0
    let updateCount = 0
    const updateBodies: Record<string, unknown>[] = []
    const commissioning = (projectCode: string, revision: number) => ({
      id: 4,
      project_code: projectCode,
      started_at: '2026-08-31T08:00:00+08:00',
      ended_at: null,
      status: 'in_progress',
      summary: null,
      issues: null,
      next_action: null,
      notes: null,
      document_version_ids: [],
      revision,
    })
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input)
      if (path.includes('/projects/A/commissioning-sessions?')) {
        aPreviewCount += 1
        const revision = aPreviewCount === 1 ? 1 : 5
        return response({ items: [commissioning('A', revision)], total: 1, page: 1, page_size: 200 })
      }
      if (path.endsWith('/projects/A/commissioning-sessions/4') && init?.method === 'PUT') {
        updateCount += 1
        updateBodies.push(JSON.parse(String(init.body)))
        return updateCount === 1 ? oldWrite : response(commissioning('A', 6))
      }
      if (path.endsWith('/warranty')) return response(null)
      if (path.endsWith('/drawing-signoffs')) return response([])
      return response({ items: [], total: 0, page: 1, page_size: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview('A')
    const input = {
      started_at: '2026-08-31T08:00:00+08:00', ended_at: null, status: 'completed' as const,
      summary: null, issues: null, next_action: null, notes: null, document_version_ids: [],
    }
    const pendingWrite = repository.updateCommissioningSession('A', 4, input)
    await Promise.resolve()
    await repository.getDeliveryPreview('B')
    await repository.getDeliveryPreview('A')
    resolveOldWrite(response(commissioning('A', 2)))
    await pendingWrite

    await repository.updateCommissioningSession('A', 4, input)

    expect(updateBodies).toHaveLength(2)
    expect(updateBodies[0]).toMatchObject({ expected_revision: 1 })
    expect(updateBodies[1]).toMatchObject({ expected_revision: 5 })
  })

  it('质保续费价格可为空，工程变更金额可为负数', () => {
    expect(optionalYuanToCents('')).toBeNull()
    expect(optionalYuanToCents('  ')).toBeNull()
    expect(optionalYuanToCents('1250.50')).toBe(125050)
    expect(signedYuanToCents('-1250.50')).toBe(-125050)
    expect(signedYuanToCents('300')).toBe(30000)
  })
})

function requestInitBody(call: [RequestInfo | URL, RequestInit?] | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>
}
