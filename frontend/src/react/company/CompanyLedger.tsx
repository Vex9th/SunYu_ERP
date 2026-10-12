import { useState, type CSSProperties } from 'react'
import { Alert, Button, Checkbox, Empty, Input, Segmented, Select, Space, Spin, Table, type TableColumnType } from 'antd'
import { DownOutlined, RightOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import { requestJson } from '../../api'
import { formatMoney } from '../../domain/formatters'
import { ErrorNotice, RefreshButton, useLoad } from '../shared'
import { summarizeCustomer, summarizeSupplier, type CompanyLedgerData, type CustomerContract, type CustomerProject, type SupplierOrder } from './ledger'
import styles from './CompanyLedger.module.css'

const projectPath = (code: string) => `/projects/${encodeURIComponent(code)}`
const amount = (value: number) => <span className={styles.amount}>{formatMoney(value)}</span>
type LedgerColumn<Row> = TableColumnType<Row> & { width: number }
const tableWidth = (columns: { width: number }[]) => columns.reduce((total, column) => total + column.width, 0)
const moneyCharacters = (values: number[]) => values.reduce((length, value) => Math.max(length, formatMoney(value).length), 0)

function amountColumnWidth(values: number[], minimum = 112) {
  // 按 14px 表格字体保守估算完整金额，包含货币符号、分隔符和单元格两侧留白。
  return Math.max(minimum, moneyCharacters(values) * 8 + 24)
}

function Summary({ label, scope, items }: { label: string; scope: string; items: { label: string; value: number; outstanding?: boolean }[] }) {
  return <section className={styles.summary} aria-label={label}
    style={{ '--summary-money-characters': moneyCharacters(items.map(item => item.value)) } as CSSProperties}>
    <p className={styles.note}>{scope}</p>
    <dl>{items.map(item => <div key={item.label}>
      <dt>{item.label}</dt>
      <dd className={item.outstanding && item.value > 0 ? styles.outstanding : undefined}>{formatMoney(item.value)}</dd>
    </div>)}</dl>
  </section>
}

function ProjectFilter({ label, projects, value, onChange }: {
  label: string
  projects: { project_id: number; project_code: string; project_name: string }[]
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  const options = [...new Map(projects.map(project => [project.project_id, {
    value: project.project_id, label: `${project.project_code} · ${project.project_name}`,
  }])).values()]
  return <label className={styles.field}>项目
    <Select className={styles.projectFilter} aria-label={label} placeholder="全部项目" allowClear showSearch
      optionFilterProp="label" value={value} onChange={onChange} options={options} />
  </label>
}

function SupplierLedger({ orders }: { orders: SupplierOrder[] }) {
  const [project, setProject] = useState<number>()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [unpaid, setUnpaid] = useState(false)
  const [uninvoiced, setUninvoiced] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const dateError = Boolean(start && end && start > end)
  const filtered = orders.filter(order => (!project || order.project_id === project)
    && (!start || order.ordered_on >= start) && (!end || order.ordered_on <= end)
    && (!unpaid || order.unpaid_amount_cents > 0) && (!uninvoiced || order.uninvoiced_amount_cents > 0))
  const summary = summarizeSupplier(filtered)
  const columns: LedgerColumn<SupplierOrder>[] = [
    { title: '项目名称', key: 'project', width: 144, fixed: 'left', className: styles.wrappable, render: (_, row) => <><Link to={projectPath(row.project_code)}>{row.project_name}</Link><div className={styles.note}>{row.project_code}</div></> },
    { title: '采购单号', dataIndex: 'order_no', width: 200, className: styles.wrappable, render: (value: string, row) => <Link to={`${projectPath(row.project_code)}/procurement?section=orders&order=${row.order_id}`}>{value}</Link> },
    { title: '下单日期', dataIndex: 'ordered_on', width: 110 },
    { title: '采购金额', dataIndex: 'ordered_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.ordered_amount_cents)), render: amount },
    { title: '已付金额', dataIndex: 'paid_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.paid_amount_cents)), render: amount },
    { title: '未付金额', dataIndex: 'unpaid_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.unpaid_amount_cents)), render: amount },
    { title: '已开票', dataIndex: 'invoiced_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.invoiced_amount_cents)), render: amount },
    { title: '未开票', dataIndex: 'uninvoiced_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.uninvoiced_amount_cents)), render: amount },
  ]
  function clearFilters() { setProject(undefined); setStart(''); setEnd(''); setUnpaid(false); setUninvoiced(false); setPage(1) }
  return <div className={styles.ledger}>
    <div className={styles.filters}>
      <ProjectFilter label="筛选供应商项目" projects={orders} value={project} onChange={value => { setProject(value); setPage(1) }} />
      <label className={styles.field}>下单日期起
        <Input className={styles.dateFilter} type="date" aria-label="下单开始日期" value={start} onChange={event => { setStart(event.target.value); setPage(1) }} />
      </label>
      <label className={styles.field}>下单日期止
        <Input className={styles.dateFilter} type="date" aria-label="下单结束日期" value={end} onChange={event => { setEnd(event.target.value); setPage(1) }} />
      </label>
      <div className={styles.filterActions}>
        <Checkbox checked={unpaid} onChange={event => { setUnpaid(event.target.checked); setPage(1) }}>仅未付款</Checkbox>
        <Checkbox checked={uninvoiced} onChange={event => { setUninvoiced(event.target.checked); setPage(1) }}>仅未开票</Checkbox>
        <Button onClick={clearFilters}>清空筛选</Button>
      </div>
    </div>
    {dateError && <Alert type="warning" showIcon title="开始日期不能晚于结束日期" />}
    <Summary label="供应商汇总" scope={`当前筛选合计 · ${summary.project_count} 个项目 · ${summary.order_count} 笔采购单`} items={[
      { label: '采购金额', value: summary.ordered_amount_cents },
      { label: '已付金额', value: summary.paid_amount_cents },
      { label: '未付金额', value: summary.unpaid_amount_cents, outstanding: true },
      { label: '已开票金额', value: summary.invoiced_amount_cents },
      { label: '未开票金额', value: summary.uninvoiced_amount_cents, outstanding: true },
    ]} />
    <p className={styles.note}>汇总包含当前筛选下的全部记录，不受分页影响。仅计入有效采购单、未冲销付款及有效进项发票。</p>
    <Table<SupplierOrder> rowKey="order_id" size="small" tableLayout="fixed" dataSource={filtered} scroll={{ x: tableWidth(columns) }}
      pagination={{ current: page, pageSize, showSizeChanger: true, hideOnSinglePage: true, onChange: (next, size) => { setPage(next); setPageSize(size) }, showTotal: total => `共 ${total} 笔` }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={orders.length ? '没有符合筛选条件的采购单' : '暂无供应商采购往来'} /> }}
      columns={columns} />
  </div>
}

function ContractTable({ project }: { project: CustomerProject }) {
  const columns: LedgerColumn<CustomerContract>[] = [
    { title: '合同编号 / 名称', key: 'contract', width: 214, className: styles.wrappable, render: (_, contract) => <><Link to={`${projectPath(project.project_code)}/commercial?section=contracts`}>{contract.contract_no}</Link><div className={styles.note}>{contract.title}</div></> },
    { title: '签订日期', dataIndex: 'signed_on', width: 110, render: (value: string | null) => value || '未填写' },
    { title: '状态', dataIndex: 'status', width: 90, render: (value: CustomerContract['status']) => ({ signed: '已签署', completed: '已完成', terminated: '已终止' })[value] },
    { title: '原合同分摊', dataIndex: 'allocated_amount_cents', align: 'right', width: amountColumnWidth(project.contracts.map(row => row.allocated_amount_cents)), render: amount },
    { title: '已收金额', dataIndex: 'received_amount_cents', align: 'right', width: amountColumnWidth(project.contracts.map(row => row.received_amount_cents)), render: amount },
    { title: '未收金额', dataIndex: 'unreceived_amount_cents', align: 'right', width: amountColumnWidth(project.contracts.map(row => row.unreceived_amount_cents)), render: amount },
  ]
  return <div className={styles.contractTable}>
    <Table<CustomerContract> rowKey="allocation_id" size="small" tableLayout="fixed" dataSource={project.contracts} pagination={false} scroll={{ x: tableWidth(columns) }} columns={columns} />
  </div>
}

function CustomerLedger({ projects }: { projects: CustomerProject[] }) {
  const [project, setProject] = useState<number>()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const filtered = projects.filter(row => !project || row.project_id === project)
  const summary = summarizeCustomer(filtered)
  const expandColumnWidth = 36
  const columns: LedgerColumn<CustomerProject>[] = [
    { title: '项目名称', key: 'project', width: 144, fixed: 'left', className: styles.wrappable, render: (_, row) => <><Link to={projectPath(row.project_code)}>{row.project_name}</Link><div className={styles.note}>{row.project_code} · {row.contracts.length} 份合同</div></> },
    { title: '有效合同分摊', dataIndex: 'contracted_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.contracted_amount_cents), 125), render: amount },
    { title: '累计合同到账', dataIndex: 'allocated_received_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.allocated_received_amount_cents), 125), render: amount },
    { title: '合同未收', dataIndex: 'unreceived_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.unreceived_amount_cents)), render: amount },
    { title: '未关联合同到账', dataIndex: 'unallocated_received_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.unallocated_received_amount_cents), 135), render: amount },
    { title: '项目销项发票', dataIndex: 'invoiced_amount_cents', align: 'right', width: amountColumnWidth(filtered.map(row => row.invoiced_amount_cents), 125), render: amount },
    { title: '业务记录', key: 'actions', width: 165, render: (_, row) => <Space><Link to={`${projectPath(row.project_code)}/commercial?section=contracts`}>查看合同</Link><Link to={`${projectPath(row.project_code)}/delivery?section=invoices`}>查看发票</Link></Space> },
  ]
  return <div className={styles.ledger}>
    <div className={styles.filters}>
      <ProjectFilter label="筛选客户项目" projects={projects} value={project} onChange={value => { setProject(value); setPage(1) }} />
      <Button onClick={() => { setProject(undefined); setPage(1) }}>清空筛选</Button>
    </div>
    <Summary label="客户汇总" scope={`当前筛选合计 · ${summary.project_count} 个项目 · ${summary.contract_count} 份合同`} items={[
      { label: '有效合同分摊', value: summary.contracted_amount_cents },
      { label: '累计合同到账', value: summary.allocated_received_amount_cents },
      { label: '合同未收', value: summary.unreceived_amount_cents, outstanding: true },
      { label: '未关联合同到账', value: summary.unallocated_received_amount_cents },
      { label: '项目销项发票', value: summary.invoiced_amount_cents },
    ]} />
    <p className={styles.note}>有效合同金额按项目分摊；合同未收仅扣减对应合同的有效到账，未关联合同到账单独列示。已终止合同保留历史到账，不再计入有效合同额和未收。销项发票按项目甲方归集，不对应具体合同。汇总包含当前筛选下的全部记录，不受分页影响。</p>
    <Table<CustomerProject> rowKey="project_id" size="small" tableLayout="fixed" dataSource={filtered} scroll={{ x: tableWidth(columns) + expandColumnWidth }}
      pagination={{ current: page, pageSize, showSizeChanger: true, hideOnSinglePage: true, onChange: (next, size) => { setPage(next); setPageSize(size) }, showTotal: total => `共 ${total} 个项目` }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projects.length ? '没有符合筛选条件的客户项目' : '暂无客户项目往来'} /> }}
      expandable={{ fixed: 'left', columnWidth: expandColumnWidth, rowExpandable: row => row.contracts.length > 0, expandedRowRender: row => <ContractTable project={row} />,
        expandIcon: ({ expanded, onExpand, record }) => record.contracts.length > 0 ? <Button size="small" type="text" aria-label={`${expanded ? '收起' : '展开'}${record.project_name}合同`} aria-expanded={expanded} icon={expanded ? <DownOutlined /> : <RightOutlined />} onClick={event => onExpand(record, event)} /> : null,
      }}
      columns={columns} />
  </div>
}

export default function CompanyLedger({ companyId }: { companyId: number }) {
  const [role, setRole] = useState<'supplier' | 'customer'>('supplier')
  const load = useLoad(async () => {
    const data = await requestJson<CompanyLedgerData>(`/api/companies/${companyId}/ledger`)
    if (data.company_id !== companyId) throw new Error('往来数据与当前公司不一致，请重新读取')
    return data
  }, [companyId])
  const data = load.data?.company_id === companyId ? load.data : null
  if (load.error) return <ErrorNotice error={load.error} retry={load.reload} />
  if (!data) return <div className={styles.loading} role="status" aria-label="正在读取公司往来"><Spin />正在读取公司往来…</div>
  return <div className={styles.ledger}>
    <div className={styles.toolbar}>
      <Segmented aria-label="往来类型" value={role} onChange={setRole} options={[
        { value: 'supplier', label: '供应商往来' },
        { value: 'customer', label: '客户往来' },
      ]} />
      <RefreshButton onClick={load.reload} loading={load.loading} label="刷新往来" />
    </div>
    <div hidden={role !== 'supplier'}><SupplierLedger orders={data.supplier.orders} /></div>
    <div hidden={role !== 'customer'}><CustomerLedger projects={data.customer.projects} /></div>
  </div>
}
