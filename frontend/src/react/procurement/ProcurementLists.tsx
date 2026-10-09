import { useEffect, useState } from 'react'
import { Button, Descriptions, Empty, Input, Space, Table, Tag, Typography } from 'antd'
import { DownOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons'
import type { ProcurementLineDto, ProcurementListDetailDto } from '../../domain/operations-api'
import { formatMoney } from '../../domain/formatters'
import { quantityMilli, remainingQuantity } from './model'
import styles from './ProcurementWorkspace.module.css'

const listLabels = { draft: '草稿', confirmed: '已确认', superseded: '已替代' }
const factLabels: Record<string, string> = {
  not_ordered: '未采购', partial: '部分完成', ordered: '已采购', over_ordered: '超采',
  unpaid: '未付款', paid: '已付款', not_received: '未到货', received: '已到货',
  not_invoiced: '未开票', invoiced: '已开票', unused: '未领用', used: '已领用',
}

interface Props {
  lists: ProcurementListDetailDto[]
  selectedId: number | null
  onSelect: (id: number) => void
  loading: boolean
  readonly: boolean
  locked: boolean
  onCreate: () => void
  onImport: () => void
  onAddLine: (list: ProcurementListDetailDto) => void
  onEditList: (list: ProcurementListDetailDto) => void
  onConfirmList: (list: ProcurementListDetailDto) => void
  onCopyList: (list: ProcurementListDetailDto) => void
  onQuote: (list: ProcurementListDetailDto) => void
  quoteAvailable: boolean
  onEditLine: (list: ProcurementListDetailDto, line: ProcurementLineDto) => void
  onDeleteLine: (list: ProcurementListDetailDto, line: ProcurementLineDto) => void
  onOrderLine: (list: ProcurementListDetailDto, line: ProcurementLineDto) => void
}

export default function ProcurementLists(props: Props) {
  const { lists, selectedId, onSelect, loading, readonly, locked } = props
  const list = lists.find((entry) => entry.id === selectedId) ?? lists[0]
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch('') }, [list?.id])
  const query = search.trim().toLocaleLowerCase('zh-CN')
  const visibleLines = (list?.lines ?? []).filter((line) => !query || [line.name, line.brand, line.model, line.specification, line.category].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(query))

  if (!list) return <Empty description={loading ? '正在读取采购清单…' : readonly ? '此项目没有采购清单' : '先建立物料需求清单，再确认采购和报价'}>
    {!loading && !readonly && <Space><Button type="primary" disabled={locked} onClick={props.onCreate}>创建采购清单</Button><Button disabled={locked} onClick={props.onImport}>从 Excel 导入</Button></Space>}
  </Empty>

  return <div className={styles.listsLayout}>
    <nav className={styles.listPicker} aria-label="选择采购清单">
      <Typography.Text type="secondary" className={styles.pickerLabel}>本页清单 · {lists.length} 份</Typography.Text>
      {lists.map((entry) => <button key={entry.id} type="button" aria-label={`查看清单 ${entry.name}`} aria-pressed={entry.id === list.id}
        className={`${styles.listChoice} ${entry.id === list.id ? styles.listChoiceActive : ''}`} onClick={() => onSelect(entry.id)}>
        <strong>{entry.name}</strong>
        <span><Tag color={entry.status === 'confirmed' ? 'blue' : 'default'}>{listLabels[entry.status]}</Tag>{entry.lines.length} 项物料</span>
        <small>成本 {formatMoney(entry.cost_total_cents)}</small>
      </button>)}
    </nav>

    <section className={styles.listContent} aria-label={`当前清单 ${list.name}`}>
      <div className={styles.listHeading}>
        <div><Typography.Title level={5}>{list.name}</Typography.Title><Typography.Text type="secondary">{list.status === 'draft' ? '填写物料后确认清单，即可下单和生成客户报价。' : list.status === 'confirmed' ? '清单已锁定，可下单或生成客户报价；需要调整时复制为草稿。' : '此清单已被替代，保留历史内容供查阅。'}</Typography.Text></div>
        {!readonly && <Space wrap>{list.status === 'draft' ? <>
          <Button disabled={locked} onClick={() => props.onEditList(list)}>编辑清单</Button>
          <Button disabled={locked} onClick={() => props.onAddLine(list)}>添加物料</Button>
          <Button type="primary" disabled={locked || !list.lines.length} onClick={() => props.onConfirmList(list)}>确认清单</Button>
        </> : list.status === 'confirmed' ? <>
          <Button disabled={locked} onClick={() => props.onCopyList(list)}>复制为草稿</Button>
          <Button disabled={locked || !props.quoteAvailable} onClick={() => props.onQuote(list)}>客户报价</Button>
        </> : null}</Space>}
      </div>
      <div className={styles.listSummary}>
        <span>物料 <strong>{list.lines.length}</strong> 项</span>
        <span>成本合计 <strong>{formatMoney(list.cost_total_cents)}</strong></span>
        <span>报价合计 <strong>{formatMoney(list.quoted_total_cents)}</strong></span>
      </div>
      {list.notes && <p className={styles.listNotes}>{list.notes}</p>}
      {list.lines.length > 0 && <div className={styles.lineSearch}><Input value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder="查找本清单物料、品牌或型号" aria-label="查找本清单物料" /><Typography.Text type="secondary">{query ? `匹配 ${visibleLines.length} 项` : '展开行可查看报价、付款、开票与领用明细'}</Typography.Text></div>}
      <Table<ProcurementLineDto> key={list.id} size="small" rowKey="id" dataSource={visibleLines} loading={loading} scroll={{ x: 760 }}
        pagination={visibleLines.length > 20 ? { defaultPageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 项物料` } : false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '本清单没有匹配物料' : readonly ? '此清单没有物料' : '清单已建立，添加物料后即可确认'}>{query ? <Button onClick={() => setSearch('')}>清除搜索</Button> : !readonly && list.status === 'draft' && <Button disabled={locked} onClick={() => props.onAddLine(list)}>添加第一项物料</Button>}</Empty> }}
        expandable={{
          columnWidth: 34,
          expandIcon: ({ expanded, onExpand, record }) => <Button size="small" type="text" aria-label={`${expanded ? '收起' : '展开'}${record.name}明细`} icon={expanded ? <UpOutlined /> : <DownOutlined />} onClick={(event) => onExpand(record, event)} />,
          expandedRowRender: (line) => <LineDetails line={line} />,
        }} columns={[
          { title: '物料', key: 'material', width: 250, render: (_, line) => <><div className={styles.materialName}><span className={styles.sequence}>{line.sequence_no}</span><strong>{line.name}</strong></div><div className={styles.secondary}>{[line.brand, line.model, line.specification].filter(Boolean).join(' · ') || line.category}</div></> },
          { title: '需求 / 已采购', key: 'quantity', width: 125, align: 'right', render: (_, line) => <><strong className={styles.number}>{line.quantity} {line.unit}</strong><div className={styles.secondary}>已购 {line.ordered_quantity}</div></> },
          { title: '成本金额', key: 'cost', width: 135, align: 'right', render: (_, line) => <><strong className={styles.number}>{formatMoney(line.cost_total_cents)}</strong><div className={styles.secondary}>单价 {formatMoney(line.unit_cost_cents)}</div></> },
          { title: '执行进度', key: 'progress', width: 125, render: (_, line) => <Space orientation="vertical" size={4}><Tag>{factLabels[line.order_status] ?? line.order_status}</Tag><span className={styles.secondary}>{factLabels[line.receipt_status] ?? line.receipt_status} · {line.received_quantity}</span></Space> },
          ...(!readonly ? [{ title: '操作', key: 'action', width: 118, fixed: 'right' as const, render: (_: unknown, line: ProcurementLineDto) => list.status === 'draft' ? <Space size={2}><Button size="small" type="link" disabled={locked} onClick={() => props.onEditLine(list, line)}>编辑</Button><Button size="small" type="link" danger disabled={locked} onClick={() => props.onDeleteLine(list, line)}>删除</Button></Space> : list.status === 'confirmed' ? <Button size="small" type="link" disabled={locked} onClick={() => props.onOrderLine(list, line)}>{quantityMilli(remainingQuantity(line.quantity, line.ordered_quantity)) === 0n ? '补充采购' : '建立采购单'}</Button> : null }] : []),
        ]} />
    </section>
  </div>
}

function LineDetails({ line }: { line: ProcurementLineDto }) {
  return <Descriptions size="small" column={{ xs: 1, md: 2, xl: 3 }} items={[
    { key: 'category', label: '物料分类', children: line.category },
    { key: 'quote-price', label: '报价单价', children: formatMoney(line.quoted_unit_price_cents) },
    { key: 'quote-total', label: '报价合计', children: formatMoney(line.quoted_total_cents) },
    { key: 'ordered', label: '采购金额', children: formatMoney(line.ordered_amount_cents) },
    { key: 'received', label: '累计到货', children: `${line.received_quantity} ${line.unit}` },
    { key: 'paid', label: '累计付款', children: `${formatMoney(line.paid_amount_cents)} · ${factLabels[line.payment_status] ?? line.payment_status}` },
    { key: 'invoiced', label: '累计开票', children: `${formatMoney(line.invoiced_amount_cents)} · ${factLabels[line.invoice_status] ?? line.invoice_status}` },
    { key: 'issued', label: '累计领用', children: `${line.issued_quantity} ${line.unit} · ${factLabels[line.usage_status] ?? line.usage_status}` },
  ]} />
}
