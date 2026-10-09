import { ApiError } from '../../api'
import { protectPendingWrites } from '../pendingUnload'

export function textValue(value: unknown): string { return String(value ?? '').trim() }
export function optional(value: unknown): string | null { return textValue(value) || null }
export function required(value: unknown, label: string): string {
  const result = textValue(value)
  if (!result) throw new Error(`请填写${label}`)
  return result
}
export function quantityMilli(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim())
  if (!match) throw new Error('数量必须是最多三位小数的非负数')
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'))
}
export function remainingQuantity(total: string, used: string): string {
  const value = quantityMilli(total) - quantityMilli(used)
  return value <= 0n ? '0.000' : `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`
}
export function positiveQuantity(value: unknown): string {
  const quantity = textValue(value)
  if (quantityMilli(quantity) <= 0n) throw new Error('数量必须大于 0')
  return quantity
}

interface AllocatableOrder {
  lines: Array<{ id: number; line_amount_cents: number }>
  supplier_payments?: Array<{ status: string; allocations: Array<{ purchase_order_line_id: number; amount_cents: number }> }>
  supplier_invoices?: Array<{ status: string; allocations: Array<{ purchase_order_line_id: number; amount_cents: number }> }>
}
export function allocateAmount(order: AllocatableOrder, amount: number, kind: 'payment' | 'invoice') {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('金额必须大于 0')
  const records = kind === 'payment' ? order.supplier_payments : order.supplier_invoices
  let remaining = amount
  const allocations = order.lines.flatMap((line) => {
    const used = (records ?? []).filter((record) => record.status === 'active')
      .flatMap((record) => record.allocations).filter((item) => item.purchase_order_line_id === line.id)
      .reduce((total, item) => total + item.amount_cents, 0)
    const allocated = Math.min(remaining, Math.max(0, line.line_amount_cents - used))
    remaining -= allocated
    return allocated > 0 ? [{ purchase_order_line_id: line.id, amount_cents: allocated }] : []
  })
  if (remaining > 0) throw new Error(kind === 'payment' ? '付款金额超过采购单未付金额' : '开票金额超过采购单未开票金额')
  return allocations
}

export interface PendingMutation {
  scope: string
  title: string
  execute: () => Promise<unknown>
  discardRequest?: () => boolean
  busy: boolean
  committed: boolean
  error: string
}

/** 在组件卸载后继续保留原请求闭包，避免网络结果未知时创建第二笔业务流水。 */
export class MutationLedger {
  private pending = new Map<string, PendingMutation>()
  private listeners = new Set<() => void>()
  private completed = new Map<string, { title: string }>()
  private revision = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.revision
  private notify() { this.revision++; for (const listener of this.listeners) listener() }
  get(scope: string): PendingMutation | null { return this.pending.get(scope) ?? null }
  hasPending(): boolean { return this.pending.size > 0 }
  lastCompleted(scope: string): { title: string } | null { return this.completed.get(scope) ?? null }
  start(scope: string, title: string, execute: () => Promise<unknown>, discardRequest?: () => boolean): PendingMutation {
    if (this.pending.has(scope)) throw new Error('请先处理上一次结果未知的请求')
    const pending = { scope, title, execute, discardRequest, busy: false, committed: false, error: '' }
    this.pending.set(scope, pending); this.notify()
    return pending
  }
  async run(pending: PendingMutation): Promise<void> {
    if (pending.busy || pending.committed || this.get(pending.scope) !== pending) return
    pending.busy = true; pending.error = ''; this.notify()
    try {
      await pending.execute()
      pending.committed = true
      this.completed.set(pending.scope, { title: pending.title })
      this.pending.delete(pending.scope)
    } catch (error) {
      pending.error = error instanceof Error ? error.message : '请求失败'
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
        this.pending.delete(pending.scope)
      }
      throw error
    } finally { pending.busy = false; this.notify() }
  }
  discard(pending: PendingMutation): boolean {
    if (pending.busy || !pending.discardRequest || !pending.discardRequest()) return false
    if (this.get(pending.scope) === pending) this.pending.delete(pending.scope)
    this.notify(); return true
  }
}
export const mutationLedger = new MutationLedger()
const releaseUnloadGuard = protectPendingWrites(() => mutationLedger.hasPending(), mutationLedger.subscribe)
if (import.meta.hot) import.meta.hot.dispose(releaseUnloadGuard)
const owners = new WeakMap<object, number>()
let ownerSequence = 0
export function mutationScope(repository: object, area: string, projectCode = ''): string {
  if (!owners.has(repository)) owners.set(repository, ++ownerSequence)
  return JSON.stringify([owners.get(repository), area, projectCode])
}
