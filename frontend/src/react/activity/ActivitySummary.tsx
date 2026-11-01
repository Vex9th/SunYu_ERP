import { Typography } from 'antd'
import type { ActivitySummaryData } from '../../types'
import { formatChineseDateTime } from '../../domain/dates'
export type ActivitySummaryProps = {
  label?: string
  actorName?: string | null
  occurredAt?: string | null
  summary?: ActivitySummaryData | null
}
export function ActivitySummary({
  label,
  actorName,
  occurredAt,
  summary
}: ActivitySummaryProps) {
  const actor = actorName === undefined ? summary?.last_actor : actorName
  const at = occurredAt ?? summary?.last_at
  return <Typography.Text type="secondary">{actor ? `${label ?? summary?.last_action ?? '最近操作'}：${actor}${at ? ` · ${formatChineseDateTime(at)}` : ''}` : '历史记录，未记录操作人'}</Typography.Text>
}
