import { requestJson, withQuery } from '../../api'
export interface OperationEvent {
  id: number
  action: string
  actor_name: string | null
  group_name: string | null
  occurred_at: string
  summary: string
  reason: string | null
  changes: Record<string, unknown>
}
export interface OperationEventPage {
  items: OperationEvent[]
  next_before_id: number | null
}
export function loadOperationHistory(resourceType: string, resourceId: number | string, beforeId?: number | null, signal?: AbortSignal) {
  return requestJson<OperationEventPage>(withQuery(`/api/operation-history/${encodeURIComponent(resourceType)}/${encodeURIComponent(String(resourceId))}`, {
    before_id: beforeId,
    limit: 20
  }), {
    signal
  })
}
