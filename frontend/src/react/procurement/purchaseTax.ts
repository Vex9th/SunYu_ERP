import { centsToYuan, yuanToCents } from '../../domain/formatters'
import { positiveQuantity, quantityMilli, textValue } from './model'

const invalidTaxRate = '税率必须为 0 到 100 之间的数字，最多两位小数'
export function taxRateToBps(value: unknown): number | null {
  const rate = textValue(value)
  if (!rate) return null
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rate)) throw new Error(invalidTaxRate)
  const [whole, fraction = ''] = rate.split('.')
  const bps = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (bps > 10000n) throw new Error(invalidTaxRate)
  return Number(bps)
}

export function taxRateToInput(bps: number | null | undefined): string {
  return bps == null ? '' : centsToYuan(bps).replace(/\.?0+$/, '') || '0'
}

export function calculatePurchaseTax(lines: Array<{ quantity?: unknown; cost?: unknown }>, rateBps: number | null) {
  if (rateBps != null && (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000)) throw new Error(invalidTaxRate)
  if (!lines.length) throw new Error('请填写采购物料、数量和未税单价')
  let net = 0n, tax = 0n
  for (const line of lines) {
    const quantity = quantityMilli(positiveQuantity(line.quantity))
    const cost = BigInt(yuanToCents(textValue(line.cost)))
    const amount = (cost * quantity + 500n) / 1000n
    net += amount
    tax += (amount * BigInt(rateBps ?? 0) + 5000n) / 10000n
  }
  const gross = net + tax
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出可保存范围')
  return { net: Number(net), tax: Number(tax), gross: Number(gross) }
}
