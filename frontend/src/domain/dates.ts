function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

export function localISODate(date = new Date()): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`
}

export function localISODateTimeInput(date = new Date()): string {
  return `${localISODate(date)}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}
