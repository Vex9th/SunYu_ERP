<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import type { PagedResult } from '../../domain/contracts'
import { localISODate } from '../../domain/dates'
import { formatMoney } from '../../domain/formatters'
import type {
  InventoryAdjustmentInput,
  InventoryAdjustmentReversalInput,
  InventoryIssueInput,
  InventoryIssueReversalInput,
  InventoryItemDto,
  InventoryItemInput,
  InventoryMovementDto,
} from '../../domain/operations-api'
import {
  createHttpInventoryRepository,
  type InventoryHttpRepository,
  type InventoryIssueProjectOption,
  type InventoryIssueWorkerOption,
  type InventoryListQuery,
} from '../../repositories/inventory.live'

type InventoryAction = 'create' | 'edit' | 'adjust' | 'issue' | 'reverse'

const props = defineProps<{ repository?: InventoryHttpRepository }>()
const emit = defineEmits<{ changed: [] }>()
const defaultRepository = createHttpInventoryRepository()
const repository = computed(() => props.repository ?? defaultRepository)
const inventoryPage = ref<PagedResult<InventoryItemDto>>({ items: [], total: 0, page: 1, page_size: 20 })
const movementsPage = ref<PagedResult<InventoryMovementDto>>({ items: [], total: 0, page: 1, page_size: 20 })
const loading = ref(true)
const detailLoading = ref(false)
const movementsLoading = ref(false)
const loadError = ref('')
const actionError = ref('')
const formError = ref('')
const detailError = ref('')
const movementsError = ref('')
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
const reverseVisible = ref(false)
const adjustmentReverseVisible = ref(false)
const selectedItem = ref<InventoryItemDto | null>(null)
const selectedIssueMovement = ref<InventoryMovementDto | null>(null)
const selectedAdjustmentMovement = ref<InventoryMovementDto | null>(null)
const detailLoadedItemId = ref<number | null>(null)
const movementsLoadedItemId = ref<number | null>(null)
const moreInformation = ref<string[]>([])
let listGeneration = 0
let detailGeneration = 0
let movementsGeneration = 0
let issueWorkerGeneration = 0
let issueInventoryGeneration = 0
let contextGeneration = 0
let adjustmentConfirmationOpen = false
let mounted = true

const createFormDefaults = {
  brand: '', name: '', model: '', openingQuantity: '0.000', unitPriceYuan: '',
  specification: '', unit: '', notes: '',
}
const createForm = reactive({ ...createFormDefaults })
const adjustForm = reactive({ quantityDelta: '', unitCostYuan: '', reason: '', occurredOn: localISODate() })
const issueForm = reactive({ projectCode: '', workerId: null as number | null, issuedOn: localISODate(), notes: '' })
const issueCandidates = ref<InventoryItemDto[]>([])
const issueProjects = ref<InventoryIssueProjectOption[]>([])
const issueWorkers = ref<InventoryIssueWorkerOption[]>([])
const selectedIssueItemIds = ref<number[]>([])
const issueQuantities = reactive<Record<number, string>>({})
const issueKnownItems = reactive<Record<number, InventoryItemDto>>({})
const issueSearchInput = ref('')
const issueSearchLoading = ref(false)
const editForm = reactive({ brand: '', name: '', model: '', specification: '', unit: '', notes: '' })
const reverseForm = reactive({ reason: '' })
const adjustmentReverseForm = reactive({ reason: '' })

const items = computed(() => inventoryPage.value.items)
const selectedItemLabel = computed(() => selectedItem.value
  ? [selectedItem.value.brand, selectedItem.value.name, selectedItem.value.model].filter(Boolean).join(' ')
  : '')
const detailWarning = computed(() => {
  if (!detailError.value) return ''
  return detailLoadedItemId.value === selectedItem.value?.id
    ? `物料详情刷新失败：${detailError.value}；仍显示该物料上一次成功读取的详情。`
    : `物料详情读取失败：${detailError.value}；当前仅显示库存列表中的摘要。`
})
const movementsWarning = computed(() => {
  if (!movementsError.value) return ''
  return movementsLoadedItemId.value === selectedItem.value?.id
    ? `库存流水刷新失败：${movementsError.value}；仍显示该物料上一次成功读取的流水。`
    : `库存流水读取失败：${movementsError.value}；当前不显示该物料的流水。`
})
const adjustmentIsIncrease = computed(() => {
  const value = adjustForm.quantityDelta.trim()
  return /^\d+(?:\.\d{1,3})?$/.test(value) && quantityToMilli(value) > 0n
})
const visibleIssueCandidates = computed(() => {
  const candidates = new Map(issueCandidates.value.map((item) => [item.id, item]))
  for (const itemId of selectedIssueItemIds.value) {
    const selected = issueKnownItems[itemId]
    if (selected && !candidates.has(itemId)) candidates.set(itemId, selected)
  }
  return [...candidates.values()]
})

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
  formError.value = ''
  notice.value = ''
}

function preventBusyClose(done: () => void): void {
  if (!busyAction.value) done()
}

