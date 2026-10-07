import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpDeliveryRepository,
  type DeliveryWorkspaceRepository,
} from '../../repositories/delivery.live'

const projectCode = 'DELIVERY-RETRY'
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
const page = (item: unknown) =>
  response({ items: [item], total: 1, page: 1, page_size: 200 })
const commissioningInput = {
  started_at: '2026-10-06T10:00:00',
  ended_at: null,
  status: 'in_progress' as const,
  summary: '调试',
  issues: null,
  next_action: null,
  notes: null,
  document_version_ids: [],
}
const changeInput = {
  source: 'customer_request' as const,
  title: '变更',
  description: '说明',
  reason: '原因',
  contract_delta_cents: 100,
  estimated_cost_delta_cents: 200,
  schedule_delta_days: 1,
  proposed_on: '2026-10-06',
  notes: null,
  document_version_ids: [],
}
const acceptanceInput = {
  acceptance_type: 'pre_acceptance' as const,
  scheduled_on: '2026-10-06',
  notes: null,
}
const warrantyInput = {
  starts_on: '2026-10-06',
  duration_months: 12,
  renewal_price_cents: null,
  notes: null,
}
const invoiceInput = {
  invoice_type: 'contract_payment' as const,
  status: 'planned' as const,
  requested_on: null,
  recorded_on: null,
  invoice_number: 'FP-1',
  amount_cents: null,
  counterparty_name: null,
  notes: null,
  document_version_ids: [],
}
const afterSalesInput = {
  reported_on: '2026-10-06',
  service_on: null,
  reason: '报修',
  contact_name: '客户',
  contact_phone: '',
  coverage_type: 'paid' as const,
  notes: null,
}
const signoffInput = {
  status: 'confirmed' as const,
  confirmed_on: '2026-10-06',
  not_required_reason: null,
  notes: null,
  document_version_ids: [],
}
function fixture() {
  let revision = 1
  let attempt = 0
  let rejection = 0
  const base = () => ({
    id: 1,
    project_code: projectCode,
    revision,
    created_at: '',
    updated_at: '',
  })
  const data = () => ({
    signoff: { ...base(), discipline: 'mechanical', ...signoffInput },
    commissioning: { ...base(), ...commissioningInput },
    change: { ...base(), ...changeInput, change_number: 1, status: 'proposed' },
    acceptance: {
      ...base(),
      ...acceptanceInput,
      performed_on: null,
      status: 'scheduled',
      document_version_ids: [],
      cancel_reason: null,
      cancelled_at: null,
    },
    warranty: {
      ...base(),
      ...warrantyInput,
      project_id: 1,
      acceptance_id: 1,
      ends_on: '2027-10-05',
      days_remaining: 364,
      status: 'active',
    },
    invoice: { ...base(), ...invoiceInput, void_reason: null },
    afterSales: {
      ...base(),
      ...afterSalesInput,
      status: 'open',
      is_under_warranty: false,
      resolution: null,
      completed_at: null,
      document_version_ids: [],
    },
  })
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (request, init) => {
      const path = String(request)
      const current = data()
      const write = init?.method === 'POST' || init?.method === 'PUT'
      if (write) {
        attempt += 1
        if (attempt === 1) {
          if (rejection) return response({ detail: '无效请求' }, rejection)
          throw new TypeError('response lost')
        }
      }
      if (path.includes('drawing-signoffs'))
        return response(write ? current.signoff : [current.signoff])
      if (path.includes('commissioning-sessions'))
        return write
          ? response(current.commissioning)
          : page(current.commissioning)
      if (path.includes('engineering-changes'))
        return write ? response(current.change) : page(current.change)
      if (path.endsWith('/complete'))
        return response({
          acceptance: current.acceptance,
          warranty: current.warranty,
        })
      if (path.includes('acceptances'))
        return write ? response(current.acceptance) : page(current.acceptance)
      if (path.includes('warranty')) return response(current.warranty)
      if (path.includes('invoices'))
        return write ? response(current.invoice) : page(current.invoice)
      if (path.includes('after-sales'))
        return write ? response(current.afterSales) : page(current.afterSales)
      throw new Error(`unexpected ${path}`)
    })
  vi.stubGlobal('fetch', fetchMock)
  return {
    setRevision: (value: number) => {
      revision = value
    },
    rejectFirst: (status: number) => {
      rejection = status
    },
    writes: () =>
      fetchMock.mock.calls
        .filter(([, init]) => ['POST', 'PUT'].includes(init?.method ?? ''))
        .map(([, init]) => init!),
  }
}
function payload(init: RequestInit) {
  return init.body instanceof FormData
    ? JSON.parse(String(init.body.get('payload')))
    : JSON.parse(String(init.body))
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('交付修改操作原样重试', () => {
  const cases: {
    name: string
    send: (repository: DeliveryWorkspaceRepository, file: File) => Promise<void>
  }[] = [
    {
      name: '图纸会签附件',
      send: (repository, file) =>
        repository.saveDrawingSignoff(projectCode, 'mechanical', signoffInput, [
          file,
        ]),
    },
    {
      name: '调试编辑',
      send: (repository) =>
        repository.updateCommissioningSession(
          projectCode,
          1,
          commissioningInput,
        ),
    },
    {
      name: '工程变更编辑',
      send: (repository) =>
        repository.updateEngineeringChange(projectCode, 1, changeInput),
    },
    {
      name: '工程变更状态',
      send: (repository) =>
        repository.setEngineeringChangeStatus(
          projectCode,
          1,
          'approved',
          '同意',
        ),
    },
    {
      name: '验收改期',
      send: (repository) =>
        repository.rescheduleAcceptance(
          projectCode,
          1,
          acceptanceInput,
          '调整日期',
        ),
    },
    {
      name: '取消验收',
      send: (repository) =>
        repository.cancelAcceptance(projectCode, 1, '客户取消'),
    },
    {
      name: '验收完成附件',
      send: (repository, file) =>
        repository.completeAcceptance(
          projectCode,
          1,
          {
            status: 'passed',
            performed_on: '2026-10-06',
            notes: null,
            document_version_ids: [],
          },
          [file],
        ),
    },
    {
      name: '质保修改',
      send: (repository) =>
        repository.updateWarranty(projectCode, warrantyInput),
    },
    {
      name: '发票修改',
      send: (repository) =>
        repository.updateInvoice(projectCode, 1, invoiceInput),
    },
    {
      name: '作废发票',
      send: (repository) => repository.voidInvoice(projectCode, 1, '重复'),
    },
    {
      name: '售后修改',
      send: (repository) =>
        repository.updateAfterSalesCase(projectCode, 1, afterSalesInput),
    },
    {
      name: '售后处理',
      send: (repository) =>
        repository.setAfterSalesStatus(projectCode, 1, 'completed', '已修复'),
    },
  ]
  it.each(cases)(
    '$name 跨日刷新重试复用原 body、版本及幂等键',
    async ({ send }) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-06T10:00:00+08:00'))
      const server = fixture()
      const repository = createHttpDeliveryRepository()
      const file = new File(['proof'], 'proof.pdf', { type: 'application/pdf' })
      await repository.getDeliveryPreview(projectCode)
      await expect(send(repository, file)).rejects.toThrow('无法连接本地服务')
      const first = server.writes()[0]!
      vi.setSystemTime(new Date('2026-10-07T12:00:00+08:00'))
      server.setRevision(8)
      await repository.getDeliveryPreview(projectCode)
      await send(repository, file)
      const retry = server.writes()[1]!
      expect(payload(retry)).toEqual(payload(first))
      expect(payload(retry).expected_revision).toBe(1)
      expect(new Headers(retry.headers).get('Idempotency-Key')).toBe(
        new Headers(first.headers).get('Idempotency-Key'),
      )
      if (retry.body instanceof FormData)
        expect(retry.body.getAll('files')).toEqual([file])
    },
  )
  it('明确拒绝后释放载荷，不同意图可重新提交', async () => {
    const server = fixture()
    server.rejectFirst(422)
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview(projectCode)
    await expect(
      repository.setEngineeringChangeStatus(projectCode, 1, 'approved', '同意'),
    ).rejects.toThrow('无效请求')
    server.setRevision(8)
    await repository.getDeliveryPreview(projectCode)
    await repository.setEngineeringChangeStatus(
      projectCode,
      1,
      'cancelled',
      '取消',
    )
    expect(payload(server.writes()[1]!)).toMatchObject({
      to_status: 'cancelled',
      expected_revision: 8,
    })
  })
  it('未知结果不能替换原附件，即使新文件的元数据相同', async () => {
    const server = fixture()
    const repository = createHttpDeliveryRepository()
    await repository.getDeliveryPreview(projectCode)
    const first = new File(['same'], 'proof.pdf', { lastModified: 1 })
    await expect(
      repository.saveDrawingSignoff(projectCode, 'mechanical', signoffInput, [
        first,
      ]),
    ).rejects.toThrow('无法连接本地服务')
    await expect(
      repository.saveDrawingSignoff(projectCode, 'mechanical', signoffInput, [
        new File(['same'], 'proof.pdf', { lastModified: 1 }),
      ]),
    ).rejects.toThrow('上一笔请求结果未知')
    expect(server.writes()).toHaveLength(1)
    await repository.saveDrawingSignoff(
      projectCode,
      'mechanical',
      signoffInput,
      [first],
    )
    expect(server.writes()).toHaveLength(2)
  })
})
