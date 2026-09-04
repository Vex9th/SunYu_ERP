import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'

import InventoryCenter from '../components/inventory/InventoryCenter.vue'
import type { InventoryItemDto, InventoryMovementDto } from '../domain/operations-api'
import type { InventoryHttpRepository } from '../repositories/inventory.live'

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function live<T>(data: T) {
  return { source: 'live' as const, data }
}

function inventoryItem(id: number, name: string, unit = '台'): InventoryItemDto {
  return {
    id,
    brand: '汇川',
    name,
    model: `MODEL-${id}`,
    specification: null,
    unit,
    quantity: '2.000',
    average_unit_cost_cents: 120000,
    inventory_value_cents: 240000,
    notes: null,
    revision: 1,
    created_at: '2026-09-04T08:00:00+08:00',
    updated_at: '2026-09-04T08:00:00+08:00',
  }
}

function inventoryMovement(itemId: number, reason: string): InventoryMovementDto {
  return {
    id: itemId * 10,
    inventory_item_id: itemId,
    project_id: null,
    procurement_line_id: null,
    movement_type: 'adjustment',
    quantity_delta: '1.000',
    value_delta_cents: 120000,
    quantity_after: '2.000',
    value_after_cents: 240000,
    source_type: 'inventory_adjustment',
    source_id: itemId,
    occurred_on: '2026-09-04',
    reason,
    created_at: '2026-09-04T08:00:00+08:00',
    adjustment_status: 'active',
    adjustment_revision: 1,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('InventoryCenter 加载容错', () => {
  it('库存列表读取失败后提供原地重试并恢复列表', async () => {
    const listInventoryItems = vi.fn()
      .mockRejectedValueOnce(new Error('库存服务暂时不可用'))
      .mockResolvedValueOnce({
        source: 'live',
        data: {
          items: [{
            id: 8,
            brand: '汇川',
            name: '伺服驱动器',
            model: 'SV660',
            specification: null,
            unit: '台',
            quantity: '2.000',
            average_unit_cost_cents: 120000,
            inventory_value_cents: 240000,
            notes: null,
            revision: 1,
            created_at: '2026-09-04T08:00:00+08:00',
            updated_at: '2026-09-04T08:00:00+08:00',
          }],
          total: 1,
          page: 1,
          page_size: 20,
        },
      })
    const repository = { listInventoryItems } as unknown as InventoryHttpRepository
    const wrapper = mount(InventoryCenter, {
      props: { repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    expect(wrapper.get('[data-testid="inventory-load-error"]').text()).toContain('库存服务暂时不可用')
    await wrapper.get('[data-testid="inventory-load-retry"]').trigger('click')
    await settle()

    expect(listInventoryItems).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="inventory-load-error"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('伺服驱动器')
    wrapper.unmount()
  })

  it('从物料 A 切到 B 时立即隔离 A 流水，B 加载失败也不串到 B 名下', async () => {
    const itemA = inventoryItem(1, 'A 伺服电机', '台')
    const itemB = inventoryItem(2, 'B 电缆', '米')
    const movementA = inventoryMovement(itemA.id, 'A 专属流水')
    const detailB = deferred<ReturnType<typeof live<typeof itemB & { movements: InventoryMovementDto[] }>>>()
    const movementsB = deferred<ReturnType<typeof live<{
      items: InventoryMovementDto[]
      total: number
      page: number
      page_size: number
    }>>>()
    const repository = {
      listInventoryItems: vi.fn(async () => live({ items: [itemA, itemB], total: 2, page: 1, page_size: 20 })),
      getInventoryItem: vi.fn((itemId: number) => itemId === itemA.id
        ? Promise.resolve(live({ ...itemA, movements: [movementA] }))
        : detailB.promise),
      listInventoryMovements: vi.fn((itemId: number) => itemId === itemA.id
        ? Promise.resolve(live({ items: [movementA], total: 1, page: 1, page_size: 20 }))
        : movementsB.promise),
    } as unknown as InventoryHttpRepository
    const wrapper = mount(InventoryCenter, {
      props: { repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-1"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="inventory-detail-drawer"]').text()).toContain('A 专属流水')

    await wrapper.get('[data-testid="inventory-detail-open-2"]').trigger('click')
    await wrapper.vm.$nextTick()
    const pendingDrawer = wrapper.get('[data-testid="inventory-detail-drawer"]').text()
    expect(pendingDrawer).not.toContain('A 专属流水')

    detailB.reject(new Error('B 详情读取失败'))
    movementsB.reject(new Error('B 流水读取失败'))
    await settle()

    const failedDrawer = wrapper.get('[data-testid="inventory-detail-drawer"]').text()
    expect(failedDrawer).toContain('B 详情读取失败')
    expect(failedDrawer).toContain('当前仅显示库存列表中的摘要')
    expect(failedDrawer).toContain('B 流水读取失败')
    expect(failedDrawer).toContain('当前不显示该物料的流水')
    expect(failedDrawer).not.toContain('A 专属流水')
    wrapper.unmount()
  })

  it('同一物料详情刷新失败时保留本物料旧详情，同时接受本物料的新流水', async () => {
    const item = inventoryItem(3, 'B 变频器')
    const oldMovement = inventoryMovement(item.id, 'B 旧流水')
    const newMovement = { ...inventoryMovement(item.id, 'B 新流水'), id: 31 }
    const getInventoryItem = vi.fn()
      .mockResolvedValueOnce(live({ ...item, model: 'B-SAVED-DETAIL', movements: [oldMovement] }))
      .mockRejectedValueOnce(new Error('B 详情局部失败'))
    const listInventoryMovements = vi.fn()
      .mockResolvedValueOnce(live({ items: [oldMovement], total: 1, page: 1, page_size: 20 }))
      .mockResolvedValueOnce(live({ items: [newMovement], total: 1, page: 1, page_size: 20 }))
    const repository = {
      listInventoryItems: vi.fn(async () => live({ items: [item], total: 1, page: 1, page_size: 20 })),
      getInventoryItem,
      listInventoryMovements,
    } as unknown as InventoryHttpRepository
    const wrapper = mount(InventoryCenter, {
      props: { repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-3"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-detail-open-3"]').trigger('click')
    await settle()

    const drawer = wrapper.get('[data-testid="inventory-detail-drawer"]').text()
    expect(drawer).toContain('B 详情局部失败')
    expect(drawer).toContain('仍显示该物料上一次成功读取的详情')
    expect(drawer).toContain('B-SAVED-DETAIL')
    expect(drawer).toContain('B 新流水')
    expect(drawer).not.toContain('B 旧流水')
    wrapper.unmount()
  })

  it('同一物料流水刷新失败时保留本物料旧流水，同时接受本物料的新详情', async () => {
    const item = inventoryItem(4, 'B PLC')
    const oldMovement = inventoryMovement(item.id, 'B 可保留流水')
    const getInventoryItem = vi.fn()
      .mockResolvedValueOnce(live({ ...item, model: 'B-OLD-DETAIL', movements: [oldMovement] }))
      .mockResolvedValueOnce(live({ ...item, model: 'B-NEW-DETAIL', revision: 2, movements: [oldMovement] }))
    const listInventoryMovements = vi.fn()
      .mockResolvedValueOnce(live({ items: [oldMovement], total: 1, page: 1, page_size: 20 }))
      .mockRejectedValueOnce(new Error('B 流水局部失败'))
    const repository = {
      listInventoryItems: vi.fn(async () => live({ items: [item], total: 1, page: 1, page_size: 20 })),
      getInventoryItem,
      listInventoryMovements,
    } as unknown as InventoryHttpRepository
    const wrapper = mount(InventoryCenter, {
      props: { repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="inventory-detail-open-4"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="inventory-detail-open-4"]').trigger('click')
    await settle()

    const drawer = wrapper.get('[data-testid="inventory-detail-drawer"]').text()
    expect(drawer).toContain('B 流水局部失败')
    expect(drawer).toContain('仍显示该物料上一次成功读取的流水')
    expect(drawer).toContain('B-NEW-DETAIL')
    expect(drawer).toContain('B 可保留流水')
    wrapper.unmount()
  })
})
