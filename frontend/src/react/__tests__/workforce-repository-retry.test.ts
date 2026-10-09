import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpWorkforceWorkspaceRepository,
  type WorkforceWorkspaceRepository,
} from '../../repositories/workforce.live'

const projectCode = 'RETRY'
const workDate = '2026-10-06'
const body = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
const page = (items: unknown[]) =>
  body({ items, total: items.length, page: 1, page_size: 200 })
function fixture() {
  let revision = 1
  let attempts = 0
  let firstRejection = 0
  const worker = () => ({
    id: 1,
    name: '施工员',
    phone: null,
    notes: null,
    status: 'active',
    revision,
    created_at: '',
    updated_at: '',
  })
  const assignment = () => ({
    id: 7,
    project_code: projectCode,
    worker_id: 1,
    worker_name: '施工员',
    role: '电工',
    scheduled_start_on: workDate,
    scheduled_end_on: '2026-12-31',
    pay_basis: 'daily',
    rate_cents: 30000,
    notes: null,
    status: 'planned',
    revision,
    created_at: '',
    updated_at: '',
  })
  const labor = () => ({
    id: 9,
    project_code: projectCode,
    assignment_id: 7,
    worker_id: 1,
    worker_name: '施工员',
    work_date: workDate,
    attendance_status: 'present',
    day_fraction: '1.000',
    work_minutes: null,
    pay_basis: 'daily',
    rate_cents: 30000,
    cost_cents: 30000,
    work_summary: '安装',
    notes: null,
    status: 'active',
    void_reason: null,
    voided_at: null,
    replaces_entry_id: null,
    revision,
    created_at: '',
    updated_at: '',
  })
  const report = () => ({
    id: 4,
    project_code: projectCode,
    work_date: workDate,
    location: null,
    weather: null,
    work_summary: '安装',
    blockers: null,
    next_plan: null,
    notes: null,
    status: 'draft',
    versions: [],
    events: [],
    confirmed_at: null,
    revision,
    created_at: '',
    updated_at: '',
  })
  const reimbursement = () => ({
    id: 11,
    advance_id: 5,
    amount_cents: 1000,
    reimbursed_on: workDate,
    payment_method: 'cash',
    notes: null,
    status: 'active',
    void_reason: null,
    voided_at: null,
    revision,
    created_at: '',
    updated_at: '',
  })
  const advance = () => ({
    id: 5,
    project_code: projectCode,
    worker_id: 1,
    worker_name: '施工员',
    spent_on: workDate,
    vendor_name: '五金店',
    total_amount_cents: 2000,
    reimbursed_amount_cents: 1000,
    outstanding_amount_cents: 1000,
    notes: null,
    status: 'partial',
    void_reason: null,
    voided_at: null,
    document_version_ids: [],
    revision,
    created_at: '',
    updated_at: '',
    items: [],
    reimbursements: [reimbursement()],
  })
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (request, init) => {
      const path = String(request)
      if (init?.method === 'PUT') return body(worker())
      if (init?.method === 'POST') {
        attempts += 1
        if (attempts === 1) {
          if (firstRejection)
            return body({ detail: '无效请求' }, firstRejection)
          throw new TypeError('response lost')
        }
        if (path.includes('crew-assignments')) return body(assignment())
        if (path.includes('site-daily-reports')) return body(report())
        if (path.includes('/workers/')) return body(worker())
        if (path.endsWith('/batch'))
          return body({ work_date: workDate, items: [labor()] })
        if (path.includes('/reimbursements/'))
          return body({
            ...reimbursement(),
            advance_status: 'unreimbursed',
            advance_reimbursed_amount_cents: 0,
            advance_outstanding_amount_cents: 2000,
            advance_revision: revision,
          })
        if (path.includes('/material-advances/')) return body(advance())
        return body(labor())
      }
      if (path === '/api/workers/1') return body(worker())
      if (path.startsWith('/api/workers?')) return page([worker()])
      if (path.includes('/crew-assignments?')) return page([assignment()])
      if (path.includes('/labor-entries?')) return page([labor()])
      if (path.includes('/site-daily-reports?')) return page([report()])
      if (path.includes('/material-advances?')) return page([advance()])
      if (path.endsWith('/material-advances/5')) return body(advance())
      throw new Error(`unexpected ${path}`)
    })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    setRevision: (value: number) => {
      revision = value
    },
    rejectFirst: (status: number) => {
      firstRejection = status
    },
    writes: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => init!),
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('施工工作区生成载荷的幂等重试', () => {
  const cases: {
    name: string
    send: (repository: WorkforceWorkspaceRepository) => Promise<unknown>
  }[] = [
    {
      name: '项目安排流转',
      send: (repository) =>
        repository.setCrewAssignmentStatus(projectCode, 7, 'active', null),
    },
    {
      name: '确认施工日报',
      send: (repository) =>
        repository.confirmSiteDailyReport(projectCode, workDate),
    },
    {
      name: '重新打开日报',
      send: (repository) =>
        repository.reopenSiteDailyReport(projectCode, workDate, '更正施工内容'),
    },
    {
      name: '停用施工员',
      send: (repository) => repository.setWorkerStatus(1, 'inactive'),
    },
    {
      name: '启用施工员',
      send: (repository) => repository.setWorkerStatus(1, 'active'),
    },
    {
      name: '作废上工记录',
      send: (repository) =>
        repository.voidLaborEntry(projectCode, 9, '重复记录'),
    },
    {
      name: '作废垫资',
      send: (repository) =>
        repository.voidMaterialAdvance(projectCode, 5, '重复垫资'),
    },
    {
      name: '作废报销',
      send: (repository) =>
        repository.voidMaterialAdvanceReimbursement(
          projectCode,
          5,
          11,
          '重复报销',
        ),
    },
    {
      name: '批量上工',
      send: (repository) =>
        repository.saveLaborEntriesBatch(projectCode, {
          work_date: workDate,
          entries: [
            {
              assignment_id: 7,
              attendance_status: 'present',
              day_fraction: '1.000',
              work_minutes: null,
              work_summary: '安装',
              notes: null,
            },
          ],
        }),
    },
  ]
  it.each(cases)(
    '$name 在刷新、跨日后仍复用原时间、原版本和幂等键',
    async ({ send }) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-06T10:00:00+08:00'))
      const server = fixture()
      const repository = createHttpWorkforceWorkspaceRepository()
      await repository.getWorkforcePreview(projectCode)
      await expect(send(repository)).rejects.toThrow('无法连接本地服务')
      const first = server.writes()[0]!
      vi.setSystemTime(new Date('2026-10-07T12:00:00+08:00'))
      server.setRevision(8)
      await repository.getWorkforcePreview(projectCode)
      await send(repository)
      const retry = server.writes()[1]!
      expect(retry.body).toBe(first.body)
      expect(new Headers(retry.headers).get('Idempotency-Key')).toBe(
        new Headers(first.headers).get('Idempotency-Key'),
      )
      expect(
        JSON.parse(String(retry.body)).expected_revision ??
          JSON.parse(String(retry.body)).entries[0].expected_revision,
      ).toBe(1)
    },
  )
  it('明确拒绝后释放原载荷，下一次使用新的时间、版本号和幂等键', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T10:00:00+08:00'))
    const server = fixture()
    server.rejectFirst(422)
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview(projectCode)
    await expect(
      repository.confirmSiteDailyReport(projectCode, workDate),
    ).rejects.toThrow('无效请求')
    vi.setSystemTime(new Date('2026-10-07T12:00:00+08:00'))
    server.setRevision(8)
    await repository.getWorkforcePreview(projectCode)
    await repository.confirmSiteDailyReport(projectCode, workDate)
    const [first, next] = server.writes()
    expect(JSON.parse(String(next!.body))).toEqual({
      confirmed_at: new Date().toISOString(),
      expected_revision: 8,
    })
    expect(next!.body).not.toBe(first!.body)
    expect(new Headers(next!.headers).get('Idempotency-Key')).not.toBe(
      new Headers(first!.headers).get('Idempotency-Key'),
    )
  })
  it('结果未知时拒绝把同一安排改为另一个操作，再提交原操作仍可恢复', async () => {
    const server = fixture()
    const repository = createHttpWorkforceWorkspaceRepository()
    await repository.getWorkforcePreview(projectCode)
    await expect(
      repository.setCrewAssignmentStatus(projectCode, 7, 'active', null),
    ).rejects.toThrow('无法连接本地服务')
    await expect(
      repository.setCrewAssignmentStatus(projectCode, 7, 'cancelled', '取消'),
    ).rejects.toThrow('上一笔请求结果未知')
    expect(server.writes()).toHaveLength(1)
    await repository.setCrewAssignmentStatus(projectCode, 7, 'active', null)
    expect(server.writes()).toHaveLength(2)
  })
})

