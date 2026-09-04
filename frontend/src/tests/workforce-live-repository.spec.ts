import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LaborBatchInput } from '../domain/operations-api'
import {
  createHttpWorkforceRepository,
  createHttpWorkforceWorkspaceRepository,
  type WorkforceHttpRepository,
} from '../repositories/workforce.live'

const firstIdempotencyKey = '018f3e40-1234-7000-8000-123456789abc'
const secondIdempotencyKey = '018f3e40-1234-7000-8000-abcdefabcdef'

function laborBatchInput(): LaborBatchInput {
  return {
    work_date: '2026-08-31',
    entries: [{
      assignment_id: 7,
      attendance_status: 'present',
      day_fraction: '1.000',
      work_minutes: null,
      work_summary: '控制柜接线',
      notes: null,
      expected_revision: null,
    }],
  }
}

function successfulBatchResponse(input: LaborBatchInput): Response {
  return new Response(JSON.stringify({ work_date: input.work_date, items: [] }), { status: 200 })
}

function idempotencyKey(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined
  return (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key']
}

function page<T>(items: T[]): Response {
  return new Response(JSON.stringify({ items, total: items.length, page: 1, page_size: 200 }), { status: 200 })
}

function laborEntry(projectCode: string, id: number) {
  return {
    id,
    project_code: projectCode,
    assignment_id: id,
    worker_id: id,
    worker_name: `施工员${id}`,
    work_date: '2026-08-31',
    attendance_status: 'present',
    day_fraction: '1.000',
    work_minutes: null,
    pay_basis: 'daily',
    rate_cents: 50_000,
    cost_cents: 50_000,
    work_summary: `${projectCode} 已完成接线`,
    notes: null,
    status: 'active',
    void_reason: null,
    voided_at: null,
    replaces_entry_id: null,
    revision: 1,
    created_at: '2026-08-31T08:00:00Z',
    updated_at: '2026-08-31T08:00:00Z',
  }
}

describe('HttpWorkforceRepository 幂等重试', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each<{
    name: string
    path: string
    send: (repository: WorkforceHttpRepository) => Promise<unknown>
  }>([
    {
      name: '新建施工员',
      path: '/api/workers',
      send: (repository) => repository.createWorker({ name: '张工', phone: null, notes: null }),
    },
    {
      name: '停用施工员',
      path: '/api/workers/3/deactivate',
      send: (repository) => repository.deactivateWorker(3, {
        effective_on: '2026-08-31',
        reason: '离场',
        expected_revision: 1,
      }),
    },
    {
      name: '重新启用施工员',
      path: '/api/workers/3/reactivate',
      send: (repository) => repository.reactivateWorker(3, {
        expected_revision: 2,
      }),
    },
    {
      name: '添加项目排单',
      path: '/api/projects/SY%2F2026-001/crew-assignments',
      send: (repository) => repository.createCrewAssignment('SY/2026-001', {
        worker_id: 3,
        role: '电工',
        scheduled_start_on: '2026-08-31',
        scheduled_end_on: null,
        pay_basis: 'daily',
        rate_cents: 45_000,
        notes: null,
      }),
    },
    {
      name: '批量保存上工',
      path: '/api/projects/SY%2F2026-001/labor-entries/batch',
      send: (repository) => repository.saveLaborEntriesBatch('SY/2026-001', laborBatchInput()),
    },
    {
      name: '单条新建上工',
      path: '/api/projects/SY%2F2026-001/labor-entries',
      send: (repository) => repository.createLaborEntry('SY/2026-001', {
        assignment_id: 7,
        work_date: '2026-08-31',
        attendance_status: 'present',
        day_fraction: '1.000',
        work_minutes: null,
        work_summary: '控制柜接线',
        notes: null,
      }),
    },
    {
      name: '作废单条上工',
      path: '/api/projects/SY%2F2026-001/labor-entries/9/void',
      send: (repository) => repository.voidLaborEntry('SY/2026-001', 9, {
        reason: '重复登记',
        expected_revision: 3,
      }),
    },
    {
      name: '流转项目排单',
      path: '/api/projects/SY%2F2026-001/crew-assignments/7/transition',
      send: (repository) => repository.transitionCrewAssignment('SY/2026-001', 7, {
        to_status: 'active',
        effective_at: '2026-08-31T08:00:00.000Z',
        reason: null,
        expected_revision: 1,
      }),
    },
  ])('$name 在网络结果未知后原请求重试会复用 Idempotency-Key', async ({ path, send }) => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue(firstIdempotencyKey)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceRepository()

    await expect(send(repository)).rejects.toMatchObject({ status: 0 })
    await expect(send(repository)).resolves.toMatchObject({ source: 'live' })

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(path)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(path)
    expect(idempotencyKey(fetchMock, 0)).toBe(firstIdempotencyKey)
    expect(idempotencyKey(fetchMock, 1)).toBe(firstIdempotencyKey)
  })

  it('明确放弃结果未知的批量工时后，再提交会生成新 Idempotency-Key', async () => {
    const input = laborBatchInput()
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(firstIdempotencyKey)
      .mockReturnValueOnce(secondIdempotencyKey)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(successfulBatchResponse(input))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceRepository()

    await expect(repository.saveLaborEntriesBatch('SY-2026-002', input))
      .rejects.toMatchObject({ status: 0 })
    expect(repository.discardSaveLaborEntriesBatch('SY-2026-003', input)).toBe(false)
    expect(repository.discardSaveLaborEntriesBatch('SY-2026-002', {
      ...input,
      entries: input.entries.map((entry) => ({ ...entry, work_summary: '修改后的内容' })),
    })).toBe(false)
    expect(repository.discardSaveLaborEntriesBatch('SY-2026-002', input)).toBe(true)
    await expect(repository.saveLaborEntriesBatch('SY-2026-002', input)).resolves.toMatchObject({
      source: 'live',
      data: { work_date: input.work_date },
    })

    expect(randomUUID).toHaveBeenCalledTimes(2)
    expect(idempotencyKey(fetchMock, 0)).toBe(firstIdempotencyKey)
    expect(idempotencyKey(fetchMock, 1)).toBe(secondIdempotencyKey)
  })

  it('单条上工编辑使用 PUT 且原样携带 expected_revision', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 9, revision: 4 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceRepository()
    const input = {
      assignment_id: 7,
      work_date: '2026-08-31',
      attendance_status: 'present' as const,
      day_fraction: '0.500',
      work_minutes: null,
      work_summary: '改为半天',
      notes: null,
      expected_revision: 3,
    }

    await repository.updateLaborEntry('SY/2026-001', 9, input)

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/SY%2F2026-001/labor-entries/9')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('PUT')
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual(input)
  })
})

