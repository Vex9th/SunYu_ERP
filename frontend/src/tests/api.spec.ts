import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  requestBlob,
  createPlannedPostRequest,
  requestJson,
  requestVoid,
  withQuery,
} from '../api'

describe('API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('统一使用同源凭证和 JSON 请求头', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)

    await requestJson<{ ok: boolean }>('/api/test', {
      method: 'POST',
      body: { value: 1 },
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    })
  })

  it('JSON 请求合并自定义 Header，允许 Repository 发送幂等键', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 1 })))
    vi.stubGlobal('fetch', fetchMock)

    await requestJson('/api/projects/SY-1/receipts', {
      method: 'POST',
      headers: { 'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc' },
      body: { amount_cents: 1280000 },
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/SY-1/receipts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
      },
      body: JSON.stringify({ amount_cents: 1280000 }),
    })
  })

  it('规划中的 POST 创建可重试请求，同一业务提交复用 Idempotency-Key', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const request = createPlannedPostRequest<{ id: number }>(
      '/api/projects/SY-1/receipts',
      { amount_cents: 1280000 },
    )
    await request.send()
    await request.send()

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/SY-1/receipts', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
      },
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/SY-1/receipts', expect.objectContaining({
      headers: expect.objectContaining({
        'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
      }),
    }))
  })

  it('自定义 content-type 大小写不同时不重复追加 JSON 媒体类型', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)

    await requestJson('/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/problem+json' },
      body: { value: 1 },
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      headers: { 'content-type': 'application/problem+json' },
    }))
  })

  it('multipart 请求保留 FormData 且不手工设置 Content-Type', async () => {
    const body = new FormData()
    body.append('category', 'contract')
    body.append('file', new Blob(['contract']), 'contract.pdf')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await requestJson('/api/projects/SY-1/documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc' },
      body,
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/SY-1/documents', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc' },
      body,
    })
  })

  it('读取 Blob 下载内容，不假设契约未冻结的文件名传输方式', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      new Blob(['xlsx'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E9%87%87%E8%B4%AD%E6%A8%A1%E6%9D%BF.xlsx" } },
    )))

    const blob = await requestBlob('/api/procurement/import-template.xlsx')

    expect(blob.size).toBeGreaterThan(0)
  })

  it('requestJson 对 204 返回 undefined 而不是解析空响应体', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })))

    await expect(requestJson<undefined>('/api/test', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('分页查询只编码有值参数', () => {
    expect(withQuery('/api/workers', {
      page: 2,
      page_size: 50,
      status: 'active',
      query: '王 工',
      worker_id: null,
    })).toBe('/api/workers?page=2&page_size=50&status=active&query=%E7%8E%8B+%E5%B7%A5')
  })

  it('支持 DELETE 请求且不发送空请求体', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await requestVoid('/api/companies/7', { method: 'DELETE' })

    expect(fetchMock).toHaveBeenCalledWith('/api/companies/7', {
      method: 'DELETE',
      credentials: 'same-origin',
    })
  })

  it('将 FastAPI detail 转为可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: '备份目录不可写' }), { status: 400 }),
        ),
    )

    await expect(requestVoid('/api/test')).rejects.toEqual(
      new ApiError('备份目录不可写', 400),
    )
  })

  it('保留结构化错误码、字段错误和当前 revision', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      detail: 'Resource was modified',
      error_code: 'REVISION_CONFLICT',
      field_errors: { name: ['名称已被其他会话修改'] },
      current_revision: 3,
    }), { status: 409 })))

    try {
      await requestVoid('/api/projects/SY-1')
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({
        message: '数据已被其他操作修改，请刷新后重试',
        status: 409,
        errorCode: 'REVISION_CONFLICT',
        fieldErrors: { name: ['名称已被其他会话修改'] },
        currentRevision: 3,
      })
    }
  })

  it.each([
    ['Authentication required', '登录状态已失效，请重新登录'],
    ['Invalid password', '密码错误'],
    ['Too many login attempts', '登录尝试过于频繁，请稍后再试'],
    ['Invalid company payload', '公司资料格式不正确'],
    ['Company name already exists', '公司名称已存在'],
    ['Company is referenced by projects', '公司已被项目使用，无法删除'],
    ['Contact not found', '未找到联系人'],
    ['Invalid project payload', '项目资料格式不正确'],
    ['Project code already exists', '项目编号已存在'],
    ['Project not found', '未找到项目'],
    ['Invalid backup settings', '备份设置无效'],
    ['Backup operation failed', '备份操作失败'],
  ])('将后端固定错误 %s 映射为中文', async (detail, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ detail }), { status: 422 }),
      ),
    )

    await expect(requestVoid('/api/test')).rejects.toEqual(new ApiError(expected, 422))
  })

  it('保留未知后端 detail 原文便于诊断', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Unexpected upstream response' }), { status: 503 }),
      ),
    )

    await expect(requestVoid('/api/test')).rejects.toEqual(
      new ApiError('Unexpected upstream response', 503),
    )
  })

  it('非标准错误响应仍提供稳定提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('bad gateway', { status: 502 })),
    )

    await expect(requestJson('/api/test')).rejects.toEqual(
      new ApiError('请求失败（502）', 502),
    )
  })
})
