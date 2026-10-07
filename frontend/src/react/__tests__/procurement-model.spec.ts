import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api'
import { MutationLedger, allocateAmount, quantityMilli, remainingQuantity } from '../procurement/model'

describe('采购写入和金额约束', () => {
  it('数量按千分位精确计算，拒绝超过三位小数', () => {
    expect(remainingQuantity('2.100', '1.999')).toBe('0.101')
    expect(() => quantityMilli('0.0001')).toThrow()
  })
  it('已冲销付款不占用行分摊额度，超额金额拒绝提交', () => {
    const order = { lines: [{ id: 1, line_amount_cents: 100 }, { id: 2, line_amount_cents: 200 }], supplier_payments: [{ status: 'active', allocations: [{ purchase_order_line_id: 1, amount_cents: 80 }] }, { status: 'reversed', allocations: [{ purchase_order_line_id: 2, amount_cents: 200 }] }] }
    expect(allocateAmount(order, 120, 'payment')).toEqual([{ purchase_order_line_id: 1, amount_cents: 20 }, { purchase_order_line_id: 2, amount_cents: 100 }])
    expect(() => allocateAmount(order, 221, 'payment')).toThrow()
  })
  it('未知结果重试继续使用原始提交闭包，成功后不再重发', async () => {
    const ledger = new MutationLedger()
    const payload = { quantity: '1.000' }
    const calls: unknown[] = []
    let failed = true
    const pending = ledger.start('project-A', '到货', async () => { calls.push(payload); if (failed) throw new Error('网络中断') }, () => true)
    await expect(ledger.run(pending)).rejects.toThrow('网络中断')
    expect(ledger.get('project-A')).toBe(pending)
    expect(ledger.get('project-B')).toBeNull()
    failed = false
    await ledger.run(pending)
    await ledger.run(pending)
    expect(calls).toEqual([payload, payload])
    expect(ledger.get('project-A')).toBeNull()
  })
  it('服务端明确拒绝可修改输入，不保留结果未知警告', async () => {
    const ledger = new MutationLedger()
    const pending = ledger.start('A', '保存', async () => { throw new ApiError('输入不合法', 422) })
    await expect(ledger.run(pending)).rejects.toThrow()
    expect(ledger.get('A')).toBeNull()
  })
  it('请求执行期间拒绝重复提交与放弃', async () => {
    const ledger = new MutationLedger()
    let resolve!: () => void
    let calls = 0
    const pending = ledger.start('A', '保存', () => { calls++; return new Promise<void>((done) => { resolve = done }) }, () => true)
    const first = ledger.run(pending)
    await ledger.run(pending)
    expect(ledger.discard(pending)).toBe(false)
    resolve(); await first
    expect(calls).toBe(1)
  })
})
