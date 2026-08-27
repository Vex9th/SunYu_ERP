import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, requestJson, requestVoid } from '../api'

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