function hasCurrentContext(generation: number, activeRepository: InventoryHttpRepository): boolean {
  return mounted && generation === contextGeneration && activeRepository === repository.value
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
  const context = contextGeneration
  const activeRepository = repository.value
  loading.value = true
  loadError.value = ''
  try {
    const result = await activeRepository.listInventoryItems(listQuery(page))
    if (!hasCurrentContext(context, activeRepository) || generation !== listGeneration) return
    inventoryPage.value = result.data
    if (selectedItem.value) {
      const updated = result.data.items.find((item) => item.id === selectedItem.value?.id)
      if (updated) selectedItem.value = updated
    }
  } catch (error) {
    if (hasCurrentContext(context, activeRepository) && generation === listGeneration) loadError.value = errorMessage(error)
  } finally {
    if (hasCurrentContext(context, activeRepository) && generation === listGeneration) loading.value = false
  }
}

function isCurrentDetailRequest(
  context: number,
  activeRepository: InventoryHttpRepository,
  itemId: number,
): boolean {
  return hasCurrentContext(context, activeRepository)
    && detailVisible.value
    && selectedItem.value?.id === itemId
}

async function loadItemDetail(itemId: number): Promise<void> {
  const generation = ++detailGeneration
  const context = contextGeneration
  const activeRepository = repository.value
  detailLoading.value = true
  detailError.value = ''
  try {
    const result = await activeRepository.getInventoryItem(itemId)
    if (!isCurrentDetailRequest(context, activeRepository, itemId) || generation !== detailGeneration) return
    selectedItem.value = result.data
    detailLoadedItemId.value = itemId
  } catch (error) {
    if (isCurrentDetailRequest(context, activeRepository, itemId) && generation === detailGeneration) {
      detailError.value = errorMessage(error)
    }
  } finally {
    if (isCurrentDetailRequest(context, activeRepository, itemId) && generation === detailGeneration) {
      detailLoading.value = false
    }
  }
}

async function loadItemMovements(itemId: number, movementPage: number): Promise<void> {
  const generation = ++movementsGeneration
  const context = contextGeneration
  const activeRepository = repository.value
  movementsLoading.value = true
  movementsError.value = ''
  try {
    const result = await activeRepository.listInventoryMovements(itemId, {
      page: movementPage,
      page_size: movementsPage.value.page_size,
    })
    if (!isCurrentDetailRequest(context, activeRepository, itemId) || generation !== movementsGeneration) return
    movementsPage.value = result.data
    movementsLoadedItemId.value = itemId
  } catch (error) {
    if (isCurrentDetailRequest(context, activeRepository, itemId) && generation === movementsGeneration) {
      movementsError.value = errorMessage(error)
    }
  } finally {
    if (isCurrentDetailRequest(context, activeRepository, itemId) && generation === movementsGeneration) {
      movementsLoading.value = false
    }
  }
}

