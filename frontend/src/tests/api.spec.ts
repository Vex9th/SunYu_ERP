import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  requestBlob,
  createPlannedPostRequest,
  createRetriableMultipartPostSender,
  createRetriablePostSender,
  requestJson,
  requestVoid,
  subscribeProtectedSessionExpired,
  withQuery,
} from '../api'

describe('API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('本地接口超过请求时限后中止并返回可重试提示', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const request = requestJson('/api/slow', { timeoutMs: 25 })
    const rejection = expect(request).rejects.toEqual(
      new ApiError('请求超时，请重试', 0, 'REQUEST_TIMEOUT'),
    )
    await vi.advanceTimersByTimeAsync(25)

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await rejection
  })

  it('任意受保护接口 401 广播统一会话失效，但登录失败不广播', async () => {
    const expired = vi.fn()
    const unsubscribe = subscribeProtectedSessionExpired(expired)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Authentication required' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Invalid password' }), { status: 401 })))

    await expect(requestJson('/api/inventory/items')).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledTimes(1)
    expect(expired.mock.calls[0]?.[0]).toMatchObject({
      message: '登录状态已失效，请重新登录',
      path: '/api/inventory/items',
    })

    await expect(requestVoid('/api/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledTimes(1)
    unsubscribe()
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
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

  it('5xx 后重试语义相同的请求会复用 Idempotency-Key', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Service unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', {
      amount_cents: 1280000,
      receipt_type: 'advance',
    })).rejects.toMatchObject({ status: 503 })
    await expect(sender.send('/api/projects/SY-1/receipts', {
      receipt_type: 'advance',
      amount_cents: 1280000,
    })).resolves.toEqual({ id: 1 })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
  })

  it('网络异常后重试会复用 Idempotency-Key', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .rejects.toMatchObject({ status: 0 })
    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .resolves.toEqual({ id: 1 })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
  })

  it('服务端成功状态但返回结果未知时，重试会复用 Idempotency-Key', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .rejects.toBeInstanceOf(SyntaxError)
    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .resolves.toEqual({ id: 1 })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
  })

  it('成功后清理 pending，同一 payload 的下次提交使用新键', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 })
    await sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
    })
  })

  it.each([400, 401, 403, 404, 409, 422])(
    '%i 后清理 pending，同一 payload 的下次提交使用新键',
    async (status) => {
      const randomUUID = vi.spyOn(crypto, 'randomUUID')
        .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
        .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Rejected' }), { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
      vi.stubGlobal('fetch', fetchMock)
      const sender = createRetriablePostSender()

      await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
        .rejects.toMatchObject({ status })
      await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
        .resolves.toEqual({ id: 1 })

      expect(randomUUID).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
      })
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
      })
    },
  )

  it.each([408, 425, 429])('%i 结果不确定时保留 pending 并复用原键', async (status) => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Retry later' }), { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .rejects.toMatchObject({ status })
    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .resolves.toEqual({ id: 1 })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
  })

  it('重试待定期间同一路径改变 payload 必须先明确放弃原请求', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 }))
      .rejects.toMatchObject({ status: 0 })
    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 2560000 }))
      .rejects.toThrow('上一笔请求结果未知，只能原样重试或先明确放弃')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(sender.discard('/api/projects/SY-1/receipts', { amount_cents: 1280000 })).toBe(true)
    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 2560000 }))
      .resolves.toEqual({ id: 2 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
    })
  })

  it('数组顺序改变也不能绕过结果未知的原请求', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', { amounts: [1280000, 2560000] }))
      .rejects.toMatchObject({ status: 0 })
    await expect(sender.send('/api/projects/SY-1/receipts', { amounts: [2560000, 1280000] }))
      .rejects.toThrow('上一笔请求结果未知，只能原样重试或先明确放弃')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sender.discard('/api/projects/SY-1/receipts', { amounts: [1280000, 2560000] }))
      .toBe(true)
    await expect(sender.send('/api/projects/SY-1/receipts', { amounts: [2560000, 1280000] }))
      .resolves.toEqual({ id: 2 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
    })
  })

  it('同一路径和 payload 的并发提交复用同一 Promise', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('018f3e40-1234-7000-8000-123456789abc')
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    const first = sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 })
    const second = sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 })

    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledOnce()
    resolveFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    await expect(first).resolves.toEqual({ id: 1 })
  })

  it('同一路径正在提交时不允许另一个 payload 静默覆盖', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('018f3e40-1234-7000-8000-123456789abc')
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))
    const sender = createRetriablePostSender()
    const first = sender.send('/api/projects/SY-1/receipts', { amount_cents: 1280000 })

    await expect(sender.send('/api/projects/SY-1/receipts', { amount_cents: 2560000 }))
      .rejects.toThrow('该路径已有其他请求正在提交')

    resolveFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    await first
  })

  it('循环引用的 JSON 请求体返回 rejected Promise 且不发起请求', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()
    const body: Record<string, unknown> = {}
    body.self = body

    await expect(sender.send('/api/projects/SY-1/receipts', body))
      .rejects.toThrow('POST 请求体必须是无循环引用的 JSON 兼容值')
    expect(randomUUID).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('稀疏数组返回 rejected Promise，避免签名与实际 JSON body 不一致', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', Array(1)))
      .rejects.toThrow('POST 请求体必须是无循环引用的 JSON 兼容值')
    expect(randomUUID).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('带 accessor 的对象返回 rejected Promise 且不读取 getter', async () => {
    const getter = vi.fn(() => 1280000)
    const body: Record<string, unknown> = {}
    Object.defineProperty(body, 'amount_cents', {
      enumerable: true,
      get: getter,
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    ))
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', body))
      .rejects.toThrow('POST 请求体必须是无循环引用的 JSON 兼容值')
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['toJSON', 'hidden'])('带非枚举自有属性 %s 的对象返回 rejected Promise', async (propertyName) => {
    const body: Record<string, unknown> = { amount_cents: 1280000 }
    Object.defineProperty(body, propertyName, {
      enumerable: false,
      value: propertyName === 'toJSON' ? () => ({ amount_cents: 2560000 }) : 'metadata',
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    ))
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', body))
      .rejects.toThrow('POST 请求体必须是无循环引用的 JSON 兼容值')
  })

  it('带 symbol 自有键的对象返回 rejected Promise', async () => {
    const body: Record<PropertyKey, unknown> = { amount_cents: 1280000 }
    body[Symbol('metadata')] = 'hidden'
    const sender = createRetriablePostSender()

    await expect(sender.send('/api/projects/SY-1/receipts', body))
      .rejects.toThrow('POST 请求体必须是无循环引用的 JSON 兼容值')
  })

  it('未知结果 pending 可按动态 path 和语义匹配 body 显式放弃', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriablePostSender()
    const path = '/api/projects/SY-2026-009/receipts'

    await expect(sender.send(path, { amount_cents: 1280000, receipt_type: 'advance' }))
      .rejects.toMatchObject({ status: 0 })
    expect(sender.discard('/api/projects/SY-2026-010/receipts')).toBe(false)
    expect(sender.discard(path, { amount_cents: 2560000, receipt_type: 'advance' })).toBe(false)
    expect(sender.discard(path, { receipt_type: 'advance', amount_cents: 1280000 })).toBe(true)
    await expect(sender.send(path, { amount_cents: 1280000, receipt_type: 'advance' }))
      .resolves.toEqual({ id: 1 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
    })
  })

  it('不传 body 时可显式放弃指定 path 的未知结果 pending', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network disconnected')))
    const sender = createRetriablePostSender()
    const path = '/api/projects/SY-2026-011/receipts'

    await expect(sender.send(path, { amount_cents: 1280000 })).rejects.toMatchObject({ status: 0 })

    expect(sender.discard(path)).toBe(true)
    expect(sender.discard(path)).toBe(false)
  })

  it('仍在 in-flight 的请求不允许显式放弃', async () => {
    let resolveFetch!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })))
    const sender = createRetriablePostSender()
    const path = '/api/projects/SY-2026-012/receipts'
    const body = { amount_cents: 1280000 }

    const inFlight = sender.send(path, body)

    expect(sender.discard(path)).toBe(false)
    expect(sender.discard(path, body)).toBe(false)
    resolveFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    await inFlight
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
      signal: expect.any(AbortSignal),
    })
  })

  it('业务附件 multipart 精确发送 JSON payload 和重复 files', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('018f3e40-1234-7000-8000-123456789abc')
    const sender = createRetriableMultipartPostSender()
    const payload = { amount_cents: null, notes: '图片登记' }
    const files = [
      new File(['pdf'], '发票.pdf', { type: 'application/pdf', lastModified: 10 }),
      new File(['image'], '发票.jpg', { type: 'image/jpeg', lastModified: 20 }),
    ]

    await sender.send('/api/projects/SY-1/invoices', payload, files)

    const request = fetchMock.mock.calls[0]?.[1]
    expect(request?.headers).toEqual({
      'Idempotency-Key': '018f3e40-1234-7000-8000-123456789abc',
    })
    expect(request?.body).toBeInstanceOf(FormData)
    const form = request?.body as FormData
    expect(form.get('payload')).toBe(JSON.stringify(payload))
    expect(form.getAll('files')).toEqual(files)
  })

  it('业务附件网络失败重试复用键且同内容并发合并', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriableMultipartPostSender()
    const payload = { invoice_number: null }
    const firstFile = new File(['pdf'], '发票.pdf', {
      type: 'application/pdf',
      lastModified: 10,
    })

    await expect(sender.send('/api/projects/SY-1/invoices', payload, [firstFile]))
      .rejects.toMatchObject({ status: 0 })
    const retry = sender.send('/api/projects/SY-1/invoices', { invoice_number: null }, [firstFile])
    const concurrent = sender.send('/api/projects/SY-1/invoices', payload, [firstFile])

    expect(concurrent).toBe(retry)
    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(fetchMock.mock.calls[1]?.[1]?.headers)
    resolveFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    await expect(retry).resolves.toEqual({ id: 1 })
  })

  it('不同 File 即使元数据相同也不会合并 inflight', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('018f3e40-1234-7000-8000-123456789abc')
    let resolveFetch!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => { resolveFetch = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriableMultipartPostSender()
    const path = '/api/projects/SY-1/invoices'
    const first = sender.send(path, { notes: null }, [
      new File(['aaa'], '发票.pdf', { type: 'application/pdf', lastModified: 10 }),
    ])

    const second = sender.send(path, { notes: null }, [
      new File(['bbb'], '发票.pdf', { type: 'application/pdf', lastModified: 10 }),
    ])
    expect(fetchMock).toHaveBeenCalledOnce()

    resolveFetch(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrow('该路径已有其他文件正在上传')
    await expect(first).resolves.toEqual({ id: 1 })
  })

  it('网络失败后不同 File 必须先明确放弃原上传', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriableMultipartPostSender()
    const path = '/api/projects/SY-1/invoices'

    const originalFile = new File(['aaa'], '发票.pdf', {
      type: 'application/pdf',
      lastModified: 10,
    })
    const changedFile = new File(['bbb'], '发票.pdf', {
      type: 'application/pdf',
      lastModified: 10,
    })
    await expect(sender.send(path, { notes: null }, [originalFile]))
      .rejects.toMatchObject({ status: 0 })
    await expect(sender.send(path, { notes: null }, [changedFile]))
      .rejects.toThrow('上一笔上传结果未知，只能原样重试或先明确放弃')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sender.discard(path, { notes: null }, [originalFile])).toBe(true)
    await expect(sender.send(path, { notes: null }, [changedFile]))
      .resolves.toEqual({ id: 2 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toEqual(fetchMock.mock.calls[1]?.[1]?.headers)
  })

  it('业务附件确定性 4xx 后相同内容重试生成新键', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-123456789abc')
      .mockReturnValueOnce('018f3e40-1234-7000-8000-abcdefabcdef')
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Rejected' }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriableMultipartPostSender()
    const file = new File(['pdf'], '发票.pdf', { type: 'application/pdf', lastModified: 10 })

    await expect(sender.send('/api/projects/SY-1/invoices', { notes: null }, [file]))
      .rejects.toMatchObject({ status: 422 })
    await expect(sender.send('/api/projects/SY-1/invoices', { notes: null }, [file]))
      .resolves.toEqual({ id: 2 })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      'Idempotency-Key': '018f3e40-1234-7000-8000-abcdefabcdef',
    })
  })

  it('业务附件 5xx 后相同内容重试复用原键', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '018f3e40-1234-7000-8000-123456789abc',
    )
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 2 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const sender = createRetriableMultipartPostSender()
    const path = '/api/projects/SY-1/invoices'
    const payload = { notes: null }
    const file = new File(['pdf'], '发票.pdf', {
      type: 'application/pdf',
      lastModified: 10,
    })

    await expect(sender.send(path, payload, [file])).rejects.toMatchObject({ status: 503 })
    await expect(sender.send(path, payload, [file])).resolves.toEqual({ id: 2 })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(fetchMock.mock.calls[1]?.[1]?.headers)
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
      signal: expect.any(AbortSignal),
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
