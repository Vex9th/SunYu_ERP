import type { InventoryAdjustmentInput, InventoryItemInput, InventoryIssueInput, InventoryMovementDto } from '../../domain/operations-api'
import { yuanToCents } from '../../domain/formatters'
import { optional, positiveQuantity, quantityMilli, required, textValue } from '../procurement/model'

type Values = Record<string, unknown>
function checkValue(quantity: string, cents: number): void {
  if ((quantityMilli(quantity) * BigInt(cents) + 500n) / 1000n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('库存价值超出可保存范围')
}
export function inventoryInput(values: Values): InventoryItemInput {
  const quantity = textValue(values.opening_quantity) || '0'
  const hasQuantity = quantityMilli(quantity) > 0n
  const cost = hasQuantity ? yuanToCents(required(values.cost, '期初成本单价')) : null
  if (cost !== null) checkValue(quantity, cost)
  return { name: required(values.name, '物料名称'), unit: required(values.unit, '计量单位'), brand: optional(values.brand), model: optional(values.model), specification: optional(values.specification), notes: optional(values.notes), opening_quantity: quantity, opening_unit_cost_cents: cost }
}
export function adjustmentInput(itemId: number, values: Values): InventoryAdjustmentInput {
  const quantity = textValue(values.quantity_delta)
  const absolute = quantity.startsWith('-') ? quantity.slice(1) : quantity
  if (quantityMilli(absolute) <= 0n) throw new Error('调整数量不能为 0')
  const cost = quantity.startsWith('-') ? null : yuanToCents(required(values.cost, '本次成本单价'))
  if (cost !== null) checkValue(absolute, cost)
  return { item_id: itemId, quantity_delta: quantity, unit_cost_cents: cost, reason: required(values.reason, '调整原因'), occurred_on: required(values.occurred_on, '发生日期') }
}
export function issueInput(values: Values, items: Array<{ id: number; name: string; quantity: string }>): InventoryIssueInput {
  const drafts = values.lines as Array<{ inventory_item_id: number; quantity: string }> | undefined
  if (!drafts?.length) throw new Error('请至少选择一项库存物料')
  const seen = new Set<number>()
  const lines = drafts.map((line) => {
    const item = items.find((entry) => entry.id === line.inventory_item_id)
    if (!item || seen.has(item.id)) throw new Error('物料不存在或重复选择，请检查领用明细')
    seen.add(item.id)
    const quantity = positiveQuantity(line.quantity)
    if (quantityMilli(quantity) > quantityMilli(item.quantity)) throw new Error(`${item.name}的领用数量不能超过当前库存`)
    return { inventory_item_id: item.id, procurement_line_id: null, quantity }
  })
  return { issued_on: required(values.issued_on, '领用日期'), worker_id: typeof values.worker_id === 'number' ? values.worker_id : null, lines, notes: optional(values.notes) }
}
export function movementLabel(item: Pick<InventoryMovementDto, 'movement_type' | 'source_type'>): string {
  if (item.movement_type === 'reversal') return ({ inventory_adjustment_reversal: '调整冲销', goods_receipt_reversal: '到货冲销', inventory_issue_reversal: '领用冲销' } as Record<string, string>)[item.source_type] ?? '冲销'
  return { opening: '期初库存', goods_receipt: '采购到货', adjustment: '库存调整', project_issue: '项目领用' }[item.movement_type]
}
