import { describe, expect, it } from 'vitest'
import { adjustmentInput, inventoryInput, issueInput, movementLabel } from '../inventory/model'

describe('库存业务输入', () => {
  it('期初和调增保留精确数量和成本价，零调整拒绝', () => {
    expect(inventoryInput({ name: '电缆', unit: '米', opening_quantity: '1.001', cost: '10.25' }).opening_unit_cost_cents).toBe(1025)
    expect(() => inventoryInput({ name: '电缆', unit: '', opening_quantity: '0' })).toThrow()
    expect(() => adjustmentInput(1, { quantity_delta: '1', reason: '盘盈', occurred_on: '2026-10-06' })).toThrow()
    expect(() => adjustmentInput(1, { quantity_delta: '-0.000', reason: '盘点', occurred_on: '2026-10-06' })).toThrow()
    expect(adjustmentInput(1, { quantity_delta: '-1.500', reason: '盘亏', occurred_on: '2026-10-06' }).unit_cost_cents).toBeNull()
  })
  it('多物料领用拒绝零数量与超过可用库存，保留施工员', () => {
    const items = [{ id: 1, name: '电缆', quantity: '2.000' }, { id: 2, name: '接头', quantity: '1.000' }]
    const input = { issued_on: '2026-10-06', worker_id: 3, lines: [{ inventory_item_id: 1, quantity: '1.001' }, { inventory_item_id: 2, quantity: '1' }] }
    expect(issueInput(input, items).lines).toHaveLength(2)
    expect(issueInput(input, items).worker_id).toBe(3)
    expect(() => issueInput({ ...input, lines: [{ inventory_item_id: 1, quantity: '2.001' }] }, items)).toThrow()
    expect(() => issueInput({ ...input, lines: [{ inventory_item_id: 1, quantity: '0' }] }, items)).toThrow()
  })
  it('冲销类型依据真实来源显示', () => {
    expect(movementLabel({ movement_type: 'reversal', source_type: 'goods_receipt_reversal' })).toBe('到货冲销')
    expect(movementLabel({ movement_type: 'reversal', source_type: 'inventory_issue_reversal' })).toBe('领用冲销')
  })
})
