import type { BasisPoints, MoneyCents } from './contracts'

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(value: MoneyCents | null): string {
  return value === null ? '--' : moneyFormatter.format(value / 100)
}

export function formatBasisPoints(value: BasisPoints | null): string {
  return value === null ? '--' : `${(value / 100).toFixed(2)}%`
}

export function yuanToCents(value: string): MoneyCents {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('金额必须是最多两位小数的非负元金额')
  }
  const [yuan, fraction = ''] = normalized.split('.')
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(result)) throw new Error('金额超出可保存范围')
  return result
}

export function centsToYuan(value: MoneyCents): string {
  return `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`
}
