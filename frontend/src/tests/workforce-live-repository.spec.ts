import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LaborBatchInput } from '../domain/operations-api'
import {
  createHttpWorkforceRepository,
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
})
