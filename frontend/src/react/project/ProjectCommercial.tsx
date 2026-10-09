import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Drawer, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd'
import { DeleteOutlined, InboxOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { Contract, ContractStatus, PaymentMethod, PaymentMilestone, PaymentTerm, Quote, QuoteStatus, Receipt } from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { centsToYuan, formatBasisPoints, formatMoney, yuanToCents } from '../../domain/formatters'
import { createHttpProjectOperatingRepository, type ContractInput, type DocumentVersionOption, type ProjectOperatingRepository } from '../../repositories/project-operating.live'
import { useWorkspaceTab } from '../shared'
import { useUnsavedChanges } from '../unsavedChanges'
import './project.css'
import { errorText, nullable, useProjectLoad, useProjectWrite, type ProjectProps } from './useProjectWork'

const repositoryDefault = createHttpProjectOperatingRepository()
export const quoteTransitions: Record<QuoteStatus, QuoteStatus[]> = { draft: ['sent', 'withdrawn'], sent: ['accepted', 'rejected', 'withdrawn'], accepted: [], rejected: [], withdrawn: [] }
export const contractTransitions: Record<ContractStatus, ContractStatus[]> = { draft: ['signed', 'terminated'], signed: ['completed', 'terminated'], completed: [], terminated: [] }
const quoteLabels = { draft: '草稿', sent: '已发送', accepted: '已接受', rejected: '已拒绝', withdrawn: '已撤回' }
const contractLabels = { draft: '草稿', signed: '已签署', completed: '已完成', terminated: '已终止' }
const milestoneLabels: Record<PaymentMilestone, string> = { advance: '预付款', progress: '进度款', final: '尾款' }
const methodLabels: Record<PaymentMethod, string> = { bank_transfer: '银行转账', cash: '现金', other: '其他' }
const termLabels: Record<string, string> = { unplanned: '未计划', scheduled: '待收款', partial: '部分到账', paid: '已收齐' }
const optionsOf = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }))
const statusColor = (status: string) => ['accepted', 'signed', 'completed', 'paid'].includes(status) ? 'success' : ['rejected', 'terminated', 'voided'].includes(status) ? 'error' : ['sent', 'partial', 'scheduled'].includes(status) ? 'processing' : 'default'
interface AllocationDraft { project_code: string; amount: string }
export function validateAllocations(allocations: AllocationDraft[], total: number, currentProject: string) {
  if (!allocations.length || !allocations.some(item => item.project_code === currentProject)) throw new Error('合同分摊必须包含当前项目')
  if (new Set(allocations.map(item => item.project_code)).size !== allocations.length) throw new Error('同一个项目只能分摊一次')
  const parsed = allocations.map(item => ({ project_code: item.project_code, amount_cents: yuanToCents(item.amount) }))
  if (parsed.some(item => !item.project_code || item.amount_cents <= 0)) throw new Error('每个项目必须填写大于零的分摊金额')
  if (parsed.reduce((sum, item) => sum + item.amount_cents, 0) !== total) throw new Error('各项目分摊金额之和必须等于合同总额')
  return parsed
}
export function businessFileError(file: File, kind: 'quote' | 'contract'): string | null {
  const accepted = kind === 'quote' ? /\.(pdf|doc|docx|xls|xlsx)$/i : /\.(pdf|doc|docx)$/i
  return accepted.test(file.name) || file.type.toLowerCase().startsWith('image/') ? null : `${file.name} 格式不支持，请选择${kind === 'quote' ? ' PDF、Word、Excel 或图片' : ' PDF、Word 或图片'}`
}
const moneyRule = (positive = false) => ({ validator: async (_: unknown, value?: string) => { const amount = yuanToCents(value ?? ''); if (positive && amount <= 0) throw new Error('金额必须大于零') } })
type Dialog = { kind: 'quote'; item?: Quote } | { kind: 'contract'; item?: Contract } | { kind: 'quoteTransition'; item: Quote } | { kind: 'contractTransition'; item: Contract } | { kind: 'term'; item: PaymentTerm } | { kind: 'receipt'; item?: Receipt; milestone?: PaymentMilestone } | { kind: 'void'; item: Receipt }
interface Values { quote_date: string; amount: string; valid_until?: string; notes?: string; document_version_ids: number[]; contract_no: string; title: string; signed_on?: string; final_delivery_on?: string; allocations: AllocationDraft[]; to_status: QuoteStatus | ContractStatus; reason?: string; due_on?: string; contract_allocation_id: number; milestone: PaymentMilestone; received_on: string; payment_method: PaymentMethod; reference_no?: string; voided_on: string }
function Attachments({ projectCode, ids, options }: { projectCode: string; ids: number[]; options: DocumentVersionOption[] }) {
  return ids.length ? <Space orientation="vertical" size={0}>{ids.map(id => <Typography.Link key={id} href={`/api/projects/${encodeURIComponent(projectCode)}/document-versions/${id}/download`} download>{options.find(option => option.value === id)?.label ?? `附件 #${id}`}</Typography.Link>)}</Space> : <Typography.Text type="secondary">无附件</Typography.Text>
}

