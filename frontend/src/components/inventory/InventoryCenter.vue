<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'

import type { PagedResult } from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import type {
  InventoryAdjustmentInput,
  InventoryIssueInput,
  InventoryItemDto,
  InventoryItemInput,
  InventoryMovementDto,
} from '../../domain/operations-api'
import {
  createHttpInventoryRepository,
  type InventoryHttpRepository,
  type InventoryListQuery,
} from '../../repositories/inventory.live'

type InventoryAction = 'create' | 'edit' | 'adjust' | 'issue'

const props = defineProps<{ repository?: InventoryHttpRepository }>()
const defaultRepository = createHttpInventoryRepository()
const repository = computed(() => props.repository ?? defaultRepository)
const inventoryPage = ref<PagedResult<InventoryItemDto>>({ items: [], total: 0, page: 1, page_size: 20 })
const movementsPage = ref<PagedResult<InventoryMovementDto>>({ items: [], total: 0, page: 1, page_size: 20 })
const loading = ref(true)
const detailLoading = ref(false)
const loadError = ref('')
const actionError = ref('')
const notice = ref('')
const searchInput = ref('')
const appliedQuery = ref('')
const statusFilter = ref<InventoryListQuery['status']>('all')
const busyAction = ref<InventoryAction | null>(null)
const createVisible = ref(false)
const adjustVisible = ref(false)
const issueVisible = ref(false)
const detailVisible = ref(false)
const editVisible = ref(false)
const selectedItem = ref<InventoryItemDto | null>(null)
const moreInformation = ref<string[]>([])
let listGeneration = 0
let detailGeneration = 0
let mounted = true

const createFormDefaults = {
  brand: '', name: '', model: '', openingQuantity: '0.000', unitPriceYuan: '',
  specification: '', unit: '件', notes: '',
}
const createForm = reactive({ ...createFormDefaults })
const adjustForm = reactive({ quantityDelta: '', reason: '', occurredOn: localISODate() })
const issueForm = reactive({ projectCode: '', issuedOn: localISODate(), quantity: '', notes: '' })
const editForm = reactive({ brand: '', name: '', model: '', specification: '', unit: '', notes: '' })

const items = computed(() => inventoryPage.value.items)
const selectedItemLabel = computed(() => selectedItem.value
  ? [selectedItem.value.brand, selectedItem.value.name, selectedItem.value.model].filter(Boolean).join(' ')
  : '')

function optional(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

function yuanToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error('单价格式不正确，请最多填写两位小数')
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('单价超出可保存范围')
  return Number(cents)
}

function quantityToMilli(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim())
  if (!match) throw new Error('数量格式不正确，请最多填写三位小数')
  return BigInt(match[1]!) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0') || '0')
}

