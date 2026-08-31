<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { UploadFile } from 'element-plus'

import type {
  ProcurementLine,
  ProcurementLineInput,
  ProcurementList,
  ProjectProcurementWorkspace,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseOrderStatus,
} from '../../domain/procurement'
import { localISODate } from '../../domain/dates'
import { formatMoney, yuanToCents } from '../../domain/formatters'
import { useDemoBusinessContext } from '../../repositories/demo-context'

const props = defineProps<{
  projectCode: string
}>()

const repository = useDemoBusinessContext().procurement
const workspace = ref<ProjectProcurementWorkspace | null>(null)
const loading = ref(true)
const busy = ref(false)
const notice = ref<string | null>(null)
const actionError = ref<string | null>(null)
const listDialogVisible = ref(false)
const lineDialogVisible = ref(false)
const orderDialogVisible = ref(false)
const eventDialogVisible = ref(false)
const orderDrawerVisible = ref(false)
const selectedOrder = ref<PurchaseOrder | null>(null)
type WorkspaceLine = ProcurementLine & { listId: number; listName: string; listStatus: ProcurementList['status'] }
const selectedLine = ref<WorkspaceLine | null>(null)
const selectedOrderLine = ref<WorkspaceLine | null>(null)
const editingOrder = ref<PurchaseOrder | null>(null)
const selectedFileName = ref('')
const operationProjectCode = ref<string | null>(null)
let loadVersion = 0
type PurchaseEvent = 'payment' | 'receipt' | 'invoice' | 'cancel'
const purchaseEvent = ref<PurchaseEvent>('payment')

const listForm = reactive({ name: '', notes: '' })
const selectedListId = ref(0)
const selectedProcurementListId = ref(0)
const lineForm = reactive<ProcurementLineInput>({
  sequence_no: 1,
  category: '',
  name: '',
  specification: '',
  brand: '',
  model: '',
  quantity: '',
  unit: '',
  unit_cost_cents: 0,
  quoted_unit_price_cents: 0,
})
const lineMoneyForm = reactive({ unitCostYuan: '', quotedUnitPriceYuan: '' })
const suppliers = [
  { id: 8, name: '汇川技术' },
  { id: 9, name: 'SMC' },
]
const orderForm = reactive({
  orderNo: '',
  supplierCompanyId: suppliers[0]!.id,
  orderedOn: localISODate(),
  expectedDeliveryOn: '',
  procurementLineId: 0,
  quantity: '',
  unitCostYuan: '',
  overageReason: '',
  notes: '',
})
const eventForm = reactive({
  occurred_on: '',
  amount_yuan: '',
  payment_method: '',
  reference_no: '',
  warehouse_name: '',
  invoice_no: '',
  purchase_order_line_id: 0,
  quantity: '',
  notes: '',
  reason: '',
})

const eventTitle = computed(() => ({
  payment: '登记供应商付款',
  receipt: '确认到货',
  invoice: '登记进项票',
  cancel: '取消采购单',
})[purchaseEvent.value])

const allProcurementLines = computed<WorkspaceLine[]>(() => (workspace.value?.procurement_lists ?? []).flatMap((list) => (
  list.lines.map((line) => ({ ...line, listId: list.id, listName: list.name, listStatus: list.status }))
)))
const selectedProcurementList = computed(() => workspace.value?.procurement_lists.find(
  (list) => list.id === selectedProcurementListId.value,
) ?? null)
const selectedListLines = computed<WorkspaceLine[]>(() => {
  const list = selectedProcurementList.value
  return list?.lines.map((line) => ({
    ...line,
    listId: list.id,
    listName: list.name,
    listStatus: list.status,
  })) ?? []
})
const editableLists = computed(() => (workspace.value?.procurement_lists ?? []).filter(
  (list) => list.status === 'draft',
))
const lineDialogLists = computed(() => {
  if (!selectedLine.value) return editableLists.value
  const originalList = workspace.value?.procurement_lists.find(
    (list) => list.id === selectedLine.value?.listId,
  )
  return originalList ? [originalList] : []
})
const selectedListCostTotal = computed(() => selectedListLines.value.reduce(
  (total, line) => total + Math.round(Number(line.quantity) * line.unit_cost_cents),
  0,
))
const selectedListQuoteTotal = computed(() => selectedListLines.value.reduce(
  (total, line) => total + Math.round(Number(line.quantity) * line.quoted_unit_price_cents),
  0,
))

function syncSelectedProcurementList(): void {
  const lists = workspace.value?.procurement_lists ?? []
  if (!lists.some((list) => list.id === selectedProcurementListId.value)) {
    selectedProcurementListId.value = lists[0]?.id ?? 0
  }
}

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