async function loadDetail(itemId: number, movementPage = 1): Promise<void> {
  await Promise.allSettled([
    loadItemDetail(itemId),
    loadItemMovements(itemId, movementPage),
  ])
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
  const context = contextGeneration
  const activeRepository = repository.value
  clearFeedback()
  busyAction.value = action
  try {
    await mutation()
    if (!hasCurrentContext(context, activeRepository)) return
    emit('changed')
    committed()
    await refreshAfterMutation()
    if (!hasCurrentContext(context, activeRepository)) return
    if (loadError.value) {
      notice.value = ''
      actionError.value = `操作已保存，但刷新失败：${loadError.value}`
    }
  } catch (error) {
    if (hasCurrentContext(context, activeRepository)) formError.value = errorMessage(error)
  } finally {
    if (hasCurrentContext(context, activeRepository)) busyAction.value = null
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
  if (busyAction.value) return
  clearFeedback()
  Object.assign(createForm, createFormDefaults)
  moreInformation.value = []
  createVisible.value = true
}

function createPayload(): InventoryItemInput {
  if (!createForm.name.trim()) throw new Error('请填写库存名称')
  if (!createForm.unit.trim()) throw new Error('请选择或填写计量单位')
  const price = yuanToCents(createForm.unitPriceYuan)
  assertInventoryValueSafe(createForm.openingQuantity, price)
  return {
    brand: optional(createForm.brand),
    name: createForm.name.trim(),
    model: optional(createForm.model),
    specification: optional(createForm.specification),
    unit: createForm.unit.trim(),
    opening_quantity: createForm.openingQuantity.trim(),
    opening_unit_cost_cents: price,
    notes: optional(createForm.notes),
  }
}

async function createItem(): Promise<void> {
  if (busyAction.value) return
  let payload: InventoryItemInput
  try { payload = createPayload() } catch (error) { formError.value = errorMessage(error); return }
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
  const itemChanged = selectedItem.value?.id !== item.id
  if (itemChanged) {
    selectedItem.value = item
    detailGeneration += 1
    movementsGeneration += 1
    detailLoadedItemId.value = null
    movementsLoadedItemId.value = null
    movementsPage.value = { items: [], total: 0, page: 1, page_size: movementsPage.value.page_size }
    detailError.value = ''
    movementsError.value = ''
    detailLoading.value = false
    movementsLoading.value = false
  }
  detailVisible.value = true
  await loadDetail(item.id)
}

function openEdit(): void {
  if (busyAction.value || !selectedItem.value) return
  clearFeedback()
  Object.assign(editForm, {
    brand: selectedItem.value.brand ?? '', name: selectedItem.value.name,
    model: selectedItem.value.model ?? '', specification: selectedItem.value.specification ?? '',
    unit: selectedItem.value.unit, notes: selectedItem.value.notes ?? '',
  })
  editVisible.value = true
}

async function updateItem(): Promise<void> {
  if (busyAction.value) return
  const item = selectedItem.value
  if (!item || !editForm.name.trim() || !editForm.unit.trim()) {
    formError.value = '请填写名称和单位'
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
  if (busyAction.value) return
  clearFeedback()
  selectedItem.value = item
  Object.assign(adjustForm, { quantityDelta: '', unitCostYuan: '', reason: '', occurredOn: localISODate() })
  adjustVisible.value = true
}

function adjustmentPayload(item: InventoryItemDto): InventoryAdjustmentInput {
  const quantityDelta = adjustForm.quantityDelta.trim()
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(quantityDelta)) throw new Error('数量格式不正确，请最多填写三位小数')
  if (quantityDelta === '0' || /^0\.0{1,3}$/.test(quantityDelta) || quantityDelta === '-0' || /^-0\.0{1,3}$/.test(quantityDelta)) {
    throw new Error('调整数量不能为 0')
  }
  if (!adjustForm.reason.trim()) throw new Error('请填写库存调整原因')
  let unitCostCents: number | null = null
  if (!quantityDelta.startsWith('-')) {
    if (!adjustForm.unitCostYuan.trim()) throw new Error('增加库存时必须填写本次成本单价')
    unitCostCents = yuanToCents(adjustForm.unitCostYuan)
    assertInventoryValueSafe(quantityDelta, unitCostCents)
  }
  return {
    item_id: item.id, quantity_delta: quantityDelta, unit_cost_cents: unitCostCents,
    reason: adjustForm.reason.trim(), occurred_on: adjustForm.occurredOn,
  }
}

async function adjustItem(): Promise<void> {
  if (busyAction.value) return
  const item = selectedItem.value
  if (!item) return
  let payload: InventoryAdjustmentInput
  try { payload = adjustmentPayload(item) } catch (error) { formError.value = errorMessage(error); return }
  await runInventoryMutation('adjust', () => repository.value.createInventoryAdjustment(payload), () => {
    adjustVisible.value = false
    notice.value = '库存调整已保存'
  })
}

function canReverseAdjustment(movement: InventoryMovementDto): boolean {
  return movement.movement_type === 'adjustment'
    && movement.source_type === 'inventory_adjustment'
    && movement.adjustment_status === 'active'
    && typeof movement.adjustment_revision === 'number'
    && movement.adjustment_revision > 0
}

function openAdjustmentReverse(movement: InventoryMovementDto): void {
  if (busyAction.value || !canReverseAdjustment(movement)) return
  clearFeedback()
  selectedAdjustmentMovement.value = movement
  adjustmentReverseForm.reason = ''
  adjustmentReverseVisible.value = true
}

function adjustmentReversalPayload(): {
  adjustmentId: number
  input: InventoryAdjustmentReversalInput
} {
  const movement = selectedAdjustmentMovement.value
  if (!movement || !canReverseAdjustment(movement)) {
    throw new Error('该调整记录已不能冲销，请刷新后重试')
  }
  const reason = adjustmentReverseForm.reason.trim()
  if (!reason) throw new Error('请填写库存调整冲销原因')
  return {
    adjustmentId: movement.source_id,
    input: { reason, expected_revision: movement.adjustment_revision! },
  }
}

async function reverseAdjustment(): Promise<void> {
  if (busyAction.value) return
  let payload: ReturnType<typeof adjustmentReversalPayload>
  try {
    payload = adjustmentReversalPayload()
  } catch (error) {
    formError.value = errorMessage(error)
    return
  }
  const context = contextGeneration
  const activeRepository = repository.value
  busyAction.value = 'reverse'
  adjustmentConfirmationOpen = true
  try {
    await ElMessageBox.confirm(
      `将按原调整记录 #${payload.adjustmentId} 精确回退数量和金额，并保留原流水。确定继续吗？`,
      '确认冲销库存调整',
      {
        type: 'warning',
        confirmButtonText: '确认冲销',
        cancelButtonText: '取消',
      },
    )
  } catch {
    if (hasCurrentContext(context, activeRepository)) busyAction.value = null
    return
  } finally {
    if (hasCurrentContext(context, activeRepository)) adjustmentConfirmationOpen = false
  }
  if (!hasCurrentContext(context, activeRepository)) return
  busyAction.value = null
  await runInventoryMutation(
    'reverse',
    () => activeRepository.reverseInventoryAdjustment(payload.adjustmentId, payload.input),
    () => {
      adjustmentReverseVisible.value = false
      selectedAdjustmentMovement.value = null
      notice.value = '库存调整已冲销'
    },
  )
}

function cancelAdjustmentReverse(): void {
  if (busyAction.value) return
  try {
    const payload = adjustmentReversalPayload()
    repository.value.discardReverseInventoryAdjustment(payload.adjustmentId, payload.input)
  } catch { /* invalid form has no pending request */ }
  adjustmentReverseVisible.value = false
  selectedAdjustmentMovement.value = null
}

function openIssue(item: InventoryItemDto): void {
  if (busyAction.value) return
  clearFeedback()
  selectedItem.value = item
  Object.assign(issueForm, { projectCode: '', workerId: null, issuedOn: localISODate(), notes: '' })
  selectedIssueItemIds.value = [item.id]
  for (const key of Object.keys(issueQuantities)) delete issueQuantities[Number(key)]
  for (const key of Object.keys(issueKnownItems)) delete issueKnownItems[Number(key)]
  for (const candidate of items.value) issueQuantities[candidate.id] = ''
  issueKnownItems[item.id] = item
  issueCandidates.value = [...items.value]
  issueSearchInput.value = ''
  issueProjects.value = []
  issueWorkers.value = []
  issueVisible.value = true
  void loadIssueOptions(item)
}

async function loadIssueOptions(openedItem: InventoryItemDto): Promise<void> {
  const generation = ++issueInventoryGeneration
  const context = contextGeneration
  const activeRepository = repository.value
  issueSearchLoading.value = true
  try {
    const [inventoryResult, projectResult] = await Promise.all([
      activeRepository.listInventoryItems({ page: 1, page_size: 200, status: 'in_stock' }),
      activeRepository.listIssueProjects(),
    ])
    if (!hasCurrentContext(context, activeRepository) || generation !== issueInventoryGeneration || !issueVisible.value || selectedItem.value?.id !== openedItem.id) return
    issueCandidates.value = inventoryResult.data.items
    issueProjects.value = projectResult.data
    for (const candidate of issueCandidates.value) {
      issueKnownItems[candidate.id] = candidate
      if (!(candidate.id in issueQuantities)) issueQuantities[candidate.id] = ''
    }
  } catch (error) {
    if (hasCurrentContext(context, activeRepository) && generation === issueInventoryGeneration && issueVisible.value && selectedItem.value?.id === openedItem.id) {
      formError.value = errorMessage(error)
    }
  } finally {
    if (hasCurrentContext(context, activeRepository) && generation === issueInventoryGeneration) issueSearchLoading.value = false
  }
}

async function searchIssueItems(): Promise<void> {
  const openedItem = selectedItem.value
  if (!openedItem) return
  const generation = ++issueInventoryGeneration
  const context = contextGeneration
  const activeRepository = repository.value
  issueSearchLoading.value = true
  formError.value = ''
  const query = issueSearchInput.value.trim()
  try {
    const result = await activeRepository.listInventoryItems({
      page: 1,
      page_size: 200,
      ...(query ? { query } : {}),
      status: 'in_stock',
    })
    if (!hasCurrentContext(context, activeRepository) || generation !== issueInventoryGeneration || !issueVisible.value || selectedItem.value?.id !== openedItem.id) return
    issueCandidates.value = result.data.items
    for (const candidate of result.data.items) {
      issueKnownItems[candidate.id] = candidate
      if (!(candidate.id in issueQuantities)) issueQuantities[candidate.id] = ''
    }
  } catch (error) {
    if (hasCurrentContext(context, activeRepository) && generation === issueInventoryGeneration && issueVisible.value) formError.value = errorMessage(error)
  } finally {
    if (hasCurrentContext(context, activeRepository) && generation === issueInventoryGeneration) issueSearchLoading.value = false
  }
}

async function changeIssueProject(projectCode: string): Promise<void> {
  const generation = ++issueWorkerGeneration
  const context = contextGeneration
  const activeRepository = repository.value
  issueForm.workerId = null
  issueWorkers.value = []
  if (!projectCode) return
  try {
    const result = await activeRepository.listProjectIssueWorkers(projectCode)
    if (hasCurrentContext(context, activeRepository) && generation === issueWorkerGeneration && issueForm.projectCode === projectCode) {
      issueWorkers.value = result.data
    }
  } catch (error) {
    if (hasCurrentContext(context, activeRepository) && generation === issueWorkerGeneration) formError.value = errorMessage(error)
  }
}

function toggleIssueItem(itemId: number, selected: boolean): void {
  if (selected) {
    if (!selectedIssueItemIds.value.includes(itemId)) selectedIssueItemIds.value.push(itemId)
    return
  }
  selectedIssueItemIds.value = selectedIssueItemIds.value.filter((id) => id !== itemId)
}

function issuePayload(): InventoryIssueInput {
  if (!issueForm.projectCode.trim()) throw new Error('请填写项目编号')
  if (selectedIssueItemIds.value.length === 0) throw new Error('请至少选择一项库存物料')
  const lines = selectedIssueItemIds.value.map((itemId) => {
    const item = issueKnownItems[itemId]
    const quantity = issueQuantities[itemId]?.trim() ?? ''
    if (!item) throw new Error('库存物料已变化，请关闭后重试')
    const requested = quantityToMilli(quantity)
    if (requested <= 0n) throw new Error(`${item.name}的领用数量必须大于 0`)
    if (requested > quantityToMilli(item.quantity)) throw new Error(`${item.name}的领用数量不能超过当前库存`)
    return { inventory_item_id: item.id, procurement_line_id: null, quantity }
  })
  return {
    issued_on: issueForm.issuedOn,
    worker_id: issueForm.workerId,
    lines,
    notes: optional(issueForm.notes),
  }
}

async function issueItem(): Promise<void> {
  if (busyAction.value) return
  let payload: InventoryIssueInput
  try { payload = issuePayload() } catch (error) { formError.value = errorMessage(error); return }
  const projectCode = issueForm.projectCode.trim()
  await runInventoryMutation('issue', () => repository.value.createProjectInventoryIssue(projectCode, payload), () => {
    issueVisible.value = false
    notice.value = '项目领用已保存'
  })
}

function canReverseIssue(movement: InventoryMovementDto): boolean {
  return movement.movement_type === 'project_issue'
    && movement.source_type === 'inventory_issue'
    && typeof movement.project_code === 'string'
    && movement.project_code.length > 0
    && movement.issue_status === 'active'
    && typeof movement.issue_revision === 'number'
    && movement.issue_revision > 0
}

function openIssueReverse(movement: InventoryMovementDto): void {
  if (busyAction.value || !canReverseIssue(movement)) return
  clearFeedback()
  selectedIssueMovement.value = movement
  reverseForm.reason = ''
  reverseVisible.value = true
}

function reversalPayload(): { projectCode: string; issueId: number; input: InventoryIssueReversalInput } {
  const movement = selectedIssueMovement.value
  if (!movement || !canReverseIssue(movement)) throw new Error('该领用记录已不能冲销，请刷新后重试')
  if (!reverseForm.reason.trim()) throw new Error('请填写冲销原因')
  return {
    projectCode: movement.project_code!,
    issueId: movement.source_id,
    input: {
      reason: reverseForm.reason.trim(),
      expected_revision: movement.issue_revision!,
    },
  }
}

async function reverseIssue(): Promise<void> {
  if (busyAction.value) return
  let payload: ReturnType<typeof reversalPayload>
  try { payload = reversalPayload() } catch (error) { formError.value = errorMessage(error); return }
  await runInventoryMutation(
    'reverse',
    () => repository.value.reverseProjectInventoryIssue(payload.projectCode, payload.issueId, payload.input),
    () => {
      reverseVisible.value = false
      selectedIssueMovement.value = null
      notice.value = '库存领用已冲销'
    },
  )
}

function cancelIssueReverse(): void {
  if (busyAction.value) return
  try {
    const payload = reversalPayload()
    repository.value.discardReverseProjectInventoryIssue(payload.projectCode, payload.issueId, payload.input)
  } catch { /* invalid form has no pending request */ }
  reverseVisible.value = false
  selectedIssueMovement.value = null
}

function cancelEdit(): void {
  if (!busyAction.value) editVisible.value = false
}

function cancelAdjustment(): void {
  if (!busyAction.value) adjustVisible.value = false
}

function cancelIssue(): void {
  if (busyAction.value) return
  issueVisible.value = false
  issueInventoryGeneration += 1
  issueWorkerGeneration += 1
  issueSearchLoading.value = false
}

function movementLabel(movement: InventoryMovementDto): string {
  if (movement.movement_type === 'reversal') {
    if (movement.source_type === 'inventory_adjustment_reversal') return '调整冲销'
    if (movement.source_type === 'goods_receipt_reversal') return '到货冲销'
    if (movement.source_type === 'inventory_issue_reversal') return '领用冲销'
    return '冲销'
  }
  return {
    opening: '期初库存', goods_receipt: '采购到货', adjustment: '库存调整',
    project_issue: '项目领用',
  }[movement.movement_type]
}

function resetRepositoryContext(): void {
  contextGeneration += 1
  listGeneration += 1
  detailGeneration += 1
  movementsGeneration += 1
  issueWorkerGeneration += 1
  issueInventoryGeneration += 1
  if (adjustmentConfirmationOpen) {
    adjustmentConfirmationOpen = false
    ElMessageBox.close()
  }
  busyAction.value = null
  createVisible.value = false
  adjustVisible.value = false
  issueVisible.value = false
  detailVisible.value = false
  editVisible.value = false
  reverseVisible.value = false
  adjustmentReverseVisible.value = false
  selectedItem.value = null
  selectedIssueMovement.value = null
  selectedAdjustmentMovement.value = null
  detailLoadedItemId.value = null
  movementsLoadedItemId.value = null
  inventoryPage.value = { items: [], total: 0, page: 1, page_size: 20 }
  movementsPage.value = { items: [], total: 0, page: 1, page_size: 20 }
  detailLoading.value = false
  movementsLoading.value = false
  detailError.value = ''
  movementsError.value = ''
  issueSearchLoading.value = false
  clearFeedback()
  void loadInventory(1)
}

watch(() => props.repository, resetRepositoryContext, { immediate: true })
onBeforeUnmount(() => {
  mounted = false
  contextGeneration += 1
  listGeneration += 1
  detailGeneration += 1
  movementsGeneration += 1
  issueWorkerGeneration += 1
  issueInventoryGeneration += 1
  if (adjustmentConfirmationOpen) ElMessageBox.close()
})
</script>

<template>
  <section data-testid="inventory-center" class="inventory-center">
    <header class="inventory-heading">
      <div><h2>库存</h2><p>库存数量只通过期初、到货、调整和项目领用流水变化。</p></div>
      <el-button data-testid="inventory-create-open" type="primary" :disabled="loading || Boolean(busyAction)" @click="openCreate">新增库存</el-button>
    </header>

    <el-alert
      v-if="loadError"
      data-testid="inventory-load-error"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="feedback"
    >
      <template #default>
        <el-button data-testid="inventory-load-retry" link type="primary" :disabled="loading" @click="loadInventory()">重新读取</el-button>
      </template>
    </el-alert>
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
          <el-table-column label="操作" width="176" fixed="right">
            <template #default="scope">
              <div class="row-actions">
                <el-button :data-testid="`inventory-adjust-open-${scope.row.id}`" :aria-label="`调整 ${scope.row.name} 库存`" link type="primary" :disabled="Boolean(busyAction)" @click="openAdjustment(scope.row)">库存调整</el-button>
                <el-button :data-testid="`inventory-issue-open-${scope.row.id}`" :aria-label="`将 ${scope.row.name} 用于项目`" link :disabled="Boolean(busyAction)" @click="openIssue(scope.row)">项目领用</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="inventoryPage.total > inventoryPage.page_size" layout="prev, pager, next, total" :current-page="inventoryPage.page" :page-size="inventoryPage.page_size" :total="inventoryPage.total" @current-change="loadInventory" />
    </el-card>

    <el-drawer v-model="detailVisible" data-testid="inventory-detail-drawer" :teleported="false" title="库存物料详情" size="min(94vw, 760px)">
      <el-skeleton v-if="!selectedItem" :rows="5" animated />
      <template v-else>
        <el-alert v-if="detailWarning" data-testid="inventory-detail-load-warning" :title="detailWarning" type="warning" show-icon :closable="false" class="feedback" />
        <div v-loading="detailLoading">
          <div class="detail-heading"><div><strong>{{ selectedItemLabel }}</strong><small>{{ selectedItem.specification || '未填写规格' }}</small></div><el-button data-testid="inventory-edit-open" :disabled="Boolean(busyAction) || detailLoading" @click="openEdit">编辑资料</el-button></div>
          <el-descriptions :column="2" border class="inventory-descriptions">
            <el-descriptions-item label="库存数量">{{ selectedItem.quantity }} {{ selectedItem.unit }}</el-descriptions-item>
            <el-descriptions-item label="单价">{{ formatMoney(selectedItem.average_unit_cost_cents) }}</el-descriptions-item>
            <el-descriptions-item label="库存价值">{{ formatMoney(selectedItem.inventory_value_cents) }}</el-descriptions-item>
            <el-descriptions-item label="品牌 / 型号">{{ [selectedItem.brand, selectedItem.model].filter(Boolean).join(' / ') || '—' }}</el-descriptions-item>
          </el-descriptions>
        </div>
        <div class="movement-heading"><strong>库存流水</strong><small>流水只追加，不改写历史记录。</small></div>
        <el-alert v-if="movementsWarning" data-testid="inventory-movements-load-warning" :title="movementsWarning" type="warning" show-icon :closable="false" class="feedback" />
        <div v-loading="movementsLoading">
          <el-empty v-if="movementsPage.items.length === 0" description="暂无库存流水" />
          <div v-else class="table-scroll movement-scroll">
            <el-table :data="movementsPage.items" row-key="id" size="small" class="movement-table">
              <el-table-column label="日期" prop="occurred_on" min-width="112" />
              <el-table-column label="类型" min-width="100"><template #default="scope">{{ movementLabel(scope.row) }}</template></el-table-column>
              <el-table-column label="数量变化" min-width="110"><template #default="scope"><strong>{{ scope.row.quantity_delta }} {{ selectedItem.unit }}</strong></template></el-table-column>
              <el-table-column label="关联来源" min-width="150"><template #default="scope">{{ scope.row.source_type }} #{{ scope.row.source_id }}</template></el-table-column>
              <el-table-column label="原因" min-width="180"><template #default="scope">{{ scope.row.reason || '—' }}</template></el-table-column>
              <el-table-column label="操作" width="76" fixed="right"><template #default="scope"><el-button v-if="canReverseAdjustment(scope.row)" :data-testid="`inventory-adjustment-reverse-open-${scope.row.id}`" link type="danger" :disabled="Boolean(busyAction)" @click="openAdjustmentReverse(scope.row)">冲销</el-button><el-button v-else-if="canReverseIssue(scope.row)" :data-testid="`inventory-issue-reverse-open-${scope.row.id}`" link type="danger" :disabled="Boolean(busyAction)" @click="openIssueReverse(scope.row)">冲销</el-button></template></el-table-column>
            </el-table>
          </div>
        </div>
        <el-pagination v-if="movementsPage.total > movementsPage.page_size" layout="prev, pager, next, total" :current-page="movementsPage.page" :page-size="movementsPage.page_size" :total="movementsPage.total" @current-change="selectedItem && loadDetail(selectedItem.id, $event)" />
      </template>
    </el-drawer>

    <el-dialog v-model="createVisible" data-testid="inventory-create-dialog" :teleported="false" title="新增库存" width="min(94vw, 680px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-create-error" :title="formError" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="createItem"><el-row :gutter="14">
        <el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="createForm.brand" data-testid="inventory-create-brand" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="名称" required><el-input v-model="createForm.name" data-testid="inventory-create-name" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="createForm.model" data-testid="inventory-create-model" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="数量" required><el-input v-model="createForm.openingQuantity" data-testid="inventory-create-quantity" placeholder="例如 2.500" /></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="单位" required><el-select v-model="createForm.unit" data-testid="inventory-create-unit" filterable allow-create default-first-option placeholder="选择或输入单位" style="width: 100%"><el-option v-for="unit in ['个', '件', '包', 'PCS', '套', '台', '米']" :key="unit" :label="unit" :value="unit" /></el-select></el-form-item></el-col>
        <el-col :xs="24" :sm="12"><el-form-item label="单价（元）" required><el-input v-model="createForm.unitPriceYuan" data-testid="inventory-create-price" inputmode="decimal" placeholder="例如 1289.05" /></el-form-item></el-col>
      </el-row><el-collapse v-model="moreInformation" class="more-information"><el-collapse-item title="更多信息" name="details"><el-form-item label="规格"><el-input v-model="createForm.specification" data-testid="inventory-create-specification" /></el-form-item><el-form-item label="备注"><el-input v-model="createForm.notes" data-testid="inventory-create-notes" type="textarea" /></el-form-item></el-collapse-item></el-collapse><div class="dialog-actions"><el-button data-testid="inventory-create-cancel" :disabled="Boolean(busyAction)" @click="cancelCreate">取消</el-button><el-button data-testid="inventory-create-submit" type="primary" native-type="submit" :loading="busyAction === 'create'" :disabled="Boolean(busyAction)">保存</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" data-testid="inventory-edit-dialog" :teleported="false" title="编辑库存资料" width="min(94vw, 620px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-edit-error" :title="formError" type="error" show-icon :closable="false" />
      <el-alert title="数量、单价和库存价值只能通过库存流水变化，此处只编辑物料资料。" type="info" :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="updateItem"><el-row :gutter="14"><el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="editForm.brand" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="名称" required><el-input v-model="editForm.name" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="editForm.model" data-testid="inventory-edit-model" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="editForm.specification" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="单位" required><el-input v-model="editForm.unit" /></el-form-item></el-col></el-row><el-form-item label="备注"><el-input v-model="editForm.notes" type="textarea" /></el-form-item><div class="dialog-actions"><el-button :disabled="Boolean(busyAction)" @click="cancelEdit">取消</el-button><el-button data-testid="inventory-edit-submit" type="primary" native-type="submit" :loading="busyAction === 'edit'" :disabled="Boolean(busyAction)">保存资料</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="adjustVisible" data-testid="inventory-adjust-dialog" :teleported="false" title="库存调整" width="min(92vw, 560px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-adjust-error" :title="formError" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="adjustItem"><el-form-item label="库存物料"><strong>{{ selectedItemLabel }}</strong></el-form-item><el-form-item label="数量变化" required><el-input v-model="adjustForm.quantityDelta" data-testid="inventory-adjust-quantity" placeholder="增加填 2.000，减少填 -0.500" /></el-form-item><el-form-item v-if="adjustmentIsIncrease" label="本次成本单价（元）" required><el-input v-model="adjustForm.unitCostYuan" data-testid="inventory-adjust-unit-cost" inputmode="decimal" placeholder="例如 1289.00" /></el-form-item><el-form-item label="原因" required><el-input v-model="adjustForm.reason" data-testid="inventory-adjust-reason" /></el-form-item><el-form-item label="发生日期"><el-date-picker v-model="adjustForm.occurredOn" type="date" value-format="YYYY-MM-DD" /></el-form-item><div class="dialog-actions"><el-button :disabled="Boolean(busyAction)" @click="cancelAdjustment">取消</el-button><el-button data-testid="inventory-adjust-submit" type="primary" native-type="submit" :loading="busyAction === 'adjust'" :disabled="Boolean(busyAction)">保存调整</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="issueVisible" data-testid="inventory-issue-dialog" :teleported="false" title="项目领用" width="min(94vw, 680px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-issue-error" :title="formError" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="issueItem">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12">
            <el-form-item label="项目" required>
              <el-select v-model="issueForm.projectCode" data-testid="inventory-issue-project" filterable style="width: 100%" @change="changeIssueProject">
                <el-option v-for="project in issueProjects" :key="project.project_code" :label="`${project.project_code} · ${project.name}`" :value="project.project_code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="施工员">
              <el-select v-model="issueForm.workerId" data-testid="inventory-issue-worker" clearable placeholder="不指定施工员" style="width: 100%" :disabled="!issueForm.projectCode">
                <el-option v-for="worker in issueWorkers" :key="worker.worker_id" :label="`${worker.name} · ${worker.role}`" :value="worker.worker_id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="领用日期"><el-date-picker v-model="issueForm.issuedOn" data-testid="inventory-issue-date" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="查找库存物料">
          <div class="issue-material-search">
            <el-input v-model="issueSearchInput" data-testid="inventory-issue-search" clearable placeholder="输入名称、品牌或型号，搜索全部库存" @keyup.enter.stop.prevent="searchIssueItems" />
            <el-button data-testid="inventory-issue-search-submit" :loading="issueSearchLoading" @click="searchIssueItems">搜索</el-button>
          </div>
        </el-form-item>
        <el-form-item label="领用物料" required>
          <el-scrollbar class="inventory-issue-scroll" max-height="min(42vh, 420px)">
            <div class="issue-line-selection" data-testid="inventory-issue-candidates">
              <small class="issue-selection-summary">已选 {{ selectedIssueItemIds.length }} 项；搜索后已选物料仍会保留。</small>
              <el-empty v-if="visibleIssueCandidates.length === 0 && !issueSearchLoading" description="没有找到可领用的库存物料" :image-size="64" />
              <section v-for="item in visibleIssueCandidates" :key="item.id" class="issue-line-selector">
                <el-checkbox :model-value="selectedIssueItemIds.includes(item.id)" :data-testid="`inventory-issue-line-select-${item.id}`" @change="toggleIssueItem(item.id, Boolean($event))">
                  {{ item.name }} {{ item.model || '' }} · 可用 {{ item.quantity }} {{ item.unit }}
                </el-checkbox>
                <el-input v-model="issueQuantities[item.id]" :data-testid="`inventory-issue-quantity-${item.id}`" placeholder="本次领用数量" :disabled="!selectedIssueItemIds.includes(item.id)" />
              </section>
            </div>
          </el-scrollbar>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="issueForm.notes" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><div class="dialog-actions"><el-button data-testid="inventory-issue-cancel" :disabled="Boolean(busyAction)" @click="cancelIssue">取消</el-button><el-button data-testid="inventory-issue-submit" type="primary" :loading="busyAction === 'issue'" :disabled="Boolean(busyAction)" @click="issueItem">确认领用</el-button></div></template>
    </el-dialog>

    <el-dialog v-model="adjustmentReverseVisible" data-testid="inventory-adjustment-reverse-dialog" :teleported="false" title="冲销库存调整" width="min(92vw, 520px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-adjustment-reverse-error" :title="formError" type="error" show-icon :closable="false" />
      <el-alert title="系统将引用原调整记录，精确回退其数量和金额；原记录与反向流水都会保留。" type="warning" :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="reverseAdjustment"><el-form-item label="原调整记录"><strong>#{{ selectedAdjustmentMovement?.source_id }} · {{ selectedAdjustmentMovement?.quantity_delta }} {{ selectedItem?.unit }}</strong></el-form-item><el-form-item label="冲销原因" required><el-input v-model="adjustmentReverseForm.reason" data-testid="inventory-adjustment-reverse-reason" type="textarea" :rows="3" /></el-form-item><div class="dialog-actions"><el-button :disabled="Boolean(busyAction)" @click="cancelAdjustmentReverse">取消</el-button><el-button data-testid="inventory-adjustment-reverse-submit" type="danger" native-type="submit" :loading="busyAction === 'reverse'" :disabled="Boolean(busyAction)">确认冲销</el-button></div></el-form>
    </el-dialog>

    <el-dialog v-model="reverseVisible" data-testid="inventory-issue-reverse-dialog" :teleported="false" title="冲销项目领用" width="min(92vw, 520px)" :before-close="preventBusyClose" :close-on-click-modal="!busyAction" :close-on-press-escape="!busyAction" :show-close="!busyAction">
      <el-alert v-if="formError" data-testid="inventory-issue-reverse-error" :title="formError" type="error" show-icon :closable="false" />
      <el-alert title="冲销后会恢复该领用记录冻结的库存数量和成本，并新增一条不可修改的反向流水。" type="warning" :closable="false" />
      <el-form label-position="top" :disabled="Boolean(busyAction)" @submit.prevent="reverseIssue"><el-form-item label="领用记录"><strong>{{ selectedIssueMovement?.project_code }} / #{{ selectedIssueMovement?.source_id }}</strong></el-form-item><el-form-item label="冲销原因" required><el-input v-model="reverseForm.reason" data-testid="inventory-issue-reverse-reason" type="textarea" :rows="3" /></el-form-item><div class="dialog-actions"><el-button :disabled="Boolean(busyAction)" @click="cancelIssueReverse">取消</el-button><el-button data-testid="inventory-issue-reverse-submit" type="danger" native-type="submit" :loading="busyAction === 'reverse'" :disabled="Boolean(busyAction)">确认冲销</el-button></div></el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.inventory-center { width: 100%; min-width: 0; }
.inventory-heading, .table-heading, .inventory-filters, .dialog-actions, .detail-heading, .movement-heading, .row-actions { display: flex; align-items: center; }
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
.row-actions { gap: 2px; white-space: nowrap; }
.detail-heading > div { display: grid; gap: 4px; }
.detail-heading small, .movement-heading small { color: var(--sunyu-muted); }
.inventory-descriptions { margin-top: 16px; }
.movement-heading { margin: 22px 0 10px; }
.movement-scroll { max-width: 100%; margin-top: 10px; }
.movement-table { min-width: 736px; }
.issue-line-selection {
  display: grid;
  width: 100%;
  gap: 10px;
  padding-right: 4px;
}
.inventory-issue-scroll { width: 100%; }
.issue-material-search { display: flex; width: 100%; gap: 8px; }
.issue-selection-summary { color: var(--sunyu-muted); }
.issue-line-selector { display: grid; grid-template-columns: minmax(0, 1fr) 180px; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: var(--el-border-radius-base); }
.el-pagination { justify-content: flex-end; margin-top: 14px; }
@media (max-width: 700px) {
  .inventory-heading, .table-heading, .detail-heading, .movement-heading { align-items: stretch; flex-direction: column; }
  .inventory-heading > .el-button, .inventory-filters { width: 100%; }
}
@media (max-width: 520px) {
  .inventory-filters { align-items: stretch; flex-direction: column; }
  .inventory-filters > :first-child { width: 100%; }
  .issue-line-selector { grid-template-columns: 1fr; }
  .issue-material-search { align-items: stretch; flex-direction: column; }
}
</style>