function assertInventoryValueSafe(quantity: string, unitPriceCents: number): void {
  const roundedValueCents = (quantityToMilli(quantity) * BigInt(unitPriceCents) + 500n) / 1000n
  if (roundedValueCents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('库存价值超出可保存范围')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

function clearFeedback(): void {
  actionError.value = ''
  notice.value = ''
}

function listQuery(page = inventoryPage.value.page): InventoryListQuery {
  return {
    page,
    page_size: inventoryPage.value.page_size,
    ...(appliedQuery.value ? { query: appliedQuery.value } : {}),
    status: statusFilter.value,
  }
}

async function loadInventory(page = inventoryPage.value.page): Promise<void> {
  const generation = ++listGeneration
  loading.value = true
  loadError.value = ''
  try {
    const result = await repository.value.listInventoryItems(listQuery(page))
    if (!mounted || generation !== listGeneration) return
    inventoryPage.value = result.data
    if (selectedItem.value) {
      const updated = result.data.items.find((item) => item.id === selectedItem.value?.id)
      if (updated) selectedItem.value = updated
    }
  } catch (error) {
    if (mounted && generation === listGeneration) loadError.value = errorMessage(error)
  } finally {
    if (mounted && generation === listGeneration) loading.value = false
  }
}

async function loadDetail(itemId: number, movementPage = 1): Promise<void> {
  const generation = ++detailGeneration
  detailLoading.value = true
  try {
    const [detail, movements] = await Promise.all([
      repository.value.getInventoryItem(itemId),
      repository.value.listInventoryMovements(itemId, { page: movementPage, page_size: 20 }),
    ])
    if (!mounted || generation !== detailGeneration) return
    selectedItem.value = detail.data
    movementsPage.value = movements.data
  } catch (error) {
    if (mounted && generation === detailGeneration) actionError.value = errorMessage(error)
  } finally {
    if (mounted && generation === detailGeneration) detailLoading.value = false
  }
}

async function refreshAfterMutation(): Promise<void> {
  await loadInventory(inventoryPage.value.page)
  if (detailVisible.value && selectedItem.value) await loadDetail(selectedItem.value.id, movementsPage.value.page)
}

async function runInventoryMutation(
  action: InventoryAction,
  mutation: () => Promise<unknown>,
  committed: () => void,
): Promise<void> {
  if (busyAction.value) return
  clearFeedback()
  busyAction.value = action
  try {
    await mutation()
    committed()
    await refreshAfterMutation()
    if (loadError.value) {
      notice.value = ''
      actionError.value = `操作已保存，但刷新失败：${loadError.value}`
    }
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    busyAction.value = null
  }
}

function applySearch(): void {
  appliedQuery.value = searchInput.value.trim()
  void loadInventory(1)
}

function changeStatus(): void {
  void loadInventory(1)
}

function openCreate(): void {
  clearFeedback()
  Object.assign(createForm, createFormDefaults)
  moreInformation.value = []
  createVisible.value = true
}

function createPayload(): InventoryItemInput {
  if (!createForm.name.trim()) throw new Error('请填写库存名称')
  const price = yuanToCents(createForm.unitPriceYuan)
  assertInventoryValueSafe(createForm.openingQuantity, price)
  return {
    brand: optional(createForm.brand),
    name: createForm.name.trim(),
    model: optional(createForm.model),
    specification: optional(createForm.specification),
    unit: createForm.unit.trim() || '件',
    opening_quantity: createForm.openingQuantity.trim(),
    opening_unit_cost_cents: price,
    notes: optional(createForm.notes),
  }
}

async function createItem(): Promise<void> {
  let payload: InventoryItemInput
  try { payload = createPayload() } catch (error) { actionError.value = errorMessage(error); return }
  await runInventoryMutation('create', () => repository.value.createInventoryItem(payload), () => {
    createVisible.value = false
    notice.value = '新增库存已保存'
  })
}

function cancelCreate(): void {
  if (busyAction.value) return
  try { repository.value.discardCreateInventoryItem(createPayload()) } catch { /* invalid form has no pending request */ }
  createVisible.value = false
}

async function openDetail(item: InventoryItemDto): Promise<void> {
  clearFeedback()
  selectedItem.value = item
  detailVisible.value = true
  await loadDetail(item.id)
}

function openEdit(): void {
  if (!selectedItem.value) return
  clearFeedback()
  Object.assign(editForm, {
    brand: selectedItem.value.brand ?? '', name: selectedItem.value.name,
    model: selectedItem.value.model ?? '', specification: selectedItem.value.specification ?? '',
    unit: selectedItem.value.unit, notes: selectedItem.value.notes ?? '',
  })
  editVisible.value = true
}

async function updateItem(): Promise<void> {
  const item = selectedItem.value
  if (!item || !editForm.name.trim() || !editForm.unit.trim()) {
    actionError.value = '请填写名称和单位'
    return
  }
  await runInventoryMutation('edit', () => repository.value.updateInventoryItem(item.id, {
    brand: optional(editForm.brand), name: editForm.name.trim(), model: optional(editForm.model),
    specification: optional(editForm.specification), unit: editForm.unit.trim(), notes: optional(editForm.notes),
    expected_revision: item.revision,
  }), () => {
    editVisible.value = false
    notice.value = '库存资料已更新'
  })
}

function openAdjustment(item: InventoryItemDto): void {
  clearFeedback()
  selectedItem.value = item
  Object.assign(adjustForm, { quantityDelta: '', reason: '', occurredOn: localISODate() })
  adjustVisible.value = true
}

function adjustmentPayload(item: InventoryItemDto): InventoryAdjustmentInput {
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(adjustForm.quantityDelta.trim())) throw new Error('数量格式不正确，请最多填写三位小数')
  if (!adjustForm.reason.trim()) throw new Error('请填写库存调整原因')
  return {
    item_id: item.id, quantity_delta: adjustForm.quantityDelta.trim(), unit_cost_cents: null,
    reason: adjustForm.reason.trim(), occurred_on: adjustForm.occurredOn,
  }
}

async function adjustItem(): Promise<void> {
  const item = selectedItem.value
  if (!item) return
  let payload: InventoryAdjustmentInput
  try { payload = adjustmentPayload(item) } catch (error) { actionError.value = errorMessage(error); return }
  await runInventoryMutation('adjust', () => repository.value.createInventoryAdjustment(payload), () => {
    adjustVisible.value = false
    notice.value = '库存调整已保存'
  })
}

function openIssue(item: InventoryItemDto): void {
  clearFeedback()
  selectedItem.value = item
  Object.assign(issueForm, { projectCode: '', issuedOn: localISODate(), quantity: '', notes: '' })
  issueVisible.value = true
}

function issuePayload(item: InventoryItemDto): InventoryIssueInput {
  if (!issueForm.projectCode.trim()) throw new Error('请填写项目编号')
  if (quantityToMilli(issueForm.quantity) <= 0n) throw new Error('领用数量必须大于 0')
  return {
    issued_on: issueForm.issuedOn,
    worker_id: null,
    lines: [{ inventory_item_id: item.id, procurement_line_id: null, quantity: issueForm.quantity.trim() }],
    notes: optional(issueForm.notes),
  }
}

async function issueItem(): Promise<void> {
  const item = selectedItem.value
  if (!item) return
  let payload: InventoryIssueInput
  try { payload = issuePayload(item) } catch (error) { actionError.value = errorMessage(error); return }
  const projectCode = issueForm.projectCode.trim()
  await runInventoryMutation('issue', () => repository.value.createProjectInventoryIssue(projectCode, payload), () => {
    issueVisible.value = false
    notice.value = '项目领用已保存'
  })
}

function movementLabel(kind: InventoryMovementDto['movement_type']): string {
  return { opening: '期初库存', goods_receipt: '采购到货', adjustment: '库存调整', project_issue: '项目领用' }[kind]
}

function handleRowCommand(command: string, item: InventoryItemDto): void {
  if (command === 'adjust') openAdjustment(item)
  if (command === 'issue') openIssue(item)
}

void loadInventory(1)
onBeforeUnmount(() => {
  mounted = false
  listGeneration += 1
  detailGeneration += 1
})
</script>

<template>
  <section data-testid="inventory-center" class="inventory-center">
    <header class="inventory-heading">
      <div><h2>库存</h2><p>库存数量只通过期初、到货、调整和项目领用流水变化。</p></div>
      <el-button data-testid="inventory-create-open" type="primary" :disabled="loading" @click="openCreate">新增库存</el-button>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false" class="feedback" />
    <el-alert v-if="actionError" data-testid="inventory-action-error" :title="actionError" type="error" show-icon :closable="false" class="feedback" />
    <el-alert v-if="notice" :title="notice" type="success" show-icon :closable="false" class="feedback" />

    <el-card shadow="never" class="inventory-card">
      <template #header>
        <form class="table-heading" @submit.prevent="applySearch">
          <strong>当前库存</strong>
          <div class="inventory-filters">
            <el-select v-model="statusFilter" aria-label="库存状态" @change="changeStatus">
              <el-option label="全部" value="all" /><el-option label="有库存" value="in_stock" /><el-option label="零库存" value="out_of_stock" />
            </el-select>
            <el-input v-model="searchInput" data-testid="inventory-search" clearable placeholder="搜索品牌、名称、型号" aria-label="搜索库存" />
            <el-button data-testid="inventory-search-submit" native-type="submit">查询</el-button>
          </div>
        </form>
      </template>

      <el-skeleton v-if="loading" :rows="6" animated />
      <el-empty v-else-if="items.length === 0" description="暂无匹配库存" />
      <div v-else class="table-scroll">
        <el-table :data="items" row-key="id" class="inventory-table">
          <el-table-column prop="brand" label="品牌" min-width="100" />
          <el-table-column label="名称" min-width="140"><template #default="scope"><el-button :data-testid="`inventory-detail-open-${scope.row.id}`" link type="primary" @click="openDetail(scope.row)">{{ scope.row.name }}</el-button></template></el-table-column>
          <el-table-column prop="model" label="型号" min-width="120" />
          <el-table-column label="库存数量" min-width="120"><template #default="scope">{{ scope.row.quantity }} {{ scope.row.unit }}</template></el-table-column>
          <el-table-column label="单价" min-width="130"><template #default="scope">{{ formatMoney(scope.row.average_unit_cost_cents) }}</template></el-table-column>
          <el-table-column label="库存价值" min-width="140"><template #default="scope">{{ formatMoney(scope.row.inventory_value_cents) }}</template></el-table-column>
          <el-table-column label="操作" width="96" fixed="right"><template #default="scope"><el-dropdown :data-testid="`inventory-row-actions-${scope.row.id}`" :teleported="false" trigger="click" @command="handleRowCommand($event, scope.row)"><el-button link>更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="adjust">库存调整</el-dropdown-item><el-dropdown-item command="issue">项目领用</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="inventoryPage.total > inventoryPage.page_size" layout="prev, pager, next, total" :current-page="inventoryPage.page" :page-size="inventoryPage.page_size" :total="inventoryPage.total" @current-change="loadInventory" />
    </el-card>

    <el-drawer v-model="detailVisible" data-testid="inventory-detail-drawer" :teleported="false" title="库存物料详情" size="min(94vw, 760px)">
      <el-skeleton v-if="detailLoading" :rows="5" animated />
      <template v-else-if="selectedItem">
        <div class="detail-heading"><div><strong>{{ selectedItemLabel }}</strong><small>{{ selectedItem.specification || '未填写规格' }}</small></div><el-button data-testid="inventory-edit-open" :disabled="Boolean(busyAction)" @click="openEdit">编辑资料</el-button></div>
        <el-descriptions :column="2" border class="inventory-descriptions">
          <el-descriptions-item label="库存数量">{{ selectedItem.quantity }} {{ selectedItem.unit }}</el-descriptions-item>
          <el-descriptions-item label="单价">{{ formatMoney(selectedItem.average_unit_cost_cents) }}</el-descriptions-item>
          <el-descriptions-item label="库存价值">{{ formatMoney(selectedItem.inventory_value_cents) }}</el-descriptions-item>
          <el-descriptions-item label="品牌 / 型号">{{ [selectedItem.brand, selectedItem.model].filter(Boolean).join(' / ') || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="movement-heading"><strong>库存流水</strong><small>流水只追加，不改写历史记录。</small></div>
        <el-alert data-testid="inventory-reversal-unavailable" title="后端暂未提供领用冲销；为避免制造假状态，此处只读。" type="info" :closable="false" />
        <el-empty v-if="movementsPage.items.length === 0" description="暂无库存流水" />
        <div v-else class="table-scroll movement-scroll">
          <el-table :data="movementsPage.items" row-key="id" size="small" class="movement-table">
            <el-table-column label="日期" prop="occurred_on" min-width="112" />
            <el-table-column label="类型" min-width="100"><template #default="scope">{{ movementLabel(scope.row.movement_type) }}</template></el-table-column>
            <el-table-column label="数量变化" min-width="110"><template #default="scope"><strong>{{ scope.row.quantity_delta }} {{ selectedItem.unit }}</strong></template></el-table-column>
            <el-table-column label="关联来源" min-width="150"><template #default="scope">{{ scope.row.source_type }} #{{ scope.row.source_id }}</template></el-table-column>
            <el-table-column label="原因" min-width="180"><template #default="scope">{{ scope.row.reason || '—' }}</template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="movementsPage.total > movementsPage.page_size" layout="prev, pager, next, total" :current-page="movementsPage.page" :page-size="movementsPage.page_size" :total="movementsPage.total" @current-change="selectedItem && loadDetail(selectedItem.id, $event)" />
      </template>
    </el-drawer>

    <el-dialog v-model="createVisible" data-testid="inventory-create-dialog" :teleported="false" title="新增库存" width="min(94vw, 680px)">
      <el-form label-position="top" @submit.prevent="createItem"><el-row :gutter="14">
        <el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="createForm.brand" data-testid="inventory-create-brand" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="名称" required><el-input v-model="createForm.name" data-testid="inventory-create-name" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="createForm.model" data-testid="inventory-create-model" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="数量" required><el-input v-model="createForm.openingQuantity" data-testid="inventory-create-quantity" placeholder="例如 2.500" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="单价（元）" required><el-input v-model="createForm.unitPriceYuan" data-testid="inventory-create-price" inputmode="decimal" placeholder="例如 1289.05" /></el-form-item></el-col>
      </el-row><el-collapse v-model="moreInformation" class="more-information"><el-collapse-item title="更多信息" name="details"><el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="createForm.specification" data-testid="inventory-create-specification" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="单位"><el-input v-model="createForm.unit" data-testid="inventory-create-unit" /></el-form-item></el-col></el-row><el-form-item label="备注"><el-input v-model="createForm.notes" data-testid="inventory-create-notes" type="textarea" /></el-form-item></el-collapse-item></el-collapse><div class="dialog-actions"><el-button data-testid="inventory-create-cancel" :disabled="busyAction === 'create'" @click="cancelCreate">取消</el-button><el-button data-testid="inventory-create-submit" type="primary" native-type="submit" :loading="busyAction === 'create'">保存</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" data-testid="inventory-edit-dialog" :teleported="false" title="编辑库存资料" width="min(94vw, 620px)">
      <el-alert title="数量、单价和库存价值只能通过库存流水变化，此处只编辑物料资料。" type="info" :closable="false" />
      <el-form label-position="top" @submit.prevent="updateItem"><el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="editForm.brand" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="名称" required><el-input v-model="editForm.name" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="editForm.model" data-testid="inventory-edit-model" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="editForm.specification" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="单位" required><el-input v-model="editForm.unit" /></el-form-item></el-col></el-row><el-form-item label="备注"><el-input v-model="editForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="busyAction === 'edit'" @click="editVisible = false">取消</el-button><el-button data-testid="inventory-edit-submit" type="primary" native-type="submit" :loading="busyAction === 'edit'">保存资料</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="adjustVisible" data-testid="inventory-adjust-dialog" :teleported="false" title="库存调整" width="min(92vw, 560px)">
      <el-form label-position="top" @submit.prevent="adjustItem"><el-form-item label="库存物料"><strong>{{ selectedItemLabel }}</strong></el-form-item><el-form-item label="数量变化" required><el-input v-model="adjustForm.quantityDelta" placeholder="增加填 2.000，减少填 -0.500" /></el-form-item><el-form-item label="原因" required><el-input v-model="adjustForm.reason" /></el-form-item><el-form-item label="发生日期"><el-date-picker v-model="adjustForm.occurredOn" type="date" value-format="YYYY-MM-DD" /></el-form-item><div class="dialog-actions"><el-button :disabled="busyAction === 'adjust'" @click="adjustVisible = false">取消</el-button><el-button type="primary" native-type="submit" :loading="busyAction === 'adjust'">保存调整</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="issueVisible" data-testid="inventory-issue-dialog" :teleported="false" title="项目领用" width="min(94vw, 680px)">
      <el-alert title="施工员不在库存接口中硬编码；如需归属到具体人员，请从项目施工记录录入。" type="info" :closable="false" />
      <el-form label-position="top" @submit.prevent="issueItem"><el-form-item label="库存物料"><strong>{{ selectedItemLabel }}</strong></el-form-item><el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="项目编号" required><el-input v-model="issueForm.projectCode" data-testid="inventory-issue-project" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="领用日期"><el-date-picker v-model="issueForm.issuedOn" data-testid="inventory-issue-date" type="date" value-format="YYYY-MM-DD" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="领用数量" required><el-input v-model="issueForm.quantity" data-testid="inventory-issue-quantity" /></el-form-item></el-col></el-row><el-form-item label="备注"><el-input v-model="issueForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="busyAction === 'issue'" @click="issueVisible = false">取消</el-button><el-button data-testid="inventory-issue-submit" type="primary" native-type="submit" :loading="busyAction === 'issue'">确认领用</el-button></div></el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.inventory-center { width: 100%; min-width: 0; }
.inventory-heading, .table-heading, .inventory-filters, .dialog-actions, .detail-heading, .movement-heading { display: flex; align-items: center; }
.inventory-heading, .table-heading, .detail-heading, .movement-heading { justify-content: space-between; gap: 16px; }
.inventory-heading { margin-bottom: 14px; }
.inventory-heading h2 { margin: 0; color: var(--sunyu-ink); font-size: 24px; }
.inventory-heading p { margin: 5px 0 0; color: var(--sunyu-muted); font-size: 13px; }
.feedback { margin-bottom: 12px; }
.inventory-card { min-width: 0; }
.inventory-filters { width: min(100%, 560px); gap: 8px; }
.inventory-filters > :first-child { width: 120px; }
.table-scroll { width: 100%; overflow-x: auto; }
.inventory-table { min-width: 760px; }
.more-information { margin: 2px 0 18px; border-bottom: 0; }
.dialog-actions { justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.detail-heading > div { display: grid; gap: 4px; }
.detail-heading small, .movement-heading small { color: var(--sunyu-muted); }
.inventory-descriptions { margin-top: 16px; }
.movement-heading { margin: 22px 0 10px; }
.movement-scroll { max-width: 100%; margin-top: 10px; }
.movement-table { min-width: 660px; }
.el-pagination { justify-content: flex-end; margin-top: 14px; }
@media (max-width: 700px) {
  .inventory-heading, .table-heading, .detail-heading, .movement-heading { align-items: stretch; flex-direction: column; }
  .inventory-heading > .el-button, .inventory-filters { width: 100%; }
}
@media (max-width: 520px) {
  .inventory-filters { align-items: stretch; flex-direction: column; }
  .inventory-filters > :first-child { width: 100%; }
}
</style>
