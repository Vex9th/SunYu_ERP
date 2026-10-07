import type { DashboardTodo } from '../domain/contracts'

export function todoDestination(todo: DashboardTodo): string {
  if (todo.code === 'BACKUP_UNHEALTHY') return '/settings'
  if (!todo.project_code) return '/projects'
  const base = `/projects/${encodeURIComponent(todo.project_code)}`
  if (todo.code === 'STAGE_BLOCKED') return `${base}/stages`
  if (todo.code === 'RECEIVABLE_OVERDUE')
    return `${base}/commercial?section=receivables`
  if (todo.code === 'DELIVERY_UPCOMING')
    return `${base}/delivery?section=acceptance`
  return base
}