function optional(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

async function refreshWorkspace(projectCode: string): Promise<void> {
  const result = await repository.getProjectWorkspace(projectCode)
  if (props.projectCode === projectCode) {
    workspace.value = result.data
    syncSelectedProcurementList()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

async function loadWorkspace(projectCode = props.projectCode): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  actionError.value = null
  try {
    const result = await repository.getProjectWorkspace(projectCode)
    if (version === loadVersion) {
      workspace.value = result.data
      syncSelectedProcurementList()
    }
  } catch (error) {
    if (version === loadVersion) actionError.value = errorMessage(error)
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

async function runMutation(
  projectCode: string,
  mutation: () => Promise<void>,
  onCommitted: () => void,
): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  actionError.value = null
  try {
    await mutation()
  } catch (error) {
    actionError.value = errorMessage(error)
    busy.value = false
    return false
  }
  if (props.projectCode === projectCode) onCommitted()
  try {
    await refreshWorkspace(projectCode)
    return true
  } catch (error) {
    notice.value = null
    if (props.projectCode === projectCode) {
      actionError.value = `操作已保存，但刷新失败：${errorMessage(error)}`
    }
    return false
  } finally {
    busy.value = false
  }
}

function beginOperation(): void {
  operationProjectCode.value = props.projectCode
  actionError.value = null
}

function operationProject(): string | null {
  if (operationProjectCode.value === props.projectCode) return operationProjectCode.value
  actionError.value = '项目已切换，原操作现场已废弃'
  return null
}

function discardOperationState(): void {
  listDialogVisible.value = false
  lineDialogVisible.value = false
  orderDialogVisible.value = false
  eventDialogVisible.value = false
  orderDrawerVisible.value = false
  selectedOrder.value = null
  selectedOrderLine.value = null
  selectedLine.value = null
  editingOrder.value = null
  operationProjectCode.value = null
}

function openListDialog(): void {
  beginOperation()
  listForm.name = ''
  listForm.notes = ''
  listDialogVisible.value = true
}

async function createList(): Promise<void> {
  if (!listForm.name.trim()) {
    actionError.value = '请填写采购清单名称'
    return
  }
  const projectCode = operationProject()
  if (!projectCode) return
  await runMutation(projectCode, () => repository.createProcurementList(projectCode, {
      name: listForm.name.trim(),
      notes: optional(listForm.notes),
    }), () => {
      selectedProcurementListId.value = 0
      listDialogVisible.value = false
      notice.value = '演示采购清单已建立'
  })
}

function openLineDialog(line?: WorkspaceLine): void {
  beginOperation()
  selectedLine.value = line ?? null
  selectedListId.value = line?.listId ?? selectedProcurementList.value?.id ?? editableLists.value[0]?.id ?? 0
  Object.assign(lineForm, line ? {
    sequence_no: line.sequence_no,
    category: line.category,
    name: line.name,
    specification: line.specification,
    brand: line.brand,
    model: line.model,
    quantity: line.quantity,
    unit: line.unit,
    unit_cost_cents: line.unit_cost_cents,
    quoted_unit_price_cents: line.quoted_unit_price_cents,
  } : {
    sequence_no: 1,
    category: '',
    name: '',
    specification: '',
    brand: '',
    model: '',
    quantity: '',
    unit: '',
    unit_cost_cents: 0,
    quoted_unit_price_cents: 0,
  })
  lineMoneyForm.unitCostYuan = line ? centsToYuan(line.unit_cost_cents) : ''
  lineMoneyForm.quotedUnitPriceYuan = line ? centsToYuan(line.quoted_unit_price_cents) : ''
  lineDialogVisible.value = true
}

async function saveLine(): Promise<void> {
  if (selectedListId.value <= 0 || !lineForm.name.trim()) {
    actionError.value = '请选择草稿清单并填写物料名称'
    return
  }
  const projectCode = operationProject()
  if (!projectCode) return
  const editing = selectedLine.value
  await runMutation(projectCode, async () => {
    const unitCostCents = yuanToCents(lineMoneyForm.unitCostYuan)
    const quotedUnitPriceCents = yuanToCents(lineMoneyForm.quotedUnitPriceYuan)
    const input: ProcurementLineInput = {
      ...lineForm,
      category: lineForm.category.trim(),
      name: lineForm.name.trim(),
      specification: lineForm.specification.trim(),
      brand: lineForm.brand.trim(),
      model: lineForm.model.trim(),
      unit: lineForm.unit.trim(),
      unit_cost_cents: unitCostCents,
      quoted_unit_price_cents: quotedUnitPriceCents,
    }
    if (editing) {
      await repository.updateProcurementLine(
        projectCode,
        selectedListId.value,
        editing.id,
        editing.revision,
        input,
      )
    } else {
      await repository.createProcurementLine(projectCode, selectedListId.value, input)
    }
  }, () => {
    lineDialogVisible.value = false
    notice.value = editing ? '采购行已更新（演示数据）' : '演示采购行已加入清单'
    selectedLine.value = null
  })
}

async function confirmList(listId: number, revision: number): Promise<void> {
  const projectCode = props.projectCode
  await runMutation(projectCode, () => repository.confirmProcurementList(projectCode, listId, revision), () => {
    if (props.projectCode !== projectCode) return
    const list = workspace.value?.procurement_lists.find((candidate) => candidate.id === listId)
    if (list) {
      list.status = 'confirmed'
      list.revision += 1
    }
    notice.value = '采购清单已确认（演示数据）'
  })
}

function resetOrderForm(): void {
  Object.assign(orderForm, {
    orderNo: '',
    supplierCompanyId: suppliers[0]!.id,
    orderedOn: localISODate(),
    expectedDeliveryOn: '',
    procurementLineId: 0,
    quantity: '',
    unitCostYuan: '',
    overageReason: '',
    notes: '',
  })
}

function openCreateOrder(line: ProcurementLine): void {
  beginOperation()
  editingOrder.value = null
  resetOrderForm()
  orderForm.procurementLineId = line.id
  orderForm.unitCostYuan = centsToYuan(line.unit_cost_cents)
  orderForm.quantity = line.quantity
  orderDrawerVisible.value = false
  orderDialogVisible.value = true
}

function openEditOrder(order: PurchaseOrder): void {
  const line = order.lines[0]
  if (!line) return
  beginOperation()
  editingOrder.value = order
  Object.assign(orderForm, {
    orderNo: order.order_no,
    supplierCompanyId: order.supplier_company_id,
    orderedOn: order.ordered_on,
    expectedDeliveryOn: order.expected_delivery_on ?? '',
    procurementLineId: line.procurement_line_id,
    quantity: line.quantity,
    unitCostYuan: centsToYuan(line.unit_cost_cents),
    overageReason: line.overage_reason ?? '',
    notes: order.notes ?? '',
  })
  orderDialogVisible.value = true
}

async function saveOrder(): Promise<void> {
  if (!orderForm.orderNo.trim() || orderForm.procurementLineId <= 0) return
  const projectCode = operationProject()
  if (!projectCode) return
  const editing = editingOrder.value
  await runMutation(projectCode, async () => {
    const input: PurchaseOrderInput = {
      order_no: orderForm.orderNo.trim(),
      supplier_company_id: orderForm.supplierCompanyId,
      ordered_on: orderForm.orderedOn,
      expected_delivery_on: optional(orderForm.expectedDeliveryOn),
      lines: [{
        procurement_line_id: orderForm.procurementLineId,
        quantity: orderForm.quantity.trim(),
        unit_cost_cents: yuanToCents(orderForm.unitCostYuan),
        overage_reason: optional(orderForm.overageReason),
      }],
      notes: optional(orderForm.notes),
      document_version_ids: [],
    }
    if (editing) {
      await repository.updatePurchaseOrder(
        projectCode,
        editing.id,
        editing.revision,
        input,
      )
    } else {
      await repository.createPurchaseOrder(projectCode, input)
    }
  }, () => {
    notice.value = editing ? '采购单已更新（演示数据）' : '采购单已新建（演示数据）'
    orderDialogVisible.value = false
    orderDrawerVisible.value = false
    selectedOrder.value = null
    editingOrder.value = null
  })
}

async function confirmOrder(order: PurchaseOrder): Promise<void> {
  const projectCode = operationProjectCode.value === props.projectCode
    ? operationProjectCode.value
    : props.projectCode
  await runMutation(projectCode, () => repository.confirmPurchaseOrder(projectCode, order.id, order.revision), () => {
    notice.value = '演示采购单已确认'
    orderDrawerVisible.value = false
    selectedOrder.value = null
  })
}

function openEvent(order: PurchaseOrder, event: PurchaseEvent): void {
  beginOperation()
  selectedOrder.value = order
  purchaseEvent.value = event
  eventForm.occurred_on = localISODate()
  eventForm.amount_yuan = ''
  eventForm.payment_method = 'bank_transfer'
  eventForm.reference_no = ''
  eventForm.warehouse_name = ''
  eventForm.invoice_no = ''
  eventForm.purchase_order_line_id = order.lines[0]?.id ?? 0
  eventForm.quantity = order.lines[0]?.quantity ?? ''
  eventForm.notes = ''
  eventForm.reason = ''
  eventDialogVisible.value = true
}

function orderForLine(lineId: number): PurchaseOrder | null {
  return workspace.value?.purchase_orders.find((order) => (
    order.lines.some((line) => line.procurement_line_id === lineId)
  )) ?? null
}

function openOrderDrawer(lineId: number): void {
  beginOperation()
  selectedOrderLine.value = allProcurementLines.value.find((line) => line.id === lineId) ?? null
  selectedOrder.value = orderForLine(lineId)
  orderDrawerVisible.value = selectedOrder.value !== null
}

function handleFileChange(file: UploadFile): void {
  selectedFileName.value = file.name
  notice.value = '已选择文件，等待导入接口接入'
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

function downloadDemoQuote(): void {
  const lines = selectedListLines.value
  const tableRows = lines.map((line) => `
    <tr>
      <td>${escapeHtml(line.sequence_no)}</td>
      <td>${escapeHtml(line.name)}</td>
      <td>${escapeHtml([line.specification, line.brand, line.model].filter(Boolean).join(' / '))}</td>
      <td>${escapeHtml(`${line.quantity} ${line.unit}`)}</td>
      <td>${escapeHtml(formatMoney(line.quoted_unit_price_cents))}</td>
    </tr>`).join('')
  const content = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(props.projectCode)} 客户报价单（演示）</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:40px;color:#172033}h1{font-size:24px;margin-bottom:6px}p{color:#647085}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px 12px;border:1px solid #dfe4ea;text-align:left}th{background:#f3f5f7}.notice{margin-top:24px;padding:12px;background:#fff3e8;color:#8a4518}</style></head><body><h1>客户报价单（演示）</h1><p>项目：${escapeHtml(props.projectCode)}</p><table><thead><tr><th>序号</th><th>物料</th><th>规格 / 品牌 / 型号</th><th>数量</th><th>报价单价</th></tr></thead><tbody>${tableRows}</tbody></table><div class="notice">本文件由前端演示数据生成，仅用于界面预览，不代表后端已生成正式单据。</div></body></html>`
  const url = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${props.projectCode}-客户报价单-演示.html`
  anchor.click()
  URL.revokeObjectURL(url)
  notice.value = '已下载演示报价单，仅供界面预览，不代表后端已生成正式单据'
}

function procurementLineName(purchaseOrderLineId: number): string {
  const procurementLineId = selectedOrder.value?.lines.find(
    (line) => line.id === purchaseOrderLineId,
  )?.procurement_line_id
  return allProcurementLines.value.find((line) => line.id === procurementLineId)?.name ?? '采购物料'
}

async function submitEvent(): Promise<void> {
  const order = selectedOrder.value
  if (!order) return
  const projectCode = operationProject()
  if (!projectCode) return

  await runMutation(projectCode, async () => {
    if (purchaseEvent.value === 'payment') {
      const amountCents = yuanToCents(eventForm.amount_yuan)
      await repository.recordSupplierPayment(projectCode, order.id, {
        paid_on: eventForm.occurred_on,
        amount_cents: amountCents,
        payment_method: eventForm.payment_method,
        reference_no: optional(eventForm.reference_no),
        allocations: [{
          purchase_order_line_id: eventForm.purchase_order_line_id,
          amount_cents: amountCents,
        }],
        notes: optional(eventForm.notes),
      })
    } else if (purchaseEvent.value === 'receipt') {
      await repository.recordGoodsReceipt(projectCode, order.id, {
        received_on: eventForm.occurred_on,
        warehouse_name: eventForm.warehouse_name,
        lines: [{
          purchase_order_line_id: eventForm.purchase_order_line_id,
          quantity: eventForm.quantity,
        }],
        notes: optional(eventForm.notes),
      })
    } else if (purchaseEvent.value === 'invoice') {
      const amountCents = yuanToCents(eventForm.amount_yuan)
      await repository.recordSupplierInvoice(projectCode, order.id, {
        invoice_no: eventForm.invoice_no,
        invoiced_on: eventForm.occurred_on,
        amount_cents: amountCents,
        allocations: [{
          purchase_order_line_id: eventForm.purchase_order_line_id,
          amount_cents: amountCents,
        }],
        document_version_ids: [],
      })
    } else {
      await repository.cancelPurchaseOrder(projectCode, order.id, {
        reason: eventForm.reason,
        expected_revision: order.revision,
      })
    }
  }, () => {
    notice.value = purchaseEvent.value === 'cancel'
      ? '演示采购单已取消'
      : `${eventTitle.value}：演示数据已记录`
    eventDialogVisible.value = false
    orderDrawerVisible.value = false
    selectedOrder.value = null
  })
}

function canRecordMoney(order: PurchaseOrder): boolean {
  return ['confirmed', 'partially_received', 'received'].includes(order.status)
}

function canRecordReceipt(order: PurchaseOrder): boolean {
  return order.status === 'confirmed' || order.status === 'partially_received'
}

function canCancelOrder(order: PurchaseOrder): boolean {
  return order.status === 'draft' || order.status === 'confirmed'
}

function orderStatusLabel(status: PurchaseOrderStatus): string {
  return {
    draft: '草稿',
    confirmed: '已确认',
    partially_received: '部分到货',
    received: '已到货',
    cancelled: '已取消',
  }[status]
}

function businessStatusLabel(status: string): string {
  return {
    not_ordered: '未下单',
    partial: '部分',
    ordered: '已下单',
    unpaid: '未付款',
    paid: '已付款',
    not_received: '未到货',
    received: '已到货',
    not_invoiced: '未开票',
    invoiced: '已开票',
    unused: '未使用',
    partially_used: '部分使用',
    used: '已使用',
  }[status] ?? status
}

function businessStatusType(status: string): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'over_ordered') return 'danger'
  if (status === 'partial' || status === 'partially_used') return 'warning'
  if (['ordered', 'paid', 'received', 'invoiced', 'used'].includes(status)) return 'success'
  return 'info'
}

watch(() => props.projectCode, (projectCode) => {
  discardOperationState()
  notice.value = null
  actionError.value = null
  void loadWorkspace(projectCode)
})
onMounted(() => void loadWorkspace(props.projectCode))
</script>

<template>
  <el-space
    data-testid="procurement-workspace"
    class="procurement-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="18"
  >
    <section class="procurement-heading">
      <div>
        <el-space wrap>
          <h2>采购</h2>
          <el-tag size="small" type="warning" effect="plain">演示数据</el-tag>
        </el-space>
        <p>{{ projectCode }} · 采购清单、订单进度和日常操作集中处理。</p>
      </div>
    </section>

    <el-alert v-if="notice" :title="notice" type="info" :closable="false" />
    <el-alert
      v-if="actionError"
      data-testid="procurement-action-error"
      :title="actionError"
      type="error"
      show-icon
      :closable="false"
    />

    <el-card v-if="loading" shadow="never"><el-skeleton :rows="7" animated /></el-card>
    <el-card v-else-if="workspace" shadow="never" class="procurement-list-card">
      <template #header>
        <div class="procurement-toolbar">
          <div>
            <el-text tag="strong">采购清单</el-text>
            <p class="procurement-note">先选择清单，再维护物料和采购进度。</p>
          </div>
          <el-space wrap class="procurement-actions">
            <el-button
              tag="a"
              data-testid="procurement-template-download"
              href="/templates/procurement-import-template.xlsx"
              download
            >下载采购模板</el-button>
            <el-upload
              data-testid="procurement-import-upload"
              :auto-upload="false"
              :show-file-list="false"
              accept=".xlsx"
              :limit="1"
              :on-change="handleFileChange"
            >
              <el-button>导入 Excel</el-button>
            </el-upload>
            <el-button
              data-testid="procurement-list-create-open"
              type="primary"
              plain
              @click="openListDialog"
            >新增临时采购</el-button>
            <el-button data-testid="procurement-quote-action" @click="downloadDemoQuote">生成客户报价单</el-button>
          </el-space>
        </div>
        <el-text class="template-help" size="small" type="info">模板已内置在网页中，包含名称、规格、品牌、型号、数量、单位、成本价和报价等列。</el-text>
        <el-text v-if="selectedFileName" size="small" type="info">已选择：{{ selectedFileName }}</el-text>
      </template>

      <section v-if="selectedProcurementList" data-testid="procurement-list-summary" class="list-workbench">
        <div class="list-selector-block">
          <el-text size="small" type="info">当前清单</el-text>
          <el-select
            v-model="selectedProcurementListId"
            data-testid="procurement-list-select"
            aria-label="选择采购清单"
          >
            <el-option
              v-for="list in workspace.procurement_lists"
              :key="list.id"
              :label="list.name"
              :value="list.id"
            />
          </el-select>
        </div>
        <div class="list-summary-main">
          <el-space wrap :size="8">
            <strong>{{ selectedProcurementList.name }}</strong>
            <el-tag
              size="small"
              :type="selectedProcurementList.status === 'confirmed' ? 'success' : 'info'"
            >{{ selectedProcurementList.status === 'confirmed' ? '已确认' : '草稿' }}</el-tag>
          </el-space>
          <p>{{ selectedProcurementList.notes || '暂无备注' }}</p>
          <el-space wrap :size="16" class="list-metrics">
            <span>{{ selectedListLines.length }} 项物料</span>
            <span>预计成本 {{ formatMoney(selectedListCostTotal) }}</span>
            <span>对外报价 {{ formatMoney(selectedListQuoteTotal) }}</span>
          </el-space>
        </div>
        <el-space wrap class="list-actions">
          <el-button
            data-testid="procurement-line-open"
            type="primary"
            :disabled="busy || selectedProcurementList.status !== 'draft'"
            @click="openLineDialog()"
          >新增物料</el-button>
          <el-button
            v-if="selectedProcurementList.status === 'draft'"
            :data-testid="`procurement-list-confirm-${selectedProcurementList.id}`"
            :loading="busy"
            :disabled="busy"
            @click="confirmList(selectedProcurementList.id, selectedProcurementList.revision)"
          >确认清单</el-button>
        </el-space>
      </section>

      <div data-testid="procurement-table-scroll" class="procurement-table-scroll">
        <el-empty
          v-if="selectedListLines.length === 0"
          data-testid="procurement-list-empty"
          description="这张清单还没有物料"
          :image-size="72"
        />
        <el-table v-else :data="selectedListLines" row-key="id" class="procurement-table">
          <el-table-column prop="sequence_no" label="序号" width="66" />
          <el-table-column label="物料" min-width="170">
            <template #default="scope">
              <div class="material-cell">
                <strong>{{ scope.row.name }}</strong>
                <small>{{ scope.row.category || '未分类' }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="规格 / 品牌 / 型号" min-width="190">
            <template #default="scope">{{ [scope.row.specification, scope.row.brand, scope.row.model].filter(Boolean).join(' / ') || '—' }}</template>
          </el-table-column>
          <el-table-column label="数量" width="105"><template #default="scope">{{ scope.row.quantity }} {{ scope.row.unit }}</template></el-table-column>
          <el-table-column label="价格" min-width="145">
            <template #default="scope">
              <div class="price-cell">
                <span>成本 {{ formatMoney(scope.row.unit_cost_cents) }}</span>
                <span>报价 {{ formatMoney(scope.row.quoted_unit_price_cents) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="采购进度" min-width="290">
            <template #default="scope">
              <el-space :data-testid="`procurement-progress-${scope.row.id}`" wrap :size="5" class="progress-cell">
                <el-tag size="small" :type="businessStatusType(scope.row.order_status)">下单 {{ businessStatusLabel(scope.row.order_status) }}</el-tag>
                <el-tag size="small" :type="businessStatusType(scope.row.payment_status)">付款 {{ businessStatusLabel(scope.row.payment_status) }}</el-tag>
                <el-tag size="small" :type="businessStatusType(scope.row.receipt_status)">到货 {{ businessStatusLabel(scope.row.receipt_status) }}</el-tag>
                <el-tag size="small" :type="businessStatusType(scope.row.invoice_status)">开票 {{ businessStatusLabel(scope.row.invoice_status) }}</el-tag>
                <el-tag size="small" :type="businessStatusType(scope.row.usage_status)">使用 {{ businessStatusLabel(scope.row.usage_status) }}</el-tag>
              </el-space>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope">
              <el-space class="procurement-row-actions" wrap :size="4">
                <el-button
                  v-if="orderForLine(scope.row.id)"
                  data-testid="purchase-order-detail-open"
                  link
                  type="primary"
                  @click="openOrderDrawer(scope.row.id)"
                >订单详情</el-button>
                <el-button
                  v-else-if="scope.row.listStatus === 'confirmed'"
                  :data-testid="`purchase-order-create-${scope.row.id}`"
                  link
                  type="primary"
                  @click="openCreateOrder(scope.row)"
                >创建采购单</el-button>
                <el-button
                  v-if="scope.row.listStatus === 'draft'"
                  :data-testid="`procurement-line-edit-${scope.row.id}`"
                  link
                  @click="openLineDialog(scope.row)"
                >编辑</el-button>
              </el-space>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="procurement-mobile-list">
        <el-empty
          v-if="selectedListLines.length === 0"
          description="这张清单还没有物料"
          :image-size="64"
        />
        <el-card v-for="line in selectedListLines" :key="line.id" shadow="never" class="procurement-mobile-item">
          <div class="mobile-item-heading"><strong>{{ line.name }}</strong><span>{{ line.quantity }} {{ line.unit }}</span></div>
          <small>{{ [line.specification, line.brand, line.model].filter(Boolean).join(' / ') || '未填写规格' }}</small>
          <el-space wrap :size="6" class="mobile-statuses">
            <el-tag size="small" :type="businessStatusType(line.order_status)">下单：{{ businessStatusLabel(line.order_status) }}</el-tag>
            <el-tag size="small" :type="businessStatusType(line.receipt_status)">到货：{{ businessStatusLabel(line.receipt_status) }}</el-tag>
            <el-tag size="small" :type="businessStatusType(line.usage_status)">使用：{{ businessStatusLabel(line.usage_status) }}</el-tag>
          </el-space>
          <div class="mobile-item-actions">
            <el-button v-if="orderForLine(line.id)" link type="primary" @click="openOrderDrawer(line.id)">订单详情</el-button>
            <el-button v-else-if="line.listStatus === 'confirmed'" link type="primary" @click="openCreateOrder(line)">创建采购单</el-button>
            <el-button v-if="line.listStatus === 'draft'" link @click="openLineDialog(line)">编辑</el-button>
          </div>
        </el-card>
      </div>
    </el-card>

    <el-drawer
      v-model="orderDrawerVisible"
      data-testid="purchase-order-drawer"
      :teleported="false"
      title="采购单详情"
      size="min(92vw, 560px)"
    >
      <template v-if="selectedOrder">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="采购单号">{{ selectedOrder.order_no }}</el-descriptions-item>
          <el-descriptions-item label="下单日期">{{ selectedOrder.ordered_on }}</el-descriptions-item>
          <el-descriptions-item label="预计到货">{{ selectedOrder.expected_delivery_on || '—' }}</el-descriptions-item>
          <el-descriptions-item label="订单状态">{{ orderStatusLabel(selectedOrder.status) }}</el-descriptions-item>
        </el-descriptions>
        <el-space wrap class="drawer-actions">
          <el-button
            v-if="selectedOrderLine?.listStatus === 'confirmed'"
            data-testid="purchase-order-create-from-detail"
            type="primary"
            plain
            :disabled="busy"
            @click="openCreateOrder(selectedOrderLine)"
          >继续下单</el-button>
          <el-button
            v-if="selectedOrder.status === 'draft'"
            data-testid="purchase-order-edit"
            :disabled="busy"
            @click="openEditOrder(selectedOrder)"
          >编辑草稿</el-button>
          <el-button
            v-if="selectedOrder.status === 'draft'"
            data-testid="purchase-order-confirm"
            type="primary"
            plain
            :loading="busy"
            :disabled="busy"
            @click="confirmOrder(selectedOrder)"
          >确认订单</el-button>
          <el-button data-testid="purchase-payment-open" :disabled="busy || !canRecordMoney(selectedOrder)" @click="openEvent(selectedOrder, 'payment')">付款</el-button>
          <el-button data-testid="purchase-receipt-open" :disabled="busy || !canRecordReceipt(selectedOrder)" @click="openEvent(selectedOrder, 'receipt')">到货</el-button>
          <el-button data-testid="purchase-invoice-open" :disabled="busy || !canRecordMoney(selectedOrder)" @click="openEvent(selectedOrder, 'invoice')">开票</el-button>
          <el-button
            v-if="selectedOrder.status !== 'cancelled'"
            data-testid="purchase-order-cancel-open"
            type="danger"
            plain
            :disabled="busy || !canCancelOrder(selectedOrder)"
            @click="openEvent(selectedOrder, 'cancel')"
          >取消</el-button>
        </el-space>
      </template>
    </el-drawer>

    <el-dialog v-model="listDialogVisible" :teleported="false" title="新建采购清单" width="min(92vw, 520px)">
      <el-form label-position="top" @submit.prevent="createList">
        <el-form-item label="清单名称"><el-input v-model="listForm.name" data-testid="procurement-list-name" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="listForm.notes" type="textarea" /></el-form-item>
        <el-button data-testid="procurement-list-create-submit" type="primary" native-type="submit" :loading="busy" :disabled="busy">建立演示清单</el-button>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="lineDialogVisible"
      data-testid="procurement-line-dialog"
      :teleported="false"
      :title="selectedLine ? '编辑采购行' : '新增采购行'"
      width="min(94vw, 760px)"
    >
      <el-form label-position="top" @submit.prevent="saveLine">
        <el-form-item label="采购清单">
          <el-select
            v-model="selectedListId"
            data-testid="procurement-line-list-select"
            :class="{ 'is-disabled': Boolean(selectedLine) }"
            :disabled="Boolean(selectedLine)"
            style="width: 100%"
          >
            <el-option
              v-for="list in lineDialogLists"
              :key="list.id"
              :label="list.name"
              :value="list.id"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="14">
          <el-col :xs="24" :sm="8"><el-form-item label="序号"><el-input-number v-model="lineForm.sequence_no" :min="1" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="类别"><el-input v-model="lineForm.category" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="名称"><el-input v-model="lineForm.name" :disabled="Boolean(selectedLine && selectedLine.receipt_status !== 'not_received')" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="lineForm.specification" :disabled="Boolean(selectedLine && selectedLine.receipt_status !== 'not_received')" /></el-form-item></el-col>
          <el-col :xs="24" :sm="6"><el-form-item label="品牌"><el-input v-model="lineForm.brand" :disabled="Boolean(selectedLine && selectedLine.receipt_status !== 'not_received')" /></el-form-item></el-col>
          <el-col :xs="24" :sm="6"><el-form-item label="型号"><el-input v-model="lineForm.model" :disabled="Boolean(selectedLine && selectedLine.receipt_status !== 'not_received')" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="数量"><el-input v-model="lineForm.quantity" data-testid="procurement-line-quantity" placeholder="例如 2.500" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="单位"><el-input v-model="lineForm.unit" :disabled="Boolean(selectedLine && selectedLine.receipt_status !== 'not_received')" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="成本单价（元）"><el-input v-model="lineMoneyForm.unitCostYuan" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col>
          <el-col :xs="24" :sm="8"><el-form-item label="报价单价（元）"><el-input v-model="lineMoneyForm.quotedUnitPriceYuan" data-testid="procurement-line-quote-price" inputmode="decimal" placeholder="0.00" /></el-form-item></el-col>
        </el-row>
        <el-button data-testid="procurement-line-submit" type="primary" native-type="submit" :loading="busy" :disabled="busy">
          {{ selectedLine ? '保存采购行' : '加入演示清单' }}
        </el-button>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="orderDialogVisible"
      data-testid="purchase-order-dialog"
      :teleported="false"
      :title="editingOrder ? '编辑采购单' : '新建采购单'"
      width="min(94vw, 720px)"
    >
      <el-alert title="当前演示表单一次维护一个采购物料；业务状态仍由仓储统一派生。" type="info" :closable="false" />
      <el-form class="order-form" label-position="top" @submit.prevent="saveOrder">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="采购单号"><el-input v-model="orderForm.orderNo" data-testid="purchase-order-number" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="供应商">
              <el-select v-model="orderForm.supplierCompanyId" data-testid="purchase-order-supplier" style="width: 100%">
                <el-option v-for="supplier in suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="下单日期"><el-date-picker v-model="orderForm.orderedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="预计到货"><el-date-picker v-model="orderForm.expectedDeliveryOn" type="date" value-format="YYYY-MM-DD" clearable style="width: 100%" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="采购物料">
              <el-select v-model="orderForm.procurementLineId" style="width: 100%">
                <el-option v-for="line in selectedListLines" :key="line.id" :label="line.name" :value="line.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="采购数量"><el-input v-model="orderForm.quantity" data-testid="purchase-order-quantity" placeholder="例如 4.500" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="成本单价（元）"><el-input v-model="orderForm.unitCostYuan" data-testid="purchase-order-unit-cost" inputmode="decimal" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="超采原因"><el-input v-model="orderForm.overageReason" placeholder="未超出清单数量可不填" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="orderForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="busy" @click="orderDialogVisible = false">取消</el-button>
          <el-button data-testid="purchase-order-submit" type="primary" native-type="submit" :loading="busy" :disabled="busy">保存采购单</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="eventDialogVisible"
      data-testid="purchase-event-dialog"
      :teleported="false"
      :title="eventTitle"
      width="min(94vw, 640px)"
    >
      <el-form label-position="top" @submit.prevent="submitEvent">
        <template v-if="purchaseEvent === 'payment'">
          <el-form-item data-testid="purchase-event-date" label="付款日期"><el-date-picker v-model="eventForm.occurred_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
          <el-form-item label="付款金额（元）"><el-input v-model="eventForm.amount_yuan" data-testid="purchase-event-amount" inputmode="decimal" placeholder="0.00" /></el-form-item>
          <el-form-item label="付款方式"><el-select v-model="eventForm.payment_method" data-testid="purchase-event-method" style="width: 100%"><el-option value="bank_transfer" label="银行转账" /><el-option value="cash" label="现金" /><el-option value="other" label="其他" /></el-select></el-form-item>
          <el-form-item label="参考号"><el-input v-model="eventForm.reference_no" /></el-form-item>
        </template>
        <template v-else-if="purchaseEvent === 'receipt'">
          <el-form-item data-testid="purchase-event-date" label="到货日期"><el-date-picker v-model="eventForm.occurred_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
          <el-form-item label="仓库名称"><el-input v-model="eventForm.warehouse_name" /></el-form-item>
          <el-form-item label="到货数量"><el-input v-model="eventForm.quantity" data-testid="purchase-event-quantity" /></el-form-item>
        </template>
        <template v-else-if="purchaseEvent === 'invoice'">
          <el-form-item label="发票号码"><el-input v-model="eventForm.invoice_no" data-testid="purchase-event-invoice-no" /></el-form-item>
          <el-form-item data-testid="purchase-event-date" label="开票日期"><el-date-picker v-model="eventForm.occurred_on" type="date" value-format="YYYY-MM-DD" :clearable="false" style="width:100%" /></el-form-item>
          <el-form-item label="发票金额（元）"><el-input v-model="eventForm.amount_yuan" data-testid="purchase-event-amount" inputmode="decimal" placeholder="0.00" /></el-form-item>
        </template>
        <el-form-item v-if="purchaseEvent !== 'cancel'" label="采购物料">
          <el-select v-model="eventForm.purchase_order_line_id" style="width: 100%">
            <el-option v-for="line in selectedOrder?.lines ?? []" :key="line.id" :value="line.id" :label="procurementLineName(line.id)" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="purchaseEvent === 'cancel'" data-testid="purchase-cancel-reason" label="取消原因"><el-input v-model="eventForm.reason" type="textarea" /></el-form-item>
        <el-form-item v-if="purchaseEvent === 'payment' || purchaseEvent === 'receipt'" label="备注"><el-input v-model="eventForm.notes" type="textarea" /></el-form-item>
        <el-button
          data-testid="purchase-event-submit"
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="busy"
        >{{ purchaseEvent === 'cancel' ? '确认取消' : '保存演示记录' }}</el-button>
      </el-form>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.procurement-stack { width: 100%; min-width: 0; }
.procurement-stack > :deep(.el-space__item) { width: 100%; min-width: 0 !important; max-width: 100%; }
.procurement-heading { padding: 14px 16px; border-bottom: 1px solid var(--sunyu-border); background: var(--sunyu-surface); }
.procurement-heading h2 { margin: 0; color: var(--sunyu-ink); font-size: 22px; }
.procurement-heading p, .procurement-note { margin: 0; color: var(--sunyu-muted); font-size: 13px; }
.procurement-list-card { min-width: 0; }
.procurement-table-scroll { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
.procurement-table { width: 100%; min-width: 0; }
.procurement-mobile-list { display: none; }
.procurement-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px 20px; }
.procurement-actions { justify-content: flex-end; }
.template-help { display: block; margin-top: 8px; }
.list-workbench {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(260px, 1fr) auto;
  align-items: center;
  gap: 16px 24px;
  margin-bottom: 12px;
  padding: 14px;
  border: 1px solid var(--sunyu-border);
  border-radius: 8px;
  background: var(--sunyu-surface-soft, #f7f8fa);
}
.list-selector-block { display: grid; gap: 5px; min-width: 0; }
.list-selector-block :deep(.el-select) { width: 100%; }
.list-summary-main { min-width: 0; }
.list-summary-main p { margin: 4px 0 7px; color: var(--sunyu-muted); font-size: 13px; }
.list-metrics { color: var(--sunyu-muted); font-size: 13px; }
.list-actions { justify-content: flex-end; }
.material-cell, .price-cell { display: grid; gap: 3px; }
.material-cell small, .price-cell span:first-child { color: var(--sunyu-muted); font-size: 12px; }
.progress-cell { width: 100%; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.drawer-actions { margin-top: 18px; }
.procurement-row-actions { justify-content: flex-start; width: 100%; }
.procurement-row-actions :deep(.el-button + .el-button) { margin-left: 0; }

@media (max-width: 1100px) {
  .procurement-toolbar { align-items: flex-start; flex-direction: column; }
  .procurement-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
  .list-workbench { grid-template-columns: minmax(200px, .75fr) minmax(260px, 1.25fr); }
  .list-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .procurement-heading { padding: 12px; }
  .procurement-actions :deep(.el-space__item),
  .procurement-actions :deep(.el-button),
  .procurement-actions :deep(.el-upload) { width: 100%; }
  .procurement-table-scroll { display: none; }
  .procurement-mobile-list { display: grid; gap: 10px; }
  .procurement-mobile-item :deep(.el-card__body) { display: grid; gap: 9px; padding: 14px; }
  .mobile-item-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .mobile-item-heading span,
  .procurement-mobile-item small { color: var(--sunyu-muted); }
  .mobile-statuses { width: 100%; }
  .mobile-item-actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .mobile-item-actions :deep(.el-button + .el-button) { margin-left: 0; }
}

@media (max-width: 520px) {
  .procurement-actions { grid-template-columns: 1fr; }
  .list-workbench { grid-template-columns: 1fr; padding: 12px; }
  .list-actions { grid-column: auto; display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
  .list-actions :deep(.el-space__item), .list-actions :deep(.el-button) { width: 100%; }
}
</style>
