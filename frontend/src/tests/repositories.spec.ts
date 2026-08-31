import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatBasisPoints, formatMoney } from '../domain/formatters'
import {
  createHttpProjectRepository,
} from '../repositories/project'
import { createPreviewProjectRepository, MockProjectRepository } from '../repositories/project.mock'
import { MockProcurementRepository } from '../repositories/procurement'
import { MockWorkforceRepository } from '../repositories/workforce'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('contract domain formatting', () => {
  it('金额始终从整数分格式化，不接受 null 冒充零元', () => {
    expect(formatMoney(1280000)).toBe('¥12,800.00')
    expect(formatMoney(null)).toBe('--')
  })

  it('基点按百分比展示且分母为零的 null 不冒充 100%', () => {
    expect(formatBasisPoints(7015)).toBe('70.15%')
    expect(formatBasisPoints(null)).toBe('--')
  })
})

describe('repository data source boundary', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('P0 Mock Project Repository 明确返回演示数据及冻结利润口径', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new MockProjectRepository()

    const result = await repository.getOperatingSnapshot('SY-2026-001')

    expect(result.source).toBe('demo')
    expect(result.data.costs.total_cents).toBe(
      (result.data.costs.material_consumed_cents ?? 0)
      + (result.data.costs.labor_cents ?? 0)
      + (result.data.costs.field_material_cents ?? 0),
    )
    expect(result.data.profit.actual_profit_cents).toBe(
      result.data.profit.contracted_amount_cents - (result.data.profit.actual_cost_cents ?? 0),
    )
    expect(result.data.costs.procurement_committed_cents).not.toBe(result.data.costs.total_cents)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('预览 Project Repository 的现有仪表台仍调用真实后端', async () => {
    const liveDashboard = {
      project: { project_code: 'SY-2026-001', name: '真实项目' },
      company: { name: '真实客户' },
      contacts: [],
      documents: { document_count: 0, version_count: 0, categories: [] },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(liveDashboard))
    vi.stubGlobal('fetch', fetchMock)
    const repository = createHttpProjectRepository()

    const result = await repository.getBaseDashboard('SY-2026-001')

    expect(result).toEqual({ source: 'live', data: liveDashboard })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/SY-2026-001/dashboard',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    )
  })

  it('真实接口失败时不会偷偷退回 Project Mock', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ detail: '项目服务暂时不可用' }, 503),
    ))
    const repository = createHttpProjectRepository()

    await expect(repository.getBaseDashboard('SY-2026-001')).rejects.toThrow('项目服务暂时不可用')
  })

  it('P1 Repository 先锁定独立演示数据源，不暴露契约未冻结的响应字段', () => {
    expect(new MockProcurementRepository().source).toBe('demo')
    expect(new MockWorkforceRepository().source).toBe('demo')
  })
})
