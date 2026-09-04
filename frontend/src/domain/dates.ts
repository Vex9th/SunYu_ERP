const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const SHANGHAI_DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

export function localISODate(date = new Date()): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`
}

export function localISODateTimeInput(date = new Date()): string {
  return `${localISODate(date)}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

function parsedDate(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatChineseDate(value: string | null): string {
  if (!value) return '—'
  const match = DATE_ONLY_PATTERN.exec(value)
  if (match) {
    const [, year, month, day] = match
    const date = new Date(`${value}T00:00:00Z`)
    if (
      !Number.isNaN(date.getTime())
      && date.getUTCFullYear() === Number(year)
      && date.getUTCMonth() + 1 === Number(month)
      && date.getUTCDate() === Number(day)
    ) {
      return `${Number(year)}年${Number(month)}月${Number(day)}日`
    }
    return '日期无效'
  }
  const date = parsedDate(value)
  if (!date) return '日期无效'
  const parts = SHANGHAI_DATE_TIME.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}年${part('month')}月${part('day')}日`
}

export function formatChineseDateTime(value: string | null): string {
  if (!value) return '—'
  const date = parsedDate(value)
  if (!date) return '日期无效'
  const parts = SHANGHAI_DATE_TIME.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}年${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')}`
}
