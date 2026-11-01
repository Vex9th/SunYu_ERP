import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Empty, Space, Spin, Timeline, Typography } from 'antd'
import { HistoryOutlined } from '@ant-design/icons'
import { ApiError } from '../../api'
import { formatChineseDate, formatChineseDateTime } from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import { useAccess } from '../access/AccessProvider'
import { changeLabels, statusLabels } from './changeLabels'
import { ActivitySummary } from './ActivitySummary'
import { loadOperationHistory, type OperationEvent } from './activityRepository'
export type OperationHistoryProps = {
  resourceType: string
  resourceId: number | string
  title?: string
}
function changeText(value: unknown, key: string): string {
  if (Array.isArray(value)) return `共 ${value.length} 项`
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object' && !Array.isArray(value) && ('before' in value || 'after' in value)) {
    const change = value as {
      before?: unknown
      after?: unknown
    }
    return `${changeText(change.before, key)} → ${changeText(change.after, key)}`
  }
  if (typeof value === 'string' && key.endsWith('_at')) return formatChineseDateTime(value)
  if (typeof value === 'string' && key.endsWith('_on')) return formatChineseDate(value)
  if (typeof value === 'number' && key.endsWith('_cents')) return formatMoney(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return typeof value === 'object' ? JSON.stringify(value) : ((key.includes('status') || ['pay_basis', 'payment_method'].includes(key)) ? statusLabels[String(value)] ?? String(value) : String(value))
}
export function OperationHistory({
  resourceType,
  resourceId,
  title = '操作记录'
}: OperationHistoryProps) {
  const {
    namespace,
    accessRevision
  } = useAccess()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<OperationEvent[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [forbidden, setForbidden] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    controller.current?.abort()
    setOpen(false)
    setItems([])
    setNext(null)
    setLoaded(false)
    setError('')
    return () => controller.current?.abort()
  }, [resourceType, resourceId, namespace, accessRevision])
  async function load(before?: number | null) {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError('')
    setForbidden(false)
    try {
      const result = await loadOperationHistory(resourceType, resourceId, before, current.signal)
      if (!current.signal.aborted) {
        setItems(previous => before ? [...previous, ...result.items] : result.items)
        setNext(result.next_before_id)
        setLoaded(true)
      }
    } catch (cause) {
      if (current.signal.aborted) return
      const denied = cause instanceof ApiError && [401, 403].includes(cause.status)
      if (denied) {
        setItems([])
        setNext(null)
        setForbidden(true)
      }

      setError(denied ? '无权查看此对象的操作记录' : cause instanceof Error ? cause.message : '操作记录读取失败')
    } finally {
      if (!current.signal.aborted) setLoading(false)
    }
  }
  return <>
    <Button ref={trigger} size="small" type="link" icon={<HistoryOutlined />} aria-label="查看操作记录" onClick={() => {
      setOpen(true)
      void load()
    }}>{title}</Button>
    <Drawer title={title} open={open} size={560} onClose={() => {
      setOpen(false)
      controller.current?.abort()
    }} afterOpenChange={visible => {
      if (!visible) trigger.current?.focus()
    }}>
      <Space orientation="vertical" size={16} style={{
        width: '100%'
      }}>
        {error && <Alert type={forbidden ? 'warning' : 'error'} showIcon title={error} action={!forbidden && <Button onClick={() => void load(items.length ? next : undefined)}>重试</Button>} />}
        {loading && <Spin description="正在读取操作记录" />}
        {!loading && !error && loaded && items.length === 0 && <Empty description="历史记录，未记录操作人" />}
        <Timeline items={items.map(item => ({
          key: item.id,
          content: <Space orientation="vertical" size={4}>
            <Typography.Text strong>{item.summary}</Typography.Text>
            <ActivitySummary label="操作人" actorName={item.actor_name} />
            <Typography.Text type="secondary">{item.group_name ? `${item.group_name} · ` : ''}{formatChineseDateTime(item.occurred_at)}</Typography.Text>{item.reason && <Typography.Paragraph style={{
              margin: 0
            }}>原因：{item.reason}</Typography.Paragraph>}{Object.keys(item.changes).some(key => changeLabels[key]) && <Descriptions size="small" column={1} items={Object.entries(item.changes).filter(([key]) => changeLabels[key]).map(([key, value]) => ({
              key,
              label: changeLabels[key],
              children: changeText(value, key)
            }))} />}</Space>
        }))} />
        {!forbidden && next !== null && <Button loading={loading} onClick={() => void load(next)}>加载更早记录</Button>}
        {!loading && loaded && items.length > 0 && next === null && <Typography.Text type="secondary">已显示全部记录</Typography.Text>}
      </Space>
    </Drawer>
  </>
}
