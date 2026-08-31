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
      '/api/workers?page=1&page_size=200',
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
    await repository.getDeliveryPreview('SY-001')

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

  it('质保续费价格可为空，工程变更金额可为负数', () => {
    expect(optionalYuanToCents('')).toBeNull()
    expect(optionalYuanToCents('  ')).toBeNull()
    expect(optionalYuanToCents('1250.50')).toBe(125050)
    expect(signedYuanToCents('-1250.50')).toBe(-125050)
    expect(signedYuanToCents('300')).toBe(30000)
  })
})