it('旧施工员表单首次提交保留打开时版本，工时保留计薪快照', async () => {
 const f = fixture(); const repo = createHttpWorkforceWorkspaceRepository()
 const original = (await repo.getWorkforcePreview(projectCode)).data
 f.setRevision(2); await repo.getWorkforcePreview(projectCode)
 await repo.updateWorker(1, { name: '更正姓名', phone: null, notes: null, expected_revision: 1 } as never)
 const write = f.fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!
 expect(JSON.parse(String(write.body)).expected_revision).toBe(1)
 expect(original.workers[0]).toMatchObject({ revision: 1 })
 expect(original.labor_entries[0]).toMatchObject({ revision: 1, pay_basis: 'daily', rate_cents: 30000 })
})

it('旧作废原因弹窗首次提交保留打开时工时版本', async () => {
  const server = fixture()
  const repository = createHttpWorkforceWorkspaceRepository()
  await repository.getWorkforcePreview(projectCode)
  server.setRevision(2)
  await repository.getWorkforcePreview(projectCode)
  await expect(repository.voidLaborEntry(projectCode, 9, '重复登记', 1)).rejects.toThrow('无法连接本地服务')
  expect(JSON.parse(String(server.writes()[0]!.body))).toMatchObject({ reason: '重复登记', expected_revision: 1 })
})
