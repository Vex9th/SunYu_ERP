import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createHttpProjectOperatingRepository } from '../repositories/project-operating.live'

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
}

function expectUuidKey(init: RequestInit): string {
  const key = (init.headers as Record<string, string>)['Idempotency-Key']
  expect(key).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  return key
}

describe('项目经营真实 Repository 契约', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('总仪表台和项目仪表台只读取冻结真实 URL', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()

    await repository.getGlobalDashboard()
    expect(lastRequest(fetchMock)).toEqual([
      '/api/dashboard',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    ])

    await repository.getProjectDashboard('SY 2026/001')
    expect(lastRequest(fetchMock)).toEqual([
      '/api/projects/SY%202026%2F001/dashboard',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    ])
  })

  it('项目编辑走 PUT，项目完结 POST 带幂等键', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()

    const update = {
      company_id: 3,
      name: '装配线升级',
      description: null,
      expected_revision: 4,
    }
    await repository.updateProject('SY/001', update)
    const [updatePath, updateInit] = lastRequest(fetchMock)
    expect(updatePath).toBe('/api/projects/SY%2F001')
    expect(updateInit.method).toBe('PUT')
    expect(JSON.parse(String(updateInit.body))).toEqual(update)

    const close = { closure_type: 'completed' as const, reason: '验收完成', expected_revision: 5 }
    await repository.closeProject('SY/001', close)
    const [closePath, closeInit] = lastRequest(fetchMock)
    expect(closePath).toBe('/api/projects/SY%2F001/close')
    expect(closeInit.method).toBe('POST')
    expectUuidKey(closeInit)
    expect(JSON.parse(String(closeInit.body))).toEqual(close)
  })

  it('文档新建和追加版本使用 multipart，不手写 Content-Type，并携带幂等键', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()
    const firstFile = new File(['first'], 'survey v1.dwg', { type: 'application/acad' })

    await repository.createDocument('SY/001', {
      category: 'site_survey',
      title: '现场测绘',
      notes: null,
      file: firstFile,
    })
    const [createPath, createInit] = lastRequest(fetchMock)
    expect(createPath).toBe('/api/projects/SY%2F001/documents')
    expect(createInit.method).toBe('POST')
    expectUuidKey(createInit)
    expect((createInit.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    const createBody = createInit.body as FormData
    expect(createBody.get('category')).toBe('site_survey')
    expect(createBody.get('title')).toBe('现场测绘')
    expect(createBody.has('notes')).toBe(false)
    expect(createBody.get('file')).toBe(firstFile)

    const nextFile = new File(['next'], 'survey-v2.dwg', { type: 'application/acad' })
    await repository.addDocumentVersion('SY/001', 12, {
      notes: '客户复核',
      expected_revision: 2,
      file: nextFile,
    })
    const [versionPath, versionInit] = lastRequest(fetchMock)
    expect(versionPath).toBe('/api/projects/SY%2F001/documents/12/versions')
    expect(versionInit.method).toBe('POST')
    expectUuidKey(versionInit)
    const versionBody = versionInit.body as FormData
    expect(versionBody.get('notes')).toBe('客户复核')
    expect(versionBody.get('expected_revision')).toBe('2')
    expect(versionBody.get('file')).toBe(nextFile)
  })

  it('相同文档上传在未知结果后重试复用幂等键', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()
    const input = {
      category: 'contract',
      title: '主合同',
      notes: null,
      file: new File(['contract'], 'contract.pdf', { type: 'application/pdf' }),
    }

    await expect(repository.createDocument('SY-001', input)).rejects.toThrow('无法连接本地服务')
    const firstKey = expectUuidKey(lastRequest(fetchMock)[1])
    await repository.createDocument('SY-001', input)
    expect(expectUuidKey(lastRequest(fetchMock)[1])).toBe(firstKey)
  })

  it('写入成功后清除 JSON 和 multipart 的 pending 幂等请求', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()
    const receipt = {
      contract_allocation_id: null,
      milestone: 'advance' as const,
      received_on: '2026-08-31',
      amount_cents: 1280000,
      payment_method: 'bank_transfer' as const,
      reference_no: null,
      notes: null,
    }

    await repository.createReceipt('SY-001', receipt)
    const firstReceiptKey = expectUuidKey(lastRequest(fetchMock)[1])
    await repository.createReceipt('SY-001', receipt)
    expect(expectUuidKey(lastRequest(fetchMock)[1])).not.toBe(firstReceiptKey)

    const version = {
      notes: null,
      expected_revision: 2,
      file: new File(['v2'], 'survey-v2.dwg', { type: 'application/acad' }),
    }
    await repository.addDocumentVersion('SY-001', 12, version)
    const firstVersionKey = expectUuidKey(lastRequest(fetchMock)[1])
    await repository.addDocumentVersion('SY-001', 12, version)
    expect(expectUuidKey(lastRequest(fetchMock)[1])).not.toBe(firstVersionKey)
  })

  it('文档列表、详情、编辑、归档和下载使用当前项目路径', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 1, page_size: 100 }))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }))
      .mockResolvedValueOnce(jsonResponse({ id: 12 }))
      .mockResolvedValueOnce(new Response('download', {
        headers: { 'Content-Type': 'application/pdf' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()

    await repository.listDocuments('SY/001')
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/documents?page=1&page_size=100')
    await repository.getDocument('SY/001', 12)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/documents/12')
    await repository.updateDocument('SY/001', 12, {
      title: '更新标题', notes: null, expected_revision: 2,
    })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')
    await repository.archiveDocument('SY/001', 12, { reason: '已替代', expected_revision: 3 })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/documents/12/archive')
    expectUuidKey(lastRequest(fetchMock)[1])
    const downloaded = await repository.downloadDocumentVersion('SY/001', 12, 31)
    expect({ size: downloaded.size, type: downloaded.type }).toEqual({
      size: 8,
      type: 'application/pdf',
    })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/documents/12/versions/31/download')
  })

  it('文档、报价和合同会读取全部分页而不是只取前100条', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = String(input)
      const page = path.includes('page=2') ? 2 : 1
      const resource = path.includes('/documents')
        ? 'document'
        : path.includes('/quotes')
          ? 'quote'
          : 'contract'
      return jsonResponse({
        items: [{ id: page, resource }],
        total: 101,
        page,
        page_size: 100,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()

    await expect(repository.listDocuments('SY-001')).resolves.toMatchObject({
      items: [{ id: 1 }, { id: 2 }], total: 101, page: 1, page_size: 100,
    })
    await expect(repository.listQuotes('SY-001')).resolves.toMatchObject({
      items: [{ id: 1 }, { id: 2 }], total: 101, page: 1, page_size: 100,
    })
    await expect(repository.listContracts('SY-001')).resolves.toMatchObject({
      items: [{ id: 1 }, { id: 2 }], total: 101, page: 1, page_size: 100,
    })

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      '/api/projects/SY-001/documents?page=1&page_size=100',
      '/api/projects/SY-001/documents?page=2&page_size=100',
      '/api/projects/SY-001/quotes?page=1&page_size=100',
      '/api/projects/SY-001/quotes?page=2&page_size=100',
      '/api/projects/SY-001/contracts?page=1&page_size=100',
      '/api/projects/SY-001/contracts?page=2&page_size=100',
    ])
  })

  it('报价、合同、付款计划和到账接口提交精确字段', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse())
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectOperatingRepository()

    await repository.listQuotes('SY/001')
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/quotes?page=1&page_size=100')
    const quote = {
      quote_date: '2026-08-31', amount_cents: 1280000, valid_until: null,
      notes: null, document_version_ids: [31],
    }
    await repository.createQuote('SY/001', quote)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/quotes')
    expectUuidKey(lastRequest(fetchMock)[1])
    await repository.updateQuote('SY/001', 7, { ...quote, expected_revision: 2 })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')
    await repository.transitionQuote('SY/001', 7, {
      to_status: 'sent', occurred_at: '2026-08-31T10:00:00+08:00', reason: null,
      expected_revision: 3,
    })
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/quotes/7/transition')
    expectUuidKey(lastRequest(fetchMock)[1])

    await repository.listContracts('SY/001')
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/contracts?page=1&page_size=100')
    const contract = {
      contract_no: 'HT-001', title: '项目合同', customer_company_id: 3,
      signed_on: null, total_amount_cents: 1280000, final_delivery_on: null,
      allocations: [{ project_code: 'SY/001', amount_cents: 1280000 }],
      notes: null, document_version_ids: [31],
    }
    await repository.createContract('SY/001', contract)
    expectUuidKey(lastRequest(fetchMock)[1])
    await repository.updateContract('SY/001', 8, { ...contract, expected_revision: 4 })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')
    await repository.transitionContract('SY/001', 8, {
      to_status: 'signed', occurred_at: '2026-08-31T10:00:00+08:00', reason: null,
      expected_revision: 5,
    })
    expectUuidKey(lastRequest(fetchMock)[1])

    await repository.getPayments('SY/001')
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/payments')
    await repository.putPaymentTerm('SY/001', 'advance', {
      due_on: '2026-09-01', planned_amount_cents: 400000, notes: null,
      expected_revision: null,
    })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')

    const receipt = {
      contract_allocation_id: 11, milestone: 'advance' as const,
      received_on: '2026-09-01', amount_cents: 400000,
      payment_method: 'bank_transfer' as const, reference_no: null, notes: null,
    }
    await repository.createReceipt('SY/001', receipt)
    expect(lastRequest(fetchMock)[0]).toBe('/api/projects/SY%2F001/receipts')
    expectUuidKey(lastRequest(fetchMock)[1])
    await repository.updateReceipt('SY/001', 9, {
      reference_no: 'BANK-9', notes: null, expected_revision: 1,
    })
    expect(lastRequest(fetchMock)[1].method).toBe('PUT')
    await repository.voidReceipt('SY/001', 9, {
      voided_on: '2026-09-02', reason: '录入错误', expected_revision: 2,
    })
    expectUuidKey(lastRequest(fetchMock)[1])
  })
})