export default function ProjectCommercial({ projectCode, readonly = false, repository = repositoryDefault }: ProjectProps & { repository?: ProjectOperatingRepository }) {
  const load = useProjectLoad(projectCode, async () => {
    const [quotes, contracts, payments, dashboard, options, global] = await Promise.allSettled([repository.listQuotes(projectCode), repository.listContracts(projectCode), repository.getPayments(projectCode), repository.getProjectDashboard(projectCode), repository.listDocumentVersionOptions(projectCode), repository.getGlobalDashboard()])
    if (quotes.status === 'rejected') throw quotes.reason
    if (contracts.status === 'rejected') throw contracts.reason
    if (payments.status === 'rejected') throw payments.reason
    if (dashboard.status === 'rejected') throw dashboard.reason
    return { quotes: quotes.value.items, contracts: contracts.value.items, payments: payments.value, project: dashboard.value.project, options: options.status === 'fulfilled' ? options.value : [], projects: global.status === 'fulfilled' ? global.value.projects.map(item => item.project) : [dashboard.value.project], optionWarning: options.status === 'rejected', projectWarning: global.status === 'rejected' }
  }, repository)
  const [view, setView] = useWorkspaceTab('section', ['quotes', 'contracts', 'receivables'], 'quotes')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [files, setFiles] = useState<UploadFile[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [form] = Form.useForm<Values>()
  const [modal, modalContext] = Modal.useModal()
  const allocationDrafts = Form.useWatch('allocations', form) as AllocationDraft[] | undefined
  const totalDraft = Form.useWatch('amount', form) as string | undefined
  const receiptContractId = Form.useWatch('contract_allocation_id', form) as number | undefined
  const receiptMilestone = Form.useWatch('milestone', form) as PaymentMilestone | undefined
  const parsedMoney = (value?: string) => { try { return value?.trim() ? yuanToCents(value) : null } catch { return null } }
  const draftTotal = parsedMoney(totalDraft)
  const allocatedTotal = (allocationDrafts ?? []).reduce((sum, allocation) => sum + (parsedMoney(allocation?.amount) ?? 0), 0)
  const remainingAllocation = draftTotal === null ? null : draftTotal - allocatedTotal
  const dirty = useRef(false)
  const write = useProjectWrite(`commercial:${projectCode}`, () => { setDialog(null); setFiles([]); load.reload() })
  useUnsavedChanges(() => Boolean(dialog) && (dirty.current || write.busy))
  useEffect(() => { setDialog(null); setFiles([]); setFormError(null); form.resetFields() }, [projectCode, form])
  const data = load.data
  const quotes = data?.quotes ?? []; const contracts = data?.contracts ?? []; const payments = data?.payments
  const disabled = readonly || write.locked || load.loading || Boolean(load.error)
  const receiptAllocations = contracts.filter(contract => ['signed', 'completed'].includes(contract.status)).flatMap(contract => contract.allocations.filter(item => item.project_code === projectCode).map(item => ({ value: item.id, label: `${contract.contract_no} · ${contract.title}` })))
  const selectedReceiptContract = contracts.find(contract => contract.allocations.some(allocation => allocation.id === receiptContractId))
  const selectedReceiptAllocation = selectedReceiptContract?.allocations.find(allocation => allocation.id === receiptContractId)
  const receiptContractCollected = payments?.receipts.filter(receipt => receipt.status === 'active' && receipt.contract_allocation_id === receiptContractId).reduce((sum, receipt) => sum + receipt.amount_cents, 0) ?? 0
  const selectedTerm = payments?.terms.find(term => term.milestone === receiptMilestone)
  const allocationLabel = (id: number | null) => receiptAllocations.find(item => item.value === id)?.label ?? contracts.find(item => item.allocations.some(allocation => allocation.id === id))?.contract_no ?? (id ? `历史合同分摊 #${id}` : '未归属（历史记录）')
  const projects = [...(data?.projects ?? [])]
  if (data && !projects.some(item => item.project_code === projectCode)) projects.push(data.project)
  const projectOptions = projects.map(item => ({ value: item.project_code, label: `${item.project_code} · ${item.name} · ${item.company_name}` }))
  if (dialog?.kind === 'contract') for (const allocation of dialog.item?.allocations ?? []) { if (!projectOptions.some(item => item.value === allocation.project_code)) projectOptions.push({ value: allocation.project_code, label: allocation.project_code }) }
  function open(next: Dialog) {
    setDialog(next); setFiles([]); setFormError(null); write.clearError(); form.resetFields(); dirty.current = false
    const common = { notes: '', document_version_ids: [] as number[] }
    if (next.kind === 'quote') form.setFieldsValue(next.item ? { ...next.item, amount: centsToYuan(next.item.amount_cents), valid_until: next.item.valid_until ?? '', notes: next.item.notes ?? '' } : { ...common, quote_date: localISODate(), amount: '', valid_until: '' })
    else if (next.kind === 'contract') form.setFieldsValue(next.item ? { ...next.item, amount: centsToYuan(next.item.total_amount_cents), signed_on: next.item.signed_on ?? '', final_delivery_on: next.item.final_delivery_on ?? '', notes: next.item.notes ?? '', allocations: next.item.allocations.map(item => ({ project_code: item.project_code, amount: centsToYuan(item.amount_cents) })) } : { ...common, contract_no: '', title: '', amount: '', signed_on: '', final_delivery_on: '', allocations: [{ project_code: projectCode, amount: '' }] })
    else if (next.kind === 'receipt') form.setFieldsValue(next.item ? { ...next.item, voided_on: next.item.voided_on ?? '', contract_allocation_id: next.item.contract_allocation_id ?? undefined, reference_no: next.item.reference_no ?? '', notes: next.item.notes ?? '', amount: centsToYuan(next.item.amount_cents) } : { ...common, received_on: localISODate(), amount: '', milestone: next.milestone ?? 'advance', payment_method: 'bank_transfer', contract_allocation_id: receiptAllocations.length === 1 ? receiptAllocations[0].value : undefined, reference_no: '' })
    else if (next.kind === 'term') form.setFieldsValue({ due_on: next.item.due_on ?? '', amount: centsToYuan(next.item.planned_amount_cents), notes: next.item.notes ?? '' })
    else if (next.kind === 'void') form.setFieldsValue({ voided_on: localISODate(), reason: '' })
    else form.setFieldsValue({ reason: '', to_status: undefined })
  }
  function close() {
    if (write.busy) return
    if (dirty.current && !write.locked) { modal.confirm({ title: '放弃尚未保存的修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: () => setDialog(null) }); return }
    setDialog(null)
  }
  function save(values: Values) {
    if (!dialog || !data || readonly || write.locked) return
    setFormError(null)
    try {
      if (files.length > 20) throw new Error('一次最多上传 20 个附件')
      if (dialog.kind === 'quote') {
        if (values.valid_until && values.valid_until < values.quote_date) throw new Error('报价有效期不能早于报价日期')
        const input = { quote_date: values.quote_date, amount_cents: yuanToCents(values.amount), valid_until: nullable(values.valid_until), notes: nullable(values.notes), document_version_ids: values.document_version_ids ?? [] }
        const item = dialog.item; const attachments = files.flatMap(file => file.originFileObj ? [file.originFileObj] : [])
        write.submit(item ? '更新报价' : '创建报价', () => item ? repository.updateQuote(projectCode, item.id, { ...input, expected_revision: item.revision }) : repository.createQuote(projectCode, input, attachments), item ? undefined : () => repository.discardCreateQuote(projectCode, input, attachments))
      } else if (dialog.kind === 'contract') {
        const amount = yuanToCents(values.amount)
        const input: ContractInput = { contract_no: values.contract_no.trim(), title: values.title.trim(), customer_company_id: dialog.item?.customer_company_id ?? data.project.company_id, signed_on: nullable(values.signed_on), total_amount_cents: amount, final_delivery_on: nullable(values.final_delivery_on), allocations: validateAllocations(values.allocations, amount, projectCode), notes: nullable(values.notes), document_version_ids: values.document_version_ids ?? [] }
        const item = dialog.item; const attachments = files.flatMap(file => file.originFileObj ? [file.originFileObj] : [])
        write.submit(item ? '更新合同' : '创建合同', () => item ? repository.updateContract(projectCode, item.id, { ...input, expected_revision: item.revision }) : repository.createContract(projectCode, input, attachments), item ? undefined : () => repository.discardCreateContract(projectCode, input, attachments))
      } else if (dialog.kind === 'quoteTransition') {
        const item = dialog.item; const target = values.to_status as QuoteStatus
        if (!quoteTransitions[item.status].includes(target)) throw new Error('请选择当前报价可用的状态')
        const input = { to_status: target, occurred_at: new Date().toISOString(), reason: nullable(values.reason), expected_revision: item.revision }
        write.submit('变更报价状态', () => repository.transitionQuote(projectCode, item.id, input))
      } else if (dialog.kind === 'contractTransition') {
        const item = dialog.item; const target = values.to_status as ContractStatus
        if (!contractTransitions[item.status].includes(target)) throw new Error('请选择当前合同可用的状态')
        if (target === 'signed' && (!item.signed_on || !item.final_delivery_on)) throw new Error('签署前请先编辑合同，补齐签订日期和最终交付日期')
        const input = { to_status: target, occurred_at: new Date().toISOString(), reason: nullable(values.reason), expected_revision: item.revision }
        write.submit('变更合同状态', () => repository.transitionContract(projectCode, item.id, input))
      } else if (dialog.kind === 'term') {
        const term = dialog.item; const input = { due_on: nullable(values.due_on), planned_amount_cents: yuanToCents(values.amount), notes: nullable(values.notes), expected_revision: term.revision }
        write.submit('保存收款计划', () => repository.putPaymentTerm(projectCode, term.milestone, input))
      } else if (dialog.kind === 'receipt') {
        const item = dialog.item
        if (item) { const input = { reference_no: nullable(values.reference_no), notes: nullable(values.notes), expected_revision: item.revision }; write.submit('更新到账说明', () => repository.updateReceipt(projectCode, item.id, input)) }
        else {
          if (!receiptAllocations.some(item => item.value === values.contract_allocation_id)) throw new Error('请选择本次到账归属的已签署合同')
          const input = { contract_allocation_id: values.contract_allocation_id, milestone: values.milestone, received_on: values.received_on, amount_cents: yuanToCents(values.amount), payment_method: values.payment_method, reference_no: nullable(values.reference_no), notes: nullable(values.notes) }
          write.submit('登记到账', () => repository.createReceipt(projectCode, input))
        }
      } else if (dialog.kind === 'void') {
        const item = dialog.item; const input = { voided_on: values.voided_on, reason: values.reason!.trim(), expected_revision: item.revision }
        write.submit('作废到账流水', () => repository.voidReceipt(projectCode, item.id, input))
      }
    } catch (cause) { setFormError(errorText(cause)) }
  }
  const dialogTitle = !dialog ? '' : dialog.kind === 'quote' ? `${dialog.item ? '编辑' : '新增'}报价` : dialog.kind === 'contract' ? `${dialog.item ? '编辑' : '新增'}合同` : dialog.kind === 'receipt' ? dialog.item ? '修改到账说明' : '登记到账' : dialog.kind === 'term' ? `${milestoneLabels[dialog.item.milestone]}计划` : dialog.kind === 'void' ? '作废到账流水' : dialog.kind === 'quoteTransition' ? '变更报价状态' : '变更合同状态'
  const attachmentOptions = [...(data?.options ?? [])]
  if (dialog?.kind === 'quote' || dialog?.kind === 'contract') for (const id of dialog.item?.document_version_ids ?? []) if (!attachmentOptions.some(option => option.value === id)) attachmentOptions.push({ value: id, label: `已关联附件 #${id}` })
  const amountField = (label: string, positive = false, locked = false) => <Form.Item label={label} name="amount" rules={[{ required: true, message: '请填写金额' }, moneyRule(positive)]}><Input inputMode="decimal" placeholder="0.00" suffix="元" disabled={locked || readonly || write.locked} /></Form.Item>
  const attachmentFields = <><Form.Item label="关联已有文件版本" name="document_version_ids"><Select mode="multiple" showSearch optionFilterProp="label" options={attachmentOptions} placeholder="可选择多份已上传文件" /></Form.Item>{((dialog?.kind === 'quote' || dialog?.kind === 'contract') && !dialog.item) && <Form.Item label="直接上传附件"><Upload.Dragger multiple accept={dialog.kind === 'quote' ? '.pdf,.doc,.docx,.xls,.xlsx,image/*' : '.pdf,.doc,.docx,image/*'} beforeUpload={(file, selection) => { const error = businessFileError(file, dialog.kind); if (error || files.length + selection.length > 20) { setFormError(error ?? '一次最多上传 20 个附件，请先移除不需要的文件'); return Upload.LIST_IGNORE }; return false }} fileList={files} onChange={({ fileList }) => { setFiles(fileList); dirty.current = true }} disabled={readonly || write.locked}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p>点击或拖入附件，最多 20 份</p><p className="ant-upload-hint">单个文件大小以后端配置为准；保存后自动命名，原文件名可追溯。</p></Upload.Dragger></Form.Item>}</>
  const quoteTable = <Table<Quote> size="small" rowKey="id" dataSource={quotes} loading={load.loading} scroll={{ x: 740 }} pagination={{ defaultPageSize: 10, showSizeChanger: true, showTotal: total => `共 ${total} 次报价` }} columns={[
    { title: '报价', width: 190, render: (_, quote) => <Space orientation="vertical" size={5}><Space><Typography.Text strong>V{quote.version_number}</Typography.Text><Tag color={statusColor(quote.status)}>{quoteLabels[quote.status]}</Tag></Space><Typography.Text type="secondary">{quote.quote_date} · R{quote.revision}</Typography.Text></Space> },
    { title: '金额 / 有效期', width: 175, render: (_, quote) => <Space orientation="vertical" size={4}><Typography.Text strong>{formatMoney(quote.amount_cents)}</Typography.Text><Typography.Text type="secondary">{quote.valid_until ? `有效至 ${quote.valid_until}` : '未设有效期'}</Typography.Text></Space> },
    { title: '资料与说明', render: (_, quote) => <Space orientation="vertical" size={4}><Attachments projectCode={projectCode} ids={quote.document_version_ids} options={data?.options ?? []} />{quote.notes && <span className="project-record-note">{quote.notes}</span>}</Space> },
    { title: '操作', width: 170, render: (_, quote) => <Space wrap>{quote.status === 'draft' && <Button size="small" disabled={disabled} onClick={() => open({ kind: 'quote', item: quote })}>编辑</Button>}{quoteTransitions[quote.status].length > 0 && <Button size="small" disabled={disabled} onClick={() => open({ kind: 'quoteTransition', item: quote })}>变更状态</Button>}</Space> },
  ]} />
  const contractTable = <Table<Contract> size="small" rowKey="id" dataSource={contracts} loading={load.loading} scroll={{ x: 780 }} pagination={{ defaultPageSize: 10, showSizeChanger: true, showTotal: total => `共 ${total} 份合同` }} expandable={{ expandedRowRender: contract => <div className="project-contract-detail"><Descriptions size="small" items={[{ key: 'customer', label: '客户', children: contract.customer_company_name }, { key: 'revision', label: '记录版本', children: `R${contract.revision}` }, { key: 'notes', label: '备注', children: contract.notes ?? '—' }]} /><Table size="small" rowKey="id" pagination={false} dataSource={contract.allocations} columns={[{ title: '分摊项目', render: (_, allocation) => <Space><span>{projects.find(project => project.project_code === allocation.project_code)?.name ?? allocation.project_code}</span><Typography.Text type="secondary">{allocation.project_code}</Typography.Text>{allocation.project_code === projectCode && <Tag color="blue">当前项目</Tag>}</Space> }, { title: '分摊金额', dataIndex: 'amount_cents', align: 'right', render: formatMoney }]} /></div> }} columns={[
    { title: '合同 / 交付', width: 245, render: (_, contract) => <Space orientation="vertical" size={5}><Space wrap><Typography.Text strong>{contract.contract_no}</Typography.Text><Tag color={statusColor(contract.status)}>{contractLabels[contract.status]}</Tag></Space><span>{contract.title}</span><Typography.Text type="secondary">签订 {contract.signed_on ?? '待定'} · 交付 {contract.final_delivery_on ?? '待定'}</Typography.Text></Space> },
    { title: '合同金额', width: 205, render: (_, contract) => <Space orientation="vertical" size={4}><span>总额 <Typography.Text strong>{formatMoney(contract.total_amount_cents)}</Typography.Text></span><span>本项目 <Typography.Text strong>{formatMoney(contract.allocations.filter(item => item.project_code === projectCode).reduce((sum, item) => sum + item.amount_cents, 0))}</Typography.Text></span><Typography.Text type="secondary">分摊至 {contract.allocations.length} 个项目，可展开查看</Typography.Text></Space> },
    { title: '合同文件', render: (_, contract) => <Attachments projectCode={projectCode} ids={contract.document_version_ids} options={data?.options ?? []} /> },
    { title: '操作', width: 170, render: (_, contract) => <Space wrap>{contract.status === 'draft' && <Button size="small" disabled={disabled} onClick={() => open({ kind: 'contract', item: contract })}>编辑</Button>}{contractTransitions[contract.status].length > 0 && <Button size="small" disabled={disabled} onClick={() => open({ kind: 'contractTransition', item: contract })}>变更状态</Button>}</Space> },
  ]} />
  const paymentPanel = <Space orientation="vertical" style={{ width: '100%' }} size={20}>
    <div className="project-payment-terms">{payments?.terms.map(term => <Card size="small" key={term.milestone} title={milestoneLabels[term.milestone]} extra={<Space size={0}><Tag color={statusColor(term.status)}>{termLabels[term.status] ?? term.status}</Tag>{term.is_overdue && <Tag color="error">已逾期</Tag>}</Space>}><div className="project-term-amount"><Typography.Text type="secondary">尚待收款</Typography.Text><strong>{formatMoney(term.outstanding_amount_cents)}</strong></div><div className="project-term-facts"><span>计划 <b>{formatMoney(term.planned_amount_cents)}</b></span><span>已到账 <b>{formatMoney(term.received_amount_cents)}</b></span><span>到期日 <b>{term.due_on ?? '未设置'}</b></span><span>完成率 <b>{formatBasisPoints(term.term_fulfillment_basis_points)}</b></span></div>{term.notes && <p className="project-record-note">{term.notes}</p>}<Space className="project-term-actions"><Button size="small" disabled={disabled} onClick={() => open({ kind: 'term', item: term })}>编辑计划</Button><Button size="small" disabled={disabled || receiptAllocations.length === 0} onClick={() => open({ kind: 'receipt', milestone: term.milestone })}>登记{milestoneLabels[term.milestone]}</Button></Space></Card>)}</div>
    <div><Typography.Title level={5} style={{ marginBottom: 4 }}>到账流水</Typography.Title><Typography.Text type="secondary">参考号与备注可修改；金额、日期或归属有误，请作废后重新登记。</Typography.Text></div>
    <Table<Receipt> size="small" rowKey="id" dataSource={payments?.receipts ?? []} pagination={{ defaultPageSize: 10, showSizeChanger: true, showTotal: total => `共 ${total} 笔到账` }} scroll={{ x: 760 }} expandable={{ expandedRowRender: receipt => <Descriptions size="small" items={[{ key: 'ref', label: '参考号', children: receipt.reference_no ?? '—' }, { key: 'notes', label: '备注', children: receipt.notes ?? '—' }, { key: 'void', label: '作废记录', children: receipt.status === 'voided' ? `${receipt.voided_on} · ${receipt.void_reason}` : '有效流水' }]} /> }} columns={[
      { title: '到账', width: 170, render: (_, receipt) => <Space orientation="vertical" size={4}><Typography.Text strong>{formatMoney(receipt.amount_cents)}</Typography.Text><span>{receipt.received_on}</span><Space size={4}><Tag color={receipt.status === 'voided' ? 'error' : 'success'}>{receipt.status === 'voided' ? '已作废' : '有效'}</Tag><Typography.Text type="secondary">{methodLabels[receipt.payment_method]}</Typography.Text></Space></Space> },
      { title: '归属合同 / 节点', width: 245, render: (_, receipt) => <Space orientation="vertical" size={4}><span>{allocationLabel(receipt.contract_allocation_id)}</span><Tag>{milestoneLabels[receipt.milestone]}</Tag></Space> },
      { title: '参考号与说明', render: (_, receipt) => <Space orientation="vertical" size={4}><span>{receipt.reference_no ?? '—'}</span>{receipt.notes && <span className="project-record-note">{receipt.notes}</span>}{receipt.status === 'voided' && <Typography.Text type="danger">作废：{receipt.void_reason}</Typography.Text>}</Space> },
      { title: '操作', width: 140, render: (_, receipt) => receipt.status === 'active' && <Space><Button size="small" disabled={disabled} onClick={() => open({ kind: 'receipt', item: receipt })}>说明</Button><Button size="small" danger disabled={disabled} onClick={() => open({ kind: 'void', item: receipt })}>作废</Button></Space> },
    ]} />
  </Space>
  return <Space orientation="vertical" style={{ width: '100%' }} size={16}>{modalContext}
    {readonly && <Alert type="info" showIcon title="项目已归档，商务及收款记录只读" />}{load.error && <Alert type="error" showIcon title={load.error} action={<Button onClick={load.reload}>重试</Button>} />}{!dialog && write.notice}
    {(data?.optionWarning || data?.projectWarning) && <Alert type="warning" title={data.optionWarning ? '已有资料暂时无法读取，仍可在新建报价或合同时上传附件。' : '其他项目暂时无法读取，请刷新后再添加其他项目分摊。'} action={<Button onClick={load.reload}>重试</Button>} />}
    <div className="project-commercial-metrics">{[['本项目合同金额', payments?.contracted_amount_cents], ['应收金额', payments?.receivable_amount_cents], ['已到账', payments?.received_amount_cents], ['未收金额', payments?.outstanding_receivable_cents]].map(([label, amount]) => <div key={String(label)}><Typography.Text type="secondary">{label}</Typography.Text><strong>{typeof amount === 'number' ? formatMoney(amount) : '—'}</strong></div>)}</div>
    {Boolean(payments?.unallocated_received_amount_cents) && <Alert type="warning" title={`历史未归属到账 ${formatMoney(payments!.unallocated_received_amount_cents)}，不计入合同收款率`} />}
    <Card size="small" className="project-commercial-workspace">
      <Tabs activeKey={view} onChange={setView} items={[{ key: 'quotes', label: `报价记录 (${quotes.length})` }, { key: 'contracts', label: `项目合同 (${contracts.length})` }, { key: 'receivables', label: '收款与到账' }]} />
      <div className="project-list-toolbar"><div><Typography.Title level={5} style={{ margin: 0 }}>{view === 'quotes' ? '报价记录' : view === 'contracts' ? '项目合同' : '三段收款计划'}</Typography.Title><Typography.Text type="secondary">{view === 'quotes' ? '保留每版报价、有效期与客户确认状态' : view === 'contracts' ? '合同总额与本项目分摊同时核对；签署后进入收款' : '按预付款、进度款和尾款核对计划与实际到账'}</Typography.Text></div><Space><Button icon={<ReloadOutlined />} onClick={load.reload} disabled={write.busy}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={disabled || (view === 'receivables' && receiptAllocations.length === 0)} onClick={() => open(view === 'quotes' ? { kind: 'quote' } : view === 'contracts' ? { kind: 'contract' } : { kind: 'receipt' })}>{view === 'quotes' ? '新增报价' : view === 'contracts' ? '新增合同' : '登记到账'}</Button></Space></div>
      {view === 'receivables' && !load.loading && receiptAllocations.length === 0 && <Alert style={{ marginBottom: 16 }} type="info" title="请先签署合同，再登记归属到该合同的到账流水。" action={<Button onClick={() => setView('contracts')}>查看合同</Button>} />}
      {view === 'quotes' ? quoteTable : view === 'contracts' ? contractTable : paymentPanel}
    </Card>
    <Drawer forceRender title={dialogTitle} open={Boolean(dialog)} size={720} onClose={close} closable={!write.busy} mask={{ closable: !write.busy }} keyboard={!write.busy} footer={<Space><Button disabled={write.busy} onClick={close}>取消</Button><Button type="primary" danger={dialog?.kind === 'void'} onClick={() => form.submit()} disabled={readonly || write.locked} loading={write.busy}>{dialog?.kind === 'void' ? '确认作废' : '保存'}</Button></Space>}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>{write.notice}{formError && <Alert type="error" showIcon title={formError} />}
      <div className="project-form-context"><Typography.Text strong>{data?.project.name}</Typography.Text><Typography.Text type="secondary">{projectCode} · {data?.project.company_name}</Typography.Text></div>
      <Form form={form} layout="vertical" disabled={readonly || write.locked} onValuesChange={() => { dirty.current = true }} onFinish={save}>
        {dialog?.kind === 'quote' && <><Row gutter={16}><Col span={12}><Form.Item label="报价日期" name="quote_date" rules={[{ required: true, message: '请选择报价日期' }]}><Input type="date" /></Form.Item></Col><Col span={12}><Form.Item label="有效期至" name="valid_until"><Input type="date" /></Form.Item></Col></Row>{amountField('报价金额')}{attachmentFields}<Form.Item label="报价备注" name="notes"><Input.TextArea rows={4} /></Form.Item></>}
        {dialog?.kind === 'contract' && <><Typography.Title level={5}>合同信息</Typography.Title><Form.Item label="合同客户"><Input value={dialog.item?.customer_company_name ?? data?.project.company_name} readOnly /></Form.Item><Row gutter={16}><Col span={12}><Form.Item label="合同编号" name="contract_no" rules={[{ required: true, whitespace: true, message: '请填写合同编号' }]}><Input maxLength={100} /></Form.Item></Col><Col span={12}><Form.Item label="合同名称" name="title" rules={[{ required: true, whitespace: true, message: '请填写合同名称' }]}><Input maxLength={200} /></Form.Item></Col></Row>{amountField('合同总额', true)}<Row gutter={16}><Col span={12}><Form.Item label="签订日期" name="signed_on"><Input type="date" /></Form.Item></Col><Col span={12}><Form.Item label="最终交付日期" name="final_delivery_on"><Input type="date" /></Form.Item></Col></Row>
          <Typography.Title level={5}>项目金额分摊</Typography.Title><Typography.Paragraph type="secondary">当前项目必须保留一笔分摊；多个项目共同承接时，分别填写各自金额。</Typography.Paragraph><div className="project-allocation-balance" role="status"><span>合同总额 <b>{draftTotal === null ? '待填写' : formatMoney(draftTotal)}</b></span><span>已分摊 <b>{formatMoney(allocatedTotal)}</b></span><Typography.Text type={remainingAllocation !== null && remainingAllocation < 0 ? 'danger' : remainingAllocation === 0 ? 'success' : undefined}><strong>{remainingAllocation === null ? '请先填写合同总额' : remainingAllocation < 0 ? `超出 ${formatMoney(-remainingAllocation)}` : remainingAllocation === 0 ? '分摊已平衡' : `待分摊 ${formatMoney(remainingAllocation)}`}</strong></Typography.Text></div>
          <Form.List name="allocations">{(fields, { add, remove }) => <>{fields.map(field => { const isCurrentProject = allocationDrafts?.[field.name]?.project_code === projectCode; return <div className="project-allocation-row" key={field.key}><div className="project-allocation-row-heading"><Typography.Text strong>分摊 {field.name + 1}</Typography.Text>{isCurrentProject && <Tag color="blue">当前项目</Tag>}<Button type="text" danger size="small" aria-label={`移除分摊 ${field.name + 1}`} icon={<DeleteOutlined />} disabled={fields.length === 1 || isCurrentProject || readonly || write.locked} onClick={() => { remove(field.name); dirty.current = true }} /></div><Row gutter={12}><Col xs={24} sm={15}><Form.Item label="所属项目" name={[field.name, 'project_code']} rules={[{ required: true, message: '请选择项目' }]}><Select aria-label={`分摊项目 ${field.name + 1}`} disabled={isCurrentProject} showSearch optionFilterProp="label" options={projectOptions.map(option => ({ ...option, disabled: allocationDrafts?.some((allocation, index) => index !== field.name && allocation?.project_code === option.value) }))} /></Form.Item></Col><Col xs={24} sm={9}><Form.Item label="分摊金额" name={[field.name, 'amount']} rules={[{ required: true, message: '填写分摊金额' }, moneyRule(true)]}><Input aria-label={`分摊金额 ${field.name + 1}`} inputMode="decimal" suffix="元" /></Form.Item></Col></Row>{remainingAllocation !== null && remainingAllocation > 0 && <Button size="small" type="link" disabled={readonly || write.locked} onClick={() => { form.setFieldValue(['allocations', field.name, 'amount'], centsToYuan((parsedMoney(allocationDrafts?.[field.name]?.amount) ?? 0) + remainingAllocation)); dirty.current = true }}>将剩余 {formatMoney(remainingAllocation)} 分配到此项目</Button>}</div> })}<Button block icon={<PlusOutlined />} onClick={() => { add({ project_code: undefined, amount: '' }); dirty.current = true }} style={{ marginBottom: 20 }}>添加其他项目分摊</Button></>}</Form.List><Typography.Title level={5}>附件与备注</Typography.Title>{attachmentFields}<Form.Item label="合同备注" name="notes"><Input.TextArea rows={3} /></Form.Item></>}
        {(dialog?.kind === 'quoteTransition' || dialog?.kind === 'contractTransition') && <><Alert style={{ marginBottom: 16 }} type="info" title={dialog.kind === 'quoteTransition' ? `报价 V${dialog.item.version_number} · ${quoteLabels[dialog.item.status]}` : `${dialog.item.contract_no} · ${contractLabels[dialog.item.status]}`} /><Form.Item label="目标状态" name="to_status" rules={[{ required: true, message: '请选择目标状态' }]}><Select<QuoteStatus | ContractStatus, { value: QuoteStatus | ContractStatus; label: string }> options={dialog.kind === 'quoteTransition' ? quoteTransitions[dialog.item.status].map(value => ({ value, label: quoteLabels[value] })) : contractTransitions[dialog.item.status].map(value => ({ value, label: contractLabels[value] }))} /></Form.Item><Form.Item label="变更原因" name="reason"><Input.TextArea rows={4} /></Form.Item></>}
        {dialog?.kind === 'term' && <><Form.Item label="计划到期日" name="due_on"><Input type="date" /></Form.Item>{amountField('计划收款金额')}<Form.Item label="计划备注" name="notes"><Input.TextArea rows={4} /></Form.Item><Alert type="info" title={`当前累计到账 ${formatMoney(dialog.item.received_amount_cents)}，计划变更不改动到账流水。`} /></>}
        {dialog?.kind === 'receipt' && <>{dialog.item ? <><Alert type="info" showIcon title="仅修改参考号与备注。金额、日期、节点或归属纠错请作废后重录。" style={{ marginBottom: 16 }} /><Descriptions size="small" column={1} style={{ marginBottom: 16 }} items={[{ key: 'contract', label: '归属合同', children: allocationLabel(dialog.item.contract_allocation_id) }, { key: 'amount', label: '到账金额', children: formatMoney(dialog.item.amount_cents) }, { key: 'date', label: '到账日期', children: dialog.item.received_on }, { key: 'term', label: '节点', children: milestoneLabels[dialog.item.milestone] }]} /></> : <><Form.Item label="归属合同" name="contract_allocation_id" rules={[{ required: true, message: '请选择归属合同' }]}><Select options={receiptAllocations} /></Form.Item>{selectedReceiptAllocation && <div className="project-receipt-context"><Typography.Text strong>{selectedReceiptContract?.contract_no} · {selectedReceiptContract?.title}</Typography.Text><Space wrap><span>本项目金额 {formatMoney(selectedReceiptAllocation.amount_cents)}</span><span>累计到账 {formatMoney(receiptContractCollected)}</span><span>尚未到账 {formatMoney(selectedReceiptAllocation.amount_cents - receiptContractCollected)}</span></Space></div>}<Row gutter={16}><Col span={12}><Form.Item label="收款节点" name="milestone" rules={[{ required: true }]}><Select options={optionsOf(milestoneLabels)} /></Form.Item></Col><Col span={12}><Form.Item label="到账日期" name="received_on" rules={[{ required: true, message: '请选择到账日期' }]}><Input type="date" /></Form.Item></Col></Row>{selectedTerm && <Typography.Paragraph type="secondary">{milestoneLabels[selectedTerm.milestone]}：计划 {formatMoney(selectedTerm.planned_amount_cents)} · 已到账 {formatMoney(selectedTerm.received_amount_cents)} · 未收 {formatMoney(selectedTerm.outstanding_amount_cents)}</Typography.Paragraph>}{amountField('到账金额', true)}<Form.Item label="收款方式" name="payment_method" rules={[{ required: true }]}><Select options={optionsOf(methodLabels)} /></Form.Item></>}<Form.Item label="参考号" name="reference_no"><Input maxLength={200} /></Form.Item><Form.Item label="备注" name="notes"><Input.TextArea rows={4} /></Form.Item></>}
        {dialog?.kind === 'void' && <><Alert type="warning" showIcon style={{ marginBottom: 16 }} title={`确认作废 ${dialog.item.received_on} 的 ${formatMoney(dialog.item.amount_cents)} 到账？`} description="原记录及作废原因将保留，作废金额不再计入有效到账。" /><Form.Item label="作废日期" name="voided_on" rules={[{ required: true, message: '请选择作废日期' }]}><Input type="date" /></Form.Item><Form.Item label="作废原因" name="reason" rules={[{ required: true, whitespace: true, message: '请填写作废原因' }]}><Input.TextArea rows={4} /></Form.Item></>}
      </Form></Space>
    </Drawer>
  </Space>
}