describe('HttpWorkforceWorkspaceRepository 局部加载容错', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('同一项目刷新时上工接口失败，保留上次成功数据并明确提示', async () => {
    let laborRequestCount = 0
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.includes('/labor-entries?')) {
        laborRequestCount += 1
        if (laborRequestCount === 2) throw new TypeError('network disconnected')
        return page([laborEntry('SY-001', 9)])
      }
      return page([])
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()

    const initial = await repository.getWorkforcePreview('SY-001')
    const refreshed = await repository.getWorkforcePreview('SY-001')

    expect(initial.data.labor_entries).toEqual([
      expect.objectContaining({ entry_id: 9, work_summary: 'SY-001 已完成接线' }),
    ])
    expect(refreshed.data.labor_entries).toEqual(initial.data.labor_entries)
    expect(refreshed.data.load_warnings).toContainEqual({
      section: 'labor_entries',
      message: expect.stringContaining('当前显示上次结果'),
    })
  })

  it('切换项目后子接口失败，不继承上一项目的数据', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.includes('/projects/A/labor-entries?')) return page([laborEntry('A', 9)])
      if (path.includes('/projects/B/labor-entries?')) throw new TypeError('network disconnected')
      return page([])
    })
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpWorkforceWorkspaceRepository()

    await repository.getWorkforcePreview('A')
    const projectB = await repository.getWorkforcePreview('B')

    expect(projectB.data.project_code).toBe('B')
    expect(projectB.data.labor_entries).toEqual([])
    expect(projectB.data.load_warnings).toContainEqual({
      section: 'labor_entries',
      message: expect.not.stringContaining('当前显示上次结果'),
    })
  })
})
