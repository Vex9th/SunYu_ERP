import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, Modal, Pagination, Select, Space, Table, Tabs, Tag, Typography, Upload } from 'antd'
import { DownloadOutlined, InboxOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import type { GoodsReceiptDto, GoodsReceiptInput, ProcurementLineDto, ProcurementLineInput, ProcurementListDetailDto, PurchaseOrderInput } from '../../domain/operations-api'
import type { ProcurementImportPreviewDto, PurchaseOrderRecordDto, QuoteExportDto, SupplierInvoiceDto, SupplierPaymentDto } from '../../domain/procurement-extensions'
import { localISODate } from '../../domain/dates'
import { centsToYuan, formatMoney, yuanToCents } from '../../domain/formatters'
import { createHttpProcurementRepository, type ProcurementHttpRepository } from '../../repositories/procurement.live'
import { allocateAmount, mutationScope, optional, positiveQuantity, quantityMilli, remainingQuantity, required, textValue } from './model'
import { ActionFeedback, AttachmentField, AttachmentLinks, downloadBlob, errorText, FormModal, TextField, useBusinessActions, type FormValues } from './ui'
import { useProcurementData, type Customer } from './useProcurementData'
import { useWorkspaceTab } from '../shared'
import ProcurementLists from './ProcurementLists'
import styles from './ProcurementWorkspace.module.css'

const defaultRepository = createHttpProcurementRepository()
const sections = ['lists', 'orders', 'import', 'quotes']
type DialogKind = 'list' | 'edit-list' | 'line' | 'edit-line' | 'order' | 'edit-order' | 'receipt' | 'payment' | 'invoice' | 'cancel-order' | 'reverse-receipt' | 'reverse-payment' | 'reverse-invoice' | 'quote'
interface Dialog { kind: DialogKind; list?: ProcurementListDetailDto; line?: ProcurementLineDto; order?: PurchaseOrderRecordDto; record?: GoodsReceiptDto | SupplierPaymentDto | SupplierInvoiceDto }
interface ImportSession { file: File; name: string; preview: ProcurementImportPreviewDto | null }
const imports = new Map<string, ImportSession>()
const quoteDownloadOwners = new Map<string, () => boolean>()
const titles: Record<DialogKind, string> = { list: '新建采购清单', 'edit-list': '编辑采购清单', line: '添加采购物料', 'edit-line': '编辑采购物料', order: '新建采购单', 'edit-order': '编辑采购单', receipt: '登记到货', payment: '登记供应商付款', invoice: '登记进项发票', 'cancel-order': '取消采购单', 'reverse-receipt': '冲销到货记录', 'reverse-payment': '冲销付款记录', 'reverse-invoice': '冲销进项发票', quote: '生成客户报价单' }
const orderLabels: Record<string, string> = { draft: '草稿', confirmed: '已确认', partially_received: '部分到货', received: '已全部到货', cancelled: '已取消' }
function statusTag(status: string) { return <Tag color={status === 'draft' ? 'default' : status === 'cancelled' ? 'red' : 'blue'}>{orderLabels[status] ?? status}</Tag> }

export default function ProcurementWorkspace({ projectCode, readonly = false, repository = defaultRepository, customerCompany }: { projectCode: string; readonly?: boolean; repository?: ProcurementHttpRepository; customerCompany?: Customer }) {
  const data = useProcurementData(repository, projectCode, customerCompany)
  const [tab, setTab] = useWorkspaceTab('section', sections, 'lists')
  const [selectedListId, setSelectedListId] = useState<number | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [order, setOrder] = useState<PurchaseOrderRecordDto | null>(null)
  const requestedOrderId = useRef<number | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [downloadBusy, setDownloadBusy] = useState<number | string | null>(null)
  const [, setImportVersion] = useState(0)
  const [form] = Form.useForm()
  const [confirm, confirmContext] = Modal.useModal()
  const scope = mutationScope(repository, 'procurement', projectCode)
  const context = useRef({ scope, mounted: true, detailSequence: 0, readonly })
  context.current.scope = scope; context.current.readonly = readonly
  const importSession = imports.get(scope)
  const isCurrent = () => context.current.mounted && context.current.scope === scope
  const canAct = () => isCurrent() && !context.current.readonly

  async function loadOrder(id: number) {
    requestedOrderId.current = id
    const sequence = ++context.current.detailSequence
    setDetailLoading(true); setDetailError('')
    try {
      const result = await repository.getPurchaseOrder(projectCode, id)
      if (isCurrent() && sequence === context.current.detailSequence) setOrder(result.data as PurchaseOrderRecordDto)
    } catch (failure) { if (isCurrent() && sequence === context.current.detailSequence) setDetailError(errorText(failure)); throw failure }
    finally { if (isCurrent() && sequence === context.current.detailSequence) setDetailLoading(false) }
  }
  async function refresh() {
    const results = await Promise.allSettled([data.refresh(), drawer && order ? loadOrder(order.id) : Promise.resolve()])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  const actions = useBusinessActions(scope, refresh, () => { setDialog(null); setFiles([]); setImportVersion((value) => value + 1) })
  const locked = Boolean(actions.pending)
  const listById = new Map(data.catalog.lists.map(list => [list.id, list]))
  const lines = data.catalog.lines.flatMap(line => { const list = listById.get(line.procurement_list_id); return list ? [{ list, line }] : [] })
  const availableLines = lines.filter(({ list }) => list.status === 'confirmed')
  const confirmedLists = data.catalog.lists.filter((list) => list.status === 'confirmed')
  const lineLabel = (id: number) => { const item = lines.find(({ line }) => line.id === id)?.line; return item ? `${item.name}${item.model ? ` · ${item.model}` : ''}` : `采购物料 #${id}` }

  useEffect(() => {
    context.current.mounted = true; context.current.detailSequence++
    const downloadOwner = () => isCurrent()
    quoteDownloadOwners.set(scope, downloadOwner)
    setDialog(null); setOrder(null); setDrawer(false); setDetailError(''); setFiles([]); setSelectedListId(null)
    requestedOrderId.current = null
    return () => {
      context.current.mounted = false; context.current.detailSequence++
      if (quoteDownloadOwners.get(scope) === downloadOwner) quoteDownloadOwners.delete(scope)
    }
  }, [scope])

  function open(next: Dialog) {
    if (!canAct() || locked) return
    actions.setError(''); setFiles([]); form.resetFields()
    const today = localISODate()
    let values: FormValues = { ordered_on: today, received_on: today, paid_on: today, invoiced_on: today, document_version_ids: [], payment_method: '银行转账', lines: [] }
    if (next.kind === 'edit-list') values = { ...values, ...next.list }
    if (next.kind === 'line' || next.kind === 'edit-line') values = { ...values, list_id: next.list?.id, sequence_no: next.line?.sequence_no ?? Math.max(0, ...(next.list?.lines.map((line) => line.sequence_no) ?? [])) + 1, category: next.line?.category ?? '其他', ...next.line, cost: next.line ? centsToYuan(next.line.unit_cost_cents) : '', quoted_price: next.line ? centsToYuan(next.line.quoted_unit_price_cents) : '' }
    if (next.kind === 'order' && next.line) values.lines = [{ procurement_line_id: next.line.id, quantity: quantityMilli(remainingQuantity(next.line.quantity, next.line.ordered_quantity)) > 0n ? remainingQuantity(next.line.quantity, next.line.ordered_quantity) : '', cost: centsToYuan(next.line.unit_cost_cents), overage_reason: '' }]
    if (next.kind === 'order' && !next.line) values.lines = [{ quantity: '', cost: '', overage_reason: '' }]
    if (next.kind === 'edit-order' && next.order) values = { ...values, ...next.order, lines: next.order.lines.map((line) => ({ procurement_line_id: line.procurement_line_id, quantity: line.quantity, cost: centsToYuan(line.unit_cost_cents), overage_reason: line.overage_reason ?? '' })) }
    if (next.kind === 'receipt' && next.order) values.lines = next.order.lines.map((line) => ({ purchase_order_line_id: line.id, quantity: '0' }))
    if (next.kind === 'quote') values = { ...values, list_id: next.list?.id, title: next.list ? `${next.list.name} 报价单` : '' }
    form.setFieldsValue(values); setDialog(next)
  }
  async function openOrder(item: PurchaseOrderRecordDto) { setOrder(null); setDrawer(true); await loadOrder(item.id).catch(() => undefined) }

  async function confirmList(list: ProcurementListDetailDto) {
    if (!canAct() || locked || list.status !== 'draft') return
    const approved = await confirm.confirm({ title: '确认并锁定采购清单？', content: `${list.name} · ${list.lines.length} 项 · 成本 ${formatMoney(list.cost_total_cents)}。确认后不能编辑原清单，可复制为新草稿。`, okText: '确认并锁定', cancelText: '返回检查' })
    if (!approved || !canAct()) return
    const input = { expected_revision: list.revision }
    await actions.run('清单确认', () => repository.confirmProcurementList(projectCode, list.id, input))
  }
  async function copyList(list: ProcurementListDetailDto) {
    if (!canAct() || locked) return
    const input = { expected_revision: list.revision }
    await actions.run('复制清单', () => repository.copyProcurementListAsDraft(projectCode, list.id, input), () => repository.discardCopyProcurementListAsDraft(projectCode, list.id, input))
  }
  async function deleteLine(list: ProcurementListDetailDto, line: ProcurementLineDto) {
    if (!canAct() || locked || list.status !== 'draft') return
    const approved = await confirm.confirm({ title: `删除 ${line.name}？`, content: '删除此草稿物料行后无法恢复。', okText: '删除', cancelText: '取消', okButtonProps: { danger: true } })
    if (approved && canAct()) await actions.run('删除物料', () => repository.deleteProcurementLine(projectCode, list.id, line.id))
  }
  async function confirmOrder() {
    if (!order || order.status !== 'draft' || !canAct() || locked) return
    const selected = order
    const approved = await confirm.confirm({ title: `确认采购单 ${selected.order_no}？`, content: `供应商 ${selected.supplier_company_name ?? ''}，金额 ${formatMoney(selected.ordered_amount_cents)}。确认后可登记到货和付款。`, okText: '确认采购单', cancelText: '返回检查' })
    if (!approved || !canAct()) return
    const input = { expected_revision: selected.revision }
    await actions.run('采购单确认', () => repository.confirmPurchaseOrder(projectCode, selected.id, input))
  }

  function procurementLineInput(values: FormValues): ProcurementLineInput {
    const sequence = Number(values.sequence_no)
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('序号必须是正整数')
    return { sequence_no: sequence, category: required(values.category, '物料分类'), name: required(values.name, '物料名称'), specification: optional(values.specification), brand: optional(values.brand), model: optional(values.model), quantity: positiveQuantity(values.quantity), unit: required(values.unit, '计量单位'), unit_cost_cents: yuanToCents(required(values.cost, '成本单价')), quoted_unit_price_cents: yuanToCents(required(values.quoted_price, '报价单价')) }
  }
  function orderInput(values: FormValues): PurchaseOrderInput {
    const supplier = Number(values.supplier_company_id)
    if (!data.companies.some((company) => company.id === supplier)) throw new Error('请选择有效供应商')
    const drafts = values.lines as Array<FormValues> | undefined
    if (!drafts?.length) throw new Error('请至少添加一项采购物料')
    const seen = new Set<number>()
    const result = drafts.map((draft) => {
      const id = Number(draft.procurement_line_id)
      const item = lines.find(({ line }) => line.id === id)
      if (seen.has(id)) throw new Error('同一物料不能重复添加')
      seen.add(id)
      if (dialog?.kind !== 'edit-order' && (!item || item.list.status !== 'confirmed')) throw new Error('请选择已确认清单中的物料')
      const quantity = positiveQuantity(draft.quantity)
      const overage = optional(draft.overage_reason)
      const capacity = dialog?.kind === 'edit-order' ? item?.line.quantity : item ? remainingQuantity(item.line.quantity, item.line.ordered_quantity) : undefined
      if (capacity && quantityMilli(quantity) > quantityMilli(capacity) && !overage) throw new Error(`${lineLabel(id)}超出采购数量，请填写超采原因`)
      return { procurement_line_id: id, quantity, unit_cost_cents: yuanToCents(required(draft.cost, '成本单价')), overage_reason: overage }
    })
    return { order_no: required(values.order_no, '采购单号'), supplier_company_id: supplier, ordered_on: required(values.ordered_on, '下单日期'), expected_delivery_on: optional(values.expected_delivery_on), lines: result, notes: optional(values.notes), document_version_ids: [...((values.document_version_ids as number[] | undefined) ?? [])] }
  }

  async function submit(values: FormValues) {
    if (!dialog || !canAct() || locked) return
    const currentDialog = dialog
    const selected = currentDialog.order
    try {
      if (currentDialog.kind === 'list') {
        const input = { name: required(values.name, '清单名称'), notes: optional(values.notes) }
        await actions.run('采购清单', async () => {
          const created = await repository.createProcurementList(projectCode, input)
          if (isCurrent()) setSelectedListId(created.data.id)
        }, () => repository.discardCreateProcurementList(projectCode, input))
      } else if (currentDialog.kind === 'edit-list' && currentDialog.list) {
        const list = currentDialog.list
        const input = { name: required(values.name, '清单名称'), notes: optional(values.notes), expected_revision: list.revision }
        await actions.run('采购清单', () => repository.updateProcurementList(projectCode, list.id, input))
      } else if (currentDialog.kind === 'line' || currentDialog.kind === 'edit-line') {
        const list = data.lists.find((entry) => entry.id === Number(values.list_id))
        if (!list || list.status !== 'draft') throw new Error('请选择草稿采购清单')
        const input = procurementLineInput(values)
        if (currentDialog.kind === 'edit-line' && currentDialog.line) {
          const id = currentDialog.line.id
          const update = { ...input, expected_revision: currentDialog.line.revision }
          await actions.run('采购物料', () => repository.updateProcurementLine(projectCode, list.id, id, update))
        } else await actions.run('采购物料', () => repository.createProcurementLine(projectCode, list.id, input), () => repository.discardCreateProcurementLine(projectCode, list.id, input))
      } else if (currentDialog.kind === 'order' || currentDialog.kind === 'edit-order') {
        const input = orderInput(values)
        if (currentDialog.kind === 'edit-order' && selected) {
          if (selected.status !== 'draft') throw new Error('仅草稿采购单允许编辑')
          const update = { ...input, expected_revision: selected.revision }
          await actions.run('采购单', () => repository.updatePurchaseOrder(projectCode, selected.id, update))
        } else {
          const attachments = [...files]
          await actions.run('采购单', () => repository.createPurchaseOrder(projectCode, input, attachments), () => repository.discardCreatePurchaseOrder(projectCode, input, attachments))
        }
      } else if (currentDialog.kind === 'receipt' && selected) {
        const input: GoodsReceiptInput = { received_on: required(values.received_on, '到货日期'), warehouse_name: required(values.warehouse_name, '仓库名称'), notes: optional(values.notes), lines: ((values.lines as Array<{ purchase_order_line_id: number; quantity: string }>) ?? []).flatMap((line) => {
          const quantity = textValue(line.quantity) || '0'
          const amount = quantityMilli(quantity)
          if (amount === 0n) return []
          const source = selected.lines.find((entry) => entry.id === line.purchase_order_line_id)
          if (!source || amount > quantityMilli(remainingQuantity(source.quantity, source.received_quantity))) throw new Error('到货数量不能超过采购单剩余数量')
          return [{ purchase_order_line_id: line.purchase_order_line_id, quantity }]
        }) }
        if (!input.lines.length) throw new Error('请填写本次实际到货数量')
        await actions.run('到货登记', () => repository.receiveGoods(projectCode, selected.id, input), () => repository.discardReceiveGoods(projectCode, selected.id, input))
      } else if (currentDialog.kind === 'payment' && selected) {
        const amount = yuanToCents(required(values.amount, '付款金额'))
        const input = { paid_on: required(values.paid_on, '付款日期'), amount_cents: amount, payment_method: required(values.payment_method, '付款方式'), reference_no: optional(values.reference_no), notes: optional(values.notes), allocations: allocateAmount(selected, amount, 'payment') }
        await actions.run('供应商付款', () => repository.createSupplierPayment(projectCode, selected.id, input), () => repository.discardCreateSupplierPayment(projectCode, selected.id, input))
      } else if (currentDialog.kind === 'invoice' && selected) {
        const amount = yuanToCents(required(values.amount, '发票金额'))
        const input = { invoice_no: required(values.invoice_no, '发票号码'), invoiced_on: required(values.invoiced_on, '开票日期'), amount_cents: amount, allocations: allocateAmount(selected, amount, 'invoice'), document_version_ids: [...((values.document_version_ids as number[] | undefined) ?? [])] }
        const attachments = [...files]
        await actions.run('进项发票', () => repository.createSupplierInvoice(projectCode, selected.id, input, attachments), () => repository.discardCreateSupplierInvoice(projectCode, selected.id, input, attachments))
      } else if (currentDialog.kind === 'cancel-order' && selected) {
        const input = { reason: required(values.reason, '取消原因'), expected_revision: selected.revision }
        await actions.run('取消采购单', () => repository.cancelPurchaseOrder(projectCode, selected.id, input), () => repository.discardCancelPurchaseOrder(projectCode, selected.id, input))
      } else if (currentDialog.kind.startsWith('reverse-') && currentDialog.record) {
        const record = currentDialog.record
        const input = { reason: required(values.reason, '冲销原因'), expected_revision: record.revision }
        const approved = await confirm.confirm({ title: `确认${titles[currentDialog.kind]}？`, content: '按原流水回退业务金额或库存，历史记录将保留。', okText: '确认冲销', cancelText: '返回检查', okButtonProps: { danger: true } })
        if (!approved || !canAct()) return
        if (currentDialog.kind === 'reverse-receipt') await actions.run('到货冲销', () => repository.reverseGoodsReceipt(projectCode, record.id, input), () => repository.discardReverseGoodsReceipt(projectCode, record.id, input))
        if (currentDialog.kind === 'reverse-payment') await actions.run('付款冲销', () => repository.reverseSupplierPayment(projectCode, record.id, input), () => repository.discardReverseSupplierPayment(projectCode, record.id, input))
        if (currentDialog.kind === 'reverse-invoice') await actions.run('进项发票冲销', () => repository.reverseSupplierInvoice(projectCode, record.id, input), () => repository.discardReverseSupplierInvoice(projectCode, record.id, input))
      } else if (currentDialog.kind === 'quote') {
        const list = confirmedLists.find((entry) => entry.id === Number(values.list_id))
        if (!list || !data.customer) throw new Error('请选择已确认清单，并确保项目已绑定客户')
        const input = { title: required(values.title, '报价标题'), customer_company_id: data.customer.id, notes: optional(values.notes) }
        let exportId: number | null = null
        await actions.run('客户报价单', async () => {
          // 每次主动重试捕获当前实例；导航或重新挂载不接管进行中的自动下载。
          const downloadOwner = quoteDownloadOwners.get(scope)
          const canDownload = () => downloadOwner?.() === true && quoteDownloadOwners.get(scope) === downloadOwner
          if (exportId === null) exportId = (await repository.createQuoteExport(projectCode, list.id, input)).data.id
          if (!canDownload()) return
          const blob = await repository.downloadQuoteExport(projectCode, exportId)
          if (canDownload()) downloadBlob(blob, `quote-export-${exportId}.xlsx`)
        }, () => exportId !== null || repository.discardCreateQuoteExport(projectCode, list.id, input))
      }
    } catch (failure) { if (isCurrent()) actions.setError(errorText(failure)) }
  }

  async function previewImport(file: File) {
    if (!canAct() || locked) return
    if (!/\.xlsx$/i.test(file.name)) { actions.setError('请选择 .xlsx 采购清单文件'); return }
    const previous = imports.get(scope)
    if (previous) repository.discardPreviewProcurementImport(projectCode, previous.file)
    const session: ImportSession = { file, name: file.name.replace(/\.xlsx$/i, ''), preview: null }
    imports.set(scope, session); setImportVersion((value) => value + 1)
    await actions.run('Excel 预览', async () => { session.preview = (await repository.previewProcurementImport(projectCode, file)).data }, () => repository.discardPreviewProcurementImport(projectCode, file))
  }
  async function confirmImport() {
    const session = imports.get(scope)
    if (!canAct() || locked || !session?.preview || session.preview.errors.length) return
    try {
      const id = session.preview.id
      const input = { list_name: required(session.name, '导入后的清单名称'), expected_revision: session.preview.revision }
      await actions.run('清单导入', async () => { await repository.confirmProcurementImport(projectCode, id, input); if (imports.get(scope) === session) imports.delete(scope) }, () => repository.discardConfirmProcurementImport(projectCode, id, input))
    } catch (failure) { actions.setError(errorText(failure)) }
  }
  async function downloadQuote(item: QuoteExportDto) {
    if (downloadBusy !== null) return
    setDownloadBusy(item.id)
    try { const blob = await repository.downloadQuoteExport(projectCode, item.id); if (isCurrent()) downloadBlob(blob, `quote-export-${item.id}.xlsx`) }
    catch (failure) { if (isCurrent()) actions.setError(errorText(failure)) }
    finally { if (isCurrent()) setDownloadBusy(null) }
  }
  async function downloadTemplate() {
    setDownloadBusy('template')
    try { const blob = await repository.downloadImportTemplate(); if (isCurrent()) downloadBlob(blob, 'procurement-import-template.xlsx') }
    catch (failure) { if (isCurrent()) actions.setError(errorText(failure)) }
    finally { if (isCurrent()) setDownloadBusy(null) }
  }
  const inputErrors = Object.entries(data.errors).filter(([, error]) => error)
  const receiptDrafts = Form.useWatch('lines', form) as Array<FormValues> | undefined

  return <section className={styles.workspace}>
    {confirmContext}
    {readonly && <Alert type="info" showIcon title="项目已归档，本工作台仅供查看" />}
    <ActionFeedback actions={actions} readonly={readonly} />
    {inputErrors.map(([section, message]) => <Alert key={section} type="warning" showIcon title={`${section}：${message}`} action={<Button onClick={() => void refresh().catch(() => undefined)}>重新读取</Button>} />)}
    <div className={styles.summaryBar}>
      <div className={styles.metrics}>{[
        ['采购承诺', data.overview?.procurement_committed_cents], ['已到货', data.overview?.procurement_received_cents], ['已付款', data.overview?.procurement_paid_cents], ['物料消耗', data.overview?.material_consumed_cents],
      ].map(([label, value]) => <span key={String(label)}><span>{String(label)}</span><strong>{typeof value === 'number' ? formatMoney(value) : '—'}</strong></span>)}</div>
      <Button icon={<ReloadOutlined />} onClick={() => void refresh().catch(() => undefined)}>刷新</Button>
    </div>
    <Card className={styles.mainCard} styles={{ body: { padding: 16 } }}>
      <Tabs activeKey={tab} onChange={setTab} tabBarExtraContent={!readonly && <Space wrap>
        {tab === 'lists' && <><Button disabled={locked} onClick={() => setTab('import')}>导入 Excel</Button><Button type="primary" icon={<PlusOutlined />} disabled={locked || Boolean(data.loading['采购清单'])} onClick={() => open({ kind: 'list' })}>新建清单</Button></>}
        {tab === 'orders' && <Button type="primary" icon={<PlusOutlined />} disabled={locked || !availableLines.length} onClick={() => open({ kind: 'order' })}>新建采购单</Button>}
        {tab === 'quotes' && <Button type="primary" disabled={locked || !confirmedLists.length || !data.customer} onClick={() => open({ kind: 'quote' })}>生成报价单</Button>}
      </Space>} items={[
        { key: 'lists', label: `采购清单 (${data.listPage.total})`, children: <>
          <ProcurementLists lists={data.lists} selectedId={selectedListId} onSelect={setSelectedListId} loading={Boolean(data.loading['采购清单'])} readonly={readonly} locked={locked}
            onCreate={() => open({ kind: 'list' })} onImport={() => setTab('import')}
            onAddLine={(list) => open({ kind: 'line', list })} onEditList={(list) => open({ kind: 'edit-list', list })}
            onConfirmList={(list) => void confirmList(list)} onCopyList={(list) => void copyList(list)}
            onQuote={(list) => open({ kind: 'quote', list })} quoteAvailable={Boolean(data.customer)}
            onEditLine={(list, line) => open({ kind: 'edit-line', list, line })} onDeleteLine={(list, line) => void deleteLine(list, line)}
            onOrderLine={(list, line) => open({ kind: 'order', list, line })} />
          <Pagination className={styles.pagination} current={data.listPage.page} pageSize={data.listPage.page_size} total={data.listPage.total} hideOnSinglePage showSizeChanger pageSizeOptions={[20, 50, 100]} showTotal={(total) => `共 ${total} 份清单`} onChange={(page, size) => void data.loadLists(size !== data.listPage.page_size ? 1 : page, size).catch(() => undefined)} />
        </> },
        { key: 'orders', label: `采购单 (${data.orders.total})`, children: <>
          <div className={styles.toolbar}><Typography.Text type="secondary">点击采购单号查看明细、确认订单或登记到货与付款。</Typography.Text></div>
          <Table<PurchaseOrderRecordDto> rowKey="id" size="small" dataSource={data.orders.items} loading={data.loading['采购单']} scroll={{ x: 850 }} locale={{ emptyText: <Empty description={readonly ? '此项目没有采购单' : availableLines.length ? '还没有采购单，选择供应商和清单物料开始下单' : '先建立并确认采购清单，再创建采购单'}>{!readonly && <Button onClick={() => availableLines.length ? open({ kind: 'order' }) : setTab('lists')} disabled={locked}>{availableLines.length ? '创建第一张采购单' : '前往采购清单'}</Button>}</Empty> }} pagination={{ current: data.orders.page, pageSize: data.orders.page_size, total: data.orders.total, showSizeChanger: true, onChange: (page, size) => void data.loadOrders(size !== data.orders.page_size ? 1 : page, size).catch(() => undefined) }} columns={[
            { title: '采购单号', dataIndex: 'order_no', render: (value: string, item) => <Button type="link" onClick={() => void openOrder(item)}>{value}</Button> }, { title: '供应商', dataIndex: 'supplier_company_name' }, { title: '状态', dataIndex: 'status', render: statusTag }, { title: '下单日期', dataIndex: 'ordered_on' }, { title: '预计到货', dataIndex: 'expected_delivery_on', render: (value: string | null) => value || '—' }, { title: '采购金额', dataIndex: 'ordered_amount_cents', align: 'right', render: formatMoney },
          ]} />
        </> },
        { key: 'import', label: 'Excel 导入', children: <Space orientation="vertical" style={{ width: '100%' }}>
          <div className={styles.toolbar}><Typography.Text type="secondary">下载模板填写物料 → 上传核对 → 确认生成草稿清单</Typography.Text><Button icon={<DownloadOutlined />} loading={downloadBusy === 'template'} onClick={() => void downloadTemplate()}>下载导入模板</Button></div>
          {!readonly && <Upload.Dragger accept=".xlsx" maxCount={1} showUploadList={false} disabled={locked} beforeUpload={(file) => { void previewImport(file); return false }}><p className="ant-upload-drag-icon"><InboxOutlined /></p><p>点击或拖入 Excel 采购清单</p><Typography.Text type="secondary">支持 .xlsx 格式，导入前将显示逐行校验结果</Typography.Text></Upload.Dragger>}
          {importSession && <>
            <Typography.Title level={5}>{importSession.file.name}</Typography.Title>
            {importSession.preview ? <>
              {importSession.preview.errors.length > 0 && <Alert type="error" showIcon title={`发现 ${importSession.preview.errors.length} 处错误，请修正 Excel 后重新上传`} description={<ul>{importSession.preview.errors.map((error, index) => <li key={index}>第 {error.row} 行，第 {error.column} 列 · {error.message}</li>)}</ul>} />}
              <Table<ProcurementLineInput> size="small" rowKey="previewKey" dataSource={importSession.preview.rows.map((row, index) => ({ ...row, previewKey: index }))} scroll={{ x: 800 }} pagination={{ pageSize: 20 }} columns={[{ title: '序号', dataIndex: 'sequence_no' }, { title: '名称', dataIndex: 'name' }, { title: '品牌', dataIndex: 'brand' }, { title: '型号', dataIndex: 'model' }, { title: '数量', dataIndex: 'quantity' }, { title: '单位', dataIndex: 'unit' }, { title: '成本价', dataIndex: 'unit_cost_cents', render: formatMoney }, { title: '报价', dataIndex: 'quoted_unit_price_cents', render: formatMoney }]} />
              {!readonly && <div className={styles.importConfirm}><label htmlFor="procurement-import-name">导入后的清单名称</label><Input id="procurement-import-name" aria-label="导入后的清单名称" value={importSession.name} disabled={locked} onChange={(event) => { importSession.name = event.target.value; setImportVersion((value) => value + 1) }} /><Button type="primary" disabled={locked || !importSession.name.trim() || importSession.preview.errors.length > 0} onClick={() => void confirmImport()}>确认导入</Button></div>}
            </> : !locked && !readonly && <Button onClick={() => void previewImport(importSession.file)}>重新预览</Button>}
            {!readonly && <Button disabled={locked} onClick={() => { repository.discardPreviewProcurementImport(projectCode, importSession.file); imports.delete(scope); setImportVersion((value) => value + 1) }}>清除预览</Button>}
          </>}
        </Space> },
        { key: 'quotes', label: '客户报价', children: <>
          <div className={styles.toolbar}><Typography.Text type="secondary">报价客户：{data.customer?.name ?? '项目未绑定可用客户'} · 选择已确认的采购清单生成 Excel 报价，历史文件可随时下载。</Typography.Text></div>
          <Table<QuoteExportDto> rowKey="id" size="small" dataSource={data.quotes.items} loading={data.loading['报价历史']} locale={{ emptyText: <Empty description={readonly ? '此项目没有报价文件' : !data.customer ? '请先在项目资料中绑定客户，再生成报价' : !confirmedLists.length ? '请先确认采购清单，再生成客户报价' : '还没有报价文件，选择清单后可生成并下载 Excel 报价'}>{!readonly && <Button disabled={locked || !data.customer} onClick={() => confirmedLists.length ? open({ kind: 'quote' }) : setTab('lists')}>{confirmedLists.length ? '创建第一份报价' : '前往采购清单'}</Button>}</Empty> }} pagination={{ current: data.quotes.page, pageSize: data.quotes.page_size, total: data.quotes.total, onChange: (page, size) => void data.loadQuotes(page, size).catch(() => undefined) }} columns={[
            { title: '报价标题', dataIndex: 'title' }, { title: '客户', dataIndex: 'customer_company_name' }, { title: '生成时间', dataIndex: 'created_at', render: (value: string) => new Date(value).toLocaleString('zh-CN') }, { title: '文件', key: 'download', render: (_, item) => <Button type="link" icon={<DownloadOutlined />} loading={downloadBusy === item.id} disabled={downloadBusy !== null} onClick={() => void downloadQuote(item)}>下载报价</Button> },
          ]} />
        </> },
      ]} />
    </Card>
    <Drawer title={order ? `采购单 · ${order.order_no}` : '采购单详情'} open={drawer} size={1000} onClose={() => { setDrawer(false); context.current.detailSequence++ }} loading={detailLoading}>
      {detailError && <Alert type="error" showIcon title={detailError} action={<Button onClick={() => requestedOrderId.current !== null && void loadOrder(requestedOrderId.current).catch(() => undefined)}>重试</Button>} />}
      {order && <Space orientation="vertical" style={{ width: '100%' }}>
        <Descriptions bordered size="small" column={2} items={[{ key: 'supplier', label: '供应商', children: order.supplier_company_name }, { key: 'status', label: '状态', children: statusTag(order.status) }, { key: 'date', label: '下单 / 预计到货', children: `${order.ordered_on} / ${order.expected_delivery_on || '未填写'}` }, { key: 'amount', label: '采购金额', children: formatMoney(order.ordered_amount_cents) }, { key: 'paid', label: '已付款', children: formatMoney(order.paid_amount_cents ?? 0) }, { key: 'invoiced', label: '已开票', children: formatMoney(order.invoiced_amount_cents ?? 0) }, { key: 'files', label: '合同与附件', span: 2, children: <AttachmentLinks projectCode={projectCode} ids={order.document_version_ids} options={data.documents} /> }, { key: 'notes', label: '备注', span: 2, children: order.cancel_reason || order.notes || '—' }]} />
        {!readonly && <Space wrap>{order.status === 'draft' && <><Button disabled={locked} onClick={() => open({ kind: 'edit-order', order })}>编辑采购单</Button><Button type="primary" disabled={locked} onClick={() => void confirmOrder()}>确认采购单</Button></>}
          {['confirmed', 'partially_received'].includes(order.status) && <Button type="primary" disabled={locked} onClick={() => open({ kind: 'receipt', order })}>登记到货</Button>}
          {['confirmed', 'partially_received', 'received'].includes(order.status) && <><Button disabled={locked} onClick={() => open({ kind: 'payment', order })}>登记付款</Button><Button disabled={locked} onClick={() => open({ kind: 'invoice', order })}>登记进项发票</Button></>}
          {['draft', 'confirmed'].includes(order.status) && <Button danger disabled={locked} onClick={() => open({ kind: 'cancel-order', order })}>取消采购单</Button>}
        </Space>}
        <Table size="small" rowKey="id" dataSource={order.lines} pagination={false} scroll={{ x: 720 }} columns={[{ title: '物料', dataIndex: 'procurement_line_id', render: lineLabel }, { title: '采购数量', dataIndex: 'quantity' }, { title: '到货数量', dataIndex: 'received_quantity' }, { title: '成本单价', dataIndex: 'unit_cost_cents', render: formatMoney }, { title: '金额', dataIndex: 'line_amount_cents', render: formatMoney }, { title: '超采原因', dataIndex: 'overage_reason', render: (value: string | null) => value || '—' }]} />
        <Tabs items={[
          { key: 'receipts', label: '到货历史', children: <Space orientation="vertical" style={{ width: '100%' }}>{!(order.goods_receipts?.length) && <Empty description="暂无到货记录" />}{order.goods_receipts?.map((receipt) => <Card key={receipt.id} size="small" title={`${receipt.received_on} · ${receipt.warehouse_name} · #${receipt.id}`} extra={<Space><Tag>{receipt.status === 'active' ? '有效' : '已冲销'}</Tag>{!readonly && receipt.status === 'active' && <Button size="small" danger disabled={locked} onClick={() => open({ kind: 'reverse-receipt', order, record: receipt })}>冲销</Button>}</Space>}>
            {receipt.reversal_reason && <Alert type="warning" title={`冲销原因：${receipt.reversal_reason}`} />}
            <Table size="small" rowKey="id" dataSource={receipt.lines} pagination={false} columns={[{ title: '物料', dataIndex: 'material_name' }, { title: '型号', dataIndex: 'material_model' }, { title: '数量', key: 'quantity', render: (_, line) => `${line.quantity} ${line.unit}` }, { title: '到货价值', dataIndex: 'value_cents', render: formatMoney }]} />
          </Card>)}</Space> },
          { key: 'payments', label: '付款记录', children: <Table<SupplierPaymentDto> size="small" rowKey="id" dataSource={order.supplier_payments ?? []} expandable={{ expandedRowRender: (record) => <AllocationDetails allocations={record.allocations} label={(id) => { const line = order.lines.find((entry) => entry.id === id); return line ? lineLabel(line.procurement_line_id) : `采购单行 #${id}` }} /> }} columns={[
            { title: '日期', dataIndex: 'paid_on' }, { title: '金额', dataIndex: 'amount_cents', render: formatMoney }, { title: '方式 / 参考号', key: 'method', render: (_, record) => `${record.payment_method} · ${record.reference_no || '无'}` }, { title: '状态 / 说明', key: 'status', render: (_, record) => `${record.status === 'active' ? '有效' : '已冲销'} · ${record.reversal_reason || record.notes || '—'}` }, ...(!readonly ? [{ title: '操作', key: 'reverse', render: (_: unknown, record: SupplierPaymentDto) => record.status === 'active' && <Button type="link" danger disabled={locked} onClick={() => open({ kind: 'reverse-payment', order, record })}>冲销</Button> }] : []),
          ]} /> },
          { key: 'invoices', label: '进项发票', children: <Table<SupplierInvoiceDto> size="small" rowKey="id" dataSource={order.supplier_invoices ?? []} expandable={{ expandedRowRender: (record) => <><AllocationDetails allocations={record.allocations} label={(id) => { const line = order.lines.find((entry) => entry.id === id); return line ? lineLabel(line.procurement_line_id) : `采购单行 #${id}` }} /><AttachmentLinks projectCode={projectCode} ids={record.document_version_ids} options={data.documents} /></> }} columns={[
            { title: '发票号码', dataIndex: 'invoice_no' }, { title: '开票日期', dataIndex: 'invoiced_on' }, { title: '金额', dataIndex: 'amount_cents', render: formatMoney }, { title: '状态 / 说明', key: 'status', render: (_, record) => `${record.status === 'active' ? '有效' : '已冲销'} · ${record.reversal_reason || '—'}` }, ...(!readonly ? [{ title: '操作', key: 'reverse', render: (_: unknown, record: SupplierInvoiceDto) => record.status === 'active' && <Button type="link" danger disabled={locked} onClick={() => open({ kind: 'reverse-invoice', order, record })}>冲销</Button> }] : []),
          ]} /> },
        ]} />
      </Space>}
    </Drawer>
    <FormModal title={dialog ? titles[dialog.kind] : ''} form={form} hasChanges={files.length > 0} open={dialog !== null} onClose={() => setDialog(null)} onSubmit={submit} busy={actions.busy} locked={locked || readonly} error={actions.error} width={dialog?.kind.includes('order') || dialog?.kind === 'receipt' ? 900 : 680}>
      {(dialog?.kind === 'list' || dialog?.kind === 'edit-list') && <><TextField name="name" label="清单名称" required /><TextField name="notes" label="备注" type="textarea" /></>}
      {(dialog?.kind === 'line' || dialog?.kind === 'edit-line') && <>
        <Form.Item name="list_id" label="采购清单" rules={[{ required: true }]}><Select disabled={Boolean(dialog.list) || dialog.kind === 'edit-line'} placeholder="请选择草稿清单" options={data.lists.filter((list) => list.status === 'draft').map((list) => ({ value: list.id, label: list.name }))} /></Form.Item>
        <div className={styles.formGrid}><TextField name="sequence_no" label="序号" required /><TextField name="category" label="物料分类" required /><TextField name="name" label="物料名称" required /><TextField name="unit" label="计量单位" required /><TextField name="brand" label="品牌" /><TextField name="model" label="型号" /></div>
        <TextField name="specification" label="规格" /><div className={styles.formGrid}><TextField name="quantity" label="需求数量" required /><TextField name="cost" label="成本单价（元）" required /><TextField name="quoted_price" label="报价单价（元）" required /></div>
      </>}
      {(dialog?.kind === 'order' || dialog?.kind === 'edit-order') && <>
        <div className={styles.formGrid}><TextField name="order_no" label="采购单号" required /><Form.Item name="supplier_company_id" label="供应商" rules={[{ required: true, message: '请选择供应商' }]}><Select placeholder="请明确选择供应商" showSearch optionFilterProp="label" options={data.companies.map((company) => ({ value: company.id, label: company.name }))} /></Form.Item><TextField name="ordered_on" label="下单日期" type="date" required /><TextField name="expected_delivery_on" label="预计到货日期" type="date" /></div>
        <Form.List name="lines">{(fields, { add, remove }) => <Space orientation="vertical" style={{ width: '100%' }}>{fields.map((field) => <Card size="small" key={field.key} title={`物料 ${field.name + 1}`} extra={dialog.kind === 'order' && <Button size="small" type="text" danger icon={<MinusCircleOutlined />} onClick={() => remove(field.name)}>删除</Button>}>
          <Form.Item name={[field.name, 'procurement_line_id']} label="采购物料" rules={[{ required: true, message: '请选择采购物料' }]}><Select disabled={dialog.kind === 'edit-order'} showSearch optionFilterProp="label" options={dialog.kind === 'edit-order' ? dialog.order?.lines.map((line) => ({ value: line.procurement_line_id, label: lineLabel(line.procurement_line_id) })) : availableLines.map(({ list, line }) => ({ value: line.id, label: `${line.name} · ${list.name} · ${quantityMilli(remainingQuantity(line.quantity, line.ordered_quantity)) === 0n ? "已满额，可补采" : `剩余 ${remainingQuantity(line.quantity, line.ordered_quantity)} ${line.unit}`}` }))} onChange={(id) => { const item = lines.find(({ line }) => line.id === id)?.line; if (item) { form.setFieldValue(['lines', field.name, 'cost'], centsToYuan(item.unit_cost_cents)); form.setFieldValue(['lines', field.name, 'quantity'], quantityMilli(remainingQuantity(item.quantity, item.ordered_quantity)) > 0n ? remainingQuantity(item.quantity, item.ordered_quantity) : '') } }} /></Form.Item>
          <div className={styles.formGrid}><TextField name={[field.name, 'quantity']} label="采购数量" required /><TextField name={[field.name, 'cost']} label="成本单价（元）" required /></div><TextField name={[field.name, 'overage_reason']} label="超采原因（超出剩余数量时必填）" />
        </Card>)}{dialog.kind === 'order' && <Button block type="dashed" icon={<PlusOutlined />} onClick={() => add({ quantity: '', cost: '' })}>添加采购物料</Button>}</Space>}</Form.List>
        <TextField name="notes" label="采购说明" type="textarea" />
        {dialog.kind === 'order' ? <AttachmentField files={files} onChange={setFiles} options={data.documents} disabled={locked} /> : <Form.Item name="document_version_ids" label="关联已有资料"><Select mode="multiple" options={data.documents} /></Form.Item>}
      </>}
      {dialog?.kind === 'receipt' && <>
        <Alert type="info" title="仅填写本次实际到货数量，未到货的物料保留为 0" />
        <div className={styles.formGrid}><TextField name="received_on" label="到货日期" type="date" required /><TextField name="warehouse_name" label="仓库名称" required /></div>
        <Form.List name="lines">{(fields) => fields.map((field) => { const item = dialog.order?.lines.find((line) => line.id === receiptDrafts?.[field.name]?.purchase_order_line_id); return <div key={field.key} className={styles.receiptRow}><Form.Item name={[field.name, 'purchase_order_line_id']} hidden><Input /></Form.Item><span>{item ? lineLabel(item.procurement_line_id) : '采购物料'}<small>剩余 {item ? remainingQuantity(item.quantity, item.received_quantity) : '—'}</small></span><TextField name={[field.name, 'quantity']} label="本次到货数量" required /></div> })}</Form.List><TextField name="notes" label="到货说明" type="textarea" />
      </>}
      {dialog?.kind === 'payment' && <><div className={styles.formGrid}><TextField name="paid_on" label="付款日期" type="date" required /><TextField name="amount" label="付款金额（元）" required /><TextField name="payment_method" label="付款方式" required /><TextField name="reference_no" label="参考号" /></div><TextField name="notes" label="付款说明" type="textarea" /></>}
      {dialog?.kind === 'invoice' && <><TextField name="invoice_no" label="发票号码" required /><div className={styles.formGrid}><TextField name="invoiced_on" label="开票日期" type="date" required /><TextField name="amount" label="发票金额（元）" required /></div><AttachmentField files={files} onChange={setFiles} options={data.documents} disabled={locked} /></>}
      {(dialog?.kind === 'cancel-order' || dialog?.kind.startsWith('reverse-')) && <><Alert type="warning" title={dialog.kind === 'cancel-order' ? `取消采购单 ${dialog.order?.order_no}` : `冲销原记录 #${dialog.record?.id}，保留历史流水`} /><TextField name="reason" label={dialog.kind === 'cancel-order' ? '取消原因' : '冲销原因'} required type="textarea" /></>}
      {dialog?.kind === 'quote' && <><Alert type="info" title={`报价客户：${data.customer?.name ?? '未绑定客户'}（随项目固定）`} /><Form.Item name="list_id" label="已确认采购清单" rules={[{ required: true, message: '请选择已确认采购清单' }]}><Select placeholder="请选择用于报价的清单" options={confirmedLists.map((list) => ({ value: list.id, label: list.name }))} onChange={(id) => {
        const selected = confirmedLists.find((list) => list.id === id)
        if (selected && (!form.isFieldTouched('title') || !form.getFieldValue('title'))) form.setFieldValue('title', `${selected.name} 报价单`)
      }} /></Form.Item><TextField name="title" label="报价标题" required /><TextField name="notes" label="报价说明" type="textarea" /></>}
    </FormModal>
  </section>
}

function AllocationDetails({ allocations, label }: { allocations: Array<{ purchase_order_line_id: number; amount_cents: number }>; label: (id: number) => string }) {
  return <Table size="small" rowKey="purchase_order_line_id" dataSource={allocations} pagination={false} columns={[{ title: '采购物料', dataIndex: 'purchase_order_line_id', render: label }, { title: '分摊金额', dataIndex: 'amount_cents', render: formatMoney }]} />
}
