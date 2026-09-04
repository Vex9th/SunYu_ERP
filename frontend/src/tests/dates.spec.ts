import { describe, expect, it } from 'vitest'

import { formatChineseDate, formatChineseDateTime } from '../domain/dates'

describe('中文日期显示', () => {
  it('空值显示统一占位', () => {
    expect(formatChineseDate(null)).toBe('—')
    expect(formatChineseDateTime(null)).toBe('—')
  })

  it('日期不受时区换日影响', () => {
    expect(formatChineseDate('2026-09-03')).toBe('2026年9月3日')
  })

  it('时间统一转换为上海时区', () => {
    expect(formatChineseDateTime('2026-09-03T01:02:00Z')).toBe('2026年9月3日 09:02')
  })

  it('异常输入不会显示 Invalid Date', () => {
    expect(formatChineseDate('not-a-date')).toBe('日期无效')
    expect(formatChineseDateTime('not-a-date')).toBe('日期无效')
  })
})
