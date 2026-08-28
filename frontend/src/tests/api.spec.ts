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
