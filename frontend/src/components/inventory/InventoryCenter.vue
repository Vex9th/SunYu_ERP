<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import type { InventoryItem, InventoryMovement, InventorySnapshot } from '../../domain/procurement'
import { formatMoney } from '../../domain/formatters'
import { useDemoBusinessContext } from '../../repositories/demo-context'

type InventoryAction = 'create' | 'edit' | 'adjust' | 'issue' | 'reverse'

const repository = useDemoBusinessContext().procurement
const inventory = ref<InventorySnapshot | null>(null)
const loading = ref(true)
const loadError = ref('')
const query = ref('')
const notice = ref('')
const actionError = ref('')
const busyAction = ref<InventoryAction | null>(null)
const createVisible = ref(false)
const adjustVisible = ref(false)
const issueVisible = ref(false)
const detailVisible = ref(false)
const editVisible = ref(false)
const reversalVisible = ref(false)
const selectedItem = ref<InventoryItem | null>(null)
const selectedMovement = ref<InventoryMovement | null>(null)
const moreInformation = ref<string[]>([])

const workers = [
  { id: 101, name: '王建国' },
  { id: 102, name: '陈志强' },
]

const createFormDefaults = {
  brand: '',
  name: '',
  model: '',
  openingQuantity: '0.000',
  unitPriceYuan: '',
  specification: '',
  unit: '件',
  notes: '',
}
const createForm = reactive({ ...createFormDefaults })
const adjustForm = reactive({
  quantityDelta: '',
  reason: '',
  occurredOn: localISODate(new Date()),
})
const issueForm = reactive({
  projectCode: '',
  issuedOn: localISODate(new Date()),
  workerId: workers[0]!.id,
  quantity: '',
  notes: '',
})
const editForm = reactive({ brand: '', name: '', model: '', specification: '', unit: '' })
const reversalForm = reactive({ reversedOn: localISODate(new Date()), reason: '' })

const visibleItems = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return inventory.value?.items ?? []
  return (inventory.value?.items ?? []).filter((item) => (
    [item.brand, item.name, item.model, item.specification]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized))
  ))
})

const selectedItemLabel = computed(() => selectedItem.value
  ? [selectedItem.value.brand, selectedItem.value.name, selectedItem.value.model]
      .filter(Boolean)
      .join(' ')
  : '')
const selectedMovements = computed(() => (inventory.value?.movements ?? []).filter(
  (movement) => movement.inventory_item_id === selectedItem.value?.id,
))
const reversedMovementIds = computed(() => new Set((inventory.value?.movements ?? [])
  .map((movement) => movement.reversal_of_movement_id)
  .filter((movementId): movementId is number => movementId !== null)))

function localISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function optional(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
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
  const quantityMilli = quantityToMilli(quantity)
  const roundedValueCents = (quantityMilli * BigInt(unitPriceCents) + 500n) / 1000n
  if (roundedValueCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('库存价值超出可保存范围')
  }
}

function clearFeedback(): void {
  notice.value = ''
  actionError.value = ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试'
}

async function refreshInventory(): Promise<void> {
  inventory.value = (await repository.getInventory()).data
  if (selectedItem.value) {
    selectedItem.value = inventory.value.items.find((item) => item.id === selectedItem.value?.id) ?? null
  }
}

async function loadInventory(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    await refreshInventory()
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function runInventoryMutation(
  action: InventoryAction,
  mutation: () => Promise<void>,
  onCommitted: () => void,
): Promise<void> {
  if (busyAction.value) return
  clearFeedback()
  busyAction.value = action
  try {
    await mutation()
  } catch (error) {
    actionError.value = errorMessage(error)
    busyAction.value = null
    return
  }
  onCommitted()
  try {
    await refreshInventory()
  } catch (error) {
    notice.value = ''
    actionError.value = `操作已保存，但刷新失败：${errorMessage(error)}`
  } finally {
    busyAction.value = null
  }
}

function openCreate(): void {
  clearFeedback()
  Object.assign(createForm, createFormDefaults)
  moreInformation.value = []
  createVisible.value = true
}

async function createItem(): Promise<void> {
  await runInventoryMutation('create', async () => {
    if (!createForm.name.trim()) throw new Error('请填写库存名称')
    const unitPriceCents = yuanToCents(createForm.unitPriceYuan)
    assertInventoryValueSafe(createForm.openingQuantity, unitPriceCents)
    await repository.createInventoryItem({
      brand: createForm.brand.trim(),
      name: createForm.name.trim(),
      model: createForm.model.trim(),
      specification: createForm.specification.trim(),
      unit: createForm.unit.trim() || '件',
      opening_quantity: createForm.openingQuantity.trim(),
      opening_unit_cost_cents: unitPriceCents,
      notes: optional(createForm.notes),
    })
  }, () => {
    createVisible.value = false
    notice.value = '新增库存已保存（演示数据）'
  })
}

function openAdjustment(item: InventoryItem): void {
  clearFeedback()
  selectedItem.value = item
  adjustForm.quantityDelta = ''
  adjustForm.reason = ''
  adjustForm.occurredOn = localISODate(new Date())
  adjustVisible.value = true
}

function openDetail(item: InventoryItem): void {
  clearFeedback()
  selectedItem.value = item
  detailVisible.value = true
}

function openEdit(): void {
  if (!selectedItem.value) return
  clearFeedback()
  Object.assign(editForm, {
    brand: selectedItem.value.brand,
    name: selectedItem.value.name,
    model: selectedItem.value.model,
    specification: selectedItem.value.specification,
    unit: selectedItem.value.unit,
  })
  editVisible.value = true
}

async function updateItem(): Promise<void> {
  const item = selectedItem.value
  if (!item) return
  await runInventoryMutation('edit', () => repository.updateInventoryItem(item.id, item.revision, {
      brand: editForm.brand.trim(),
      name: editForm.name.trim(),
      model: editForm.model.trim(),
      specification: editForm.specification.trim(),
      unit: editForm.unit.trim(),
    }), () => {
    editVisible.value = false
    notice.value = '库存资料已更新（演示数据）'
  })
}

async function adjustItem(): Promise<void> {
  const item = selectedItem.value
  if (!item) return
  await runInventoryMutation('adjust', () => repository.adjustInventory({
      item_id: item.id,
      quantity_delta: adjustForm.quantityDelta.trim(),
      unit_cost_cents: null,
      reason: adjustForm.reason.trim(),
      occurred_on: adjustForm.occurredOn,
    }), () => {
    adjustVisible.value = false
    notice.value = '库存调整已保存（演示数据）'
  })
}

function openIssue(item: InventoryItem): void {
  clearFeedback()
  selectedItem.value = item
  issueForm.quantity = ''
  issueForm.notes = ''
  issueForm.issuedOn = localISODate(new Date())
  issueVisible.value = true
}

async function issueItem(): Promise<void> {
  const item = selectedItem.value
  if (!item) return
  await runInventoryMutation('issue', () => repository.issueInventory(issueForm.projectCode.trim(), {
      issued_on: issueForm.issuedOn,
      worker_id: issueForm.workerId,
      lines: [{
        inventory_item_id: item.id,
        procurement_line_id: null,
        quantity: issueForm.quantity.trim(),
      }],
      notes: optional(issueForm.notes),
    }), () => {
    issueVisible.value = false
    notice.value = '项目领用已保存（演示数据）'
  })
}

function openReversal(movement: InventoryMovement): void {
  clearFeedback()
  selectedMovement.value = movement
  reversalForm.reversedOn = localISODate(new Date())
  reversalForm.reason = ''
  reversalVisible.value = true
}

async function reverseIssue(): Promise<void> {
  const movement = selectedMovement.value
  if (!movement) return
  await runInventoryMutation('reverse', () => repository.reverseInventoryIssue(movement.id, {
      reversed_on: reversalForm.reversedOn,
      reason: reversalForm.reason.trim(),
    }), () => {
    reversalVisible.value = false
    selectedMovement.value = null
    notice.value = '领用记录已冲销（演示数据）'
  })
}

function movementLabel(kind: InventoryMovement['kind']): string {
  return {
    opening: '期初库存',
    receipt: '采购到货',
    adjustment: '库存调整',
    issue: '项目领用',
    issue_reversal: '领用冲销',
  }[kind]
}

function workerName(workerId: number | null): string {
  return workers.find((worker) => worker.id === workerId)?.name ?? '—'
}

function handleRowCommand(command: string, item: InventoryItem): void {
  if (command === 'adjust') openAdjustment(item)
  if (command === 'issue') openIssue(item)
}

onMounted(loadInventory)
</script>

<template>
  <section data-testid="inventory-center" class="inventory-center">
    <header class="inventory-heading">
      <div>
        <div class="title-line">
          <h2>库存</h2>
          <el-tag size="small" type="warning" effect="plain">演示数据</el-tag>
        </div>
        <p>查看现有物料，调整或领用从对应物料行进入。</p>
      </div>
      <el-button data-testid="inventory-create-open" type="primary" @click="openCreate">新增库存</el-button>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false" class="feedback" />
    <el-alert
      v-if="actionError"
      data-testid="inventory-action-error"
      :title="actionError"
      type="error"
      show-icon
      :closable="false"
      class="feedback"
    />
    <el-alert v-if="notice" :title="notice" type="success" show-icon :closable="false" class="feedback" />

    <el-card shadow="never" class="inventory-card">
      <template #header>
        <div class="table-heading">
          <strong>当前库存</strong>
          <el-input v-model="query" clearable placeholder="搜索品牌、名称、型号" aria-label="搜索库存" class="inventory-search" />
        </div>
      </template>

      <el-skeleton v-if="loading" :rows="6" animated />
      <el-empty v-else-if="visibleItems.length === 0" description="暂无匹配库存" />
      <div v-else class="table-scroll">
        <el-table :data="visibleItems" row-key="id" class="inventory-table">
          <el-table-column prop="brand" label="品牌" min-width="100" />
          <el-table-column label="名称" min-width="140">
            <template #default="scope">
              <el-button :data-testid="`inventory-detail-open-${scope.row.id}`" link type="primary" @click="openDetail(scope.row)">
                {{ scope.row.name }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column prop="model" label="型号" min-width="120" />
          <el-table-column label="库存数量" min-width="120"><template #default="scope">{{ scope.row.quantity }} {{ scope.row.unit }}</template></el-table-column>
          <el-table-column label="单价" min-width="130"><template #default="scope">{{ formatMoney(scope.row.average_unit_cost_cents) }}</template></el-table-column>
          <el-table-column label="库存价值" min-width="140"><template #default="scope">{{ formatMoney(scope.row.inventory_value_cents) }}</template></el-table-column>
          <el-table-column label="操作" width="96" fixed="right">
            <template #default="scope">
              <el-dropdown
                :data-testid="`inventory-row-actions-${scope.row.id}`"
                :teleported="false"
                trigger="click"
                @command="handleRowCommand($event, scope.row)"
              >
                <el-button link>更多</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="adjust">库存调整</el-dropdown-item>
                    <el-dropdown-item command="issue">项目领用</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div v-if="visibleItems.length > 0" class="inventory-mobile-list">
        <el-card v-for="item in visibleItems" :key="item.id" shadow="never" class="inventory-mobile-item">
          <div class="mobile-item-heading"><el-button link type="primary" @click="openDetail(item)">{{ item.name }}</el-button><strong>{{ item.quantity }} {{ item.unit }}</strong></div>
          <small>{{ [item.brand, item.model, item.specification].filter(Boolean).join(' / ') || '未填写规格' }}</small>
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="单价">{{ formatMoney(item.average_unit_cost_cents) }}</el-descriptions-item>
            <el-descriptions-item label="库存价值">{{ formatMoney(item.inventory_value_cents) }}</el-descriptions-item>
          </el-descriptions>
          <div class="mobile-item-actions">
            <el-button plain size="small" @click="handleRowCommand('adjust', item)">库存调整</el-button>
            <el-button type="primary" plain size="small" @click="handleRowCommand('issue', item)">项目领用</el-button>
          </div>
        </el-card>
      </div>
    </el-card>

    <el-drawer
      v-model="detailVisible"
      data-testid="inventory-detail-drawer"
      :teleported="false"
      title="库存物料详情"
      size="min(94vw, 760px)"
    >
      <template v-if="selectedItem">
        <div class="detail-heading">
          <div>
            <strong>{{ selectedItemLabel }}</strong>
            <small>{{ selectedItem.specification || '未填写规格' }}</small>
          </div>
          <el-button data-testid="inventory-edit-open" :disabled="Boolean(busyAction)" @click="openEdit">编辑资料</el-button>
        </div>
        <el-descriptions :column="2" border class="inventory-descriptions">
          <el-descriptions-item label="库存数量">{{ selectedItem.quantity }} {{ selectedItem.unit }}</el-descriptions-item>
          <el-descriptions-item label="单价">{{ formatMoney(selectedItem.average_unit_cost_cents) }}</el-descriptions-item>
          <el-descriptions-item label="库存价值">{{ formatMoney(selectedItem.inventory_value_cents) }}</el-descriptions-item>
          <el-descriptions-item label="品牌 / 型号">{{ [selectedItem.brand, selectedItem.model].filter(Boolean).join(' / ') || '—' }}</el-descriptions-item>
        </el-descriptions>

        <div class="movement-heading">
          <strong>库存流水</strong>
          <small>流水只追加不改写；仅项目领用支持冲销。</small>
        </div>
        <el-empty v-if="selectedMovements.length === 0" description="暂无库存流水" />
        <div v-else class="table-scroll movement-scroll">
          <el-table :data="selectedMovements" row-key="id" size="small" class="movement-table">
            <el-table-column label="日期" prop="occurred_on" min-width="112" />
            <el-table-column label="类型" min-width="100"><template #default="scope">{{ movementLabel(scope.row.kind) }}</template></el-table-column>
            <el-table-column label="数量变化" min-width="110"><template #default="scope"><strong>{{ scope.row.quantity_delta }} {{ selectedItem.unit }}</strong></template></el-table-column>
            <el-table-column label="项目 / 领用人" min-width="170"><template #default="scope">{{ scope.row.project_code || '—' }} / {{ workerName(scope.row.worker_id) }}</template></el-table-column>
            <el-table-column label="原因 / 备注" min-width="180"><template #default="scope">{{ scope.row.reason || scope.row.notes || '—' }}</template></el-table-column>
            <el-table-column label="操作" width="82" fixed="right">
              <template #default="scope">
                <el-button
                  v-if="scope.row.kind === 'issue' && !reversedMovementIds.has(scope.row.id)"
                  :data-testid="`inventory-issue-reverse-${scope.row.id}`"
                  link
                  type="danger"
                  @click="openReversal(scope.row)"
                >冲销</el-button>
                <el-tag v-else-if="scope.row.kind === 'issue'" size="small" type="info">已冲销</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="createVisible" data-testid="inventory-create-dialog" :teleported="false" title="新增库存（演示数据）" width="min(94vw, 680px)">
      <el-form label-position="top" @submit.prevent="createItem">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="createForm.brand" data-testid="inventory-create-brand" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="名称"><el-input v-model="createForm.name" data-testid="inventory-create-name" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="createForm.model" data-testid="inventory-create-model" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="数量"><el-input v-model="createForm.openingQuantity" data-testid="inventory-create-quantity" placeholder="例如 2.500" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="单价（元）"><el-input v-model="createForm.unitPriceYuan" data-testid="inventory-create-price" inputmode="decimal" placeholder="例如 1289.05" /></el-form-item></el-col>
        </el-row>
        <el-collapse v-model="moreInformation" class="more-information">
          <el-collapse-item title="更多信息" name="details">
            <el-row :gutter="14">
              <el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="createForm.specification" data-testid="inventory-create-specification" /></el-form-item></el-col>
              <el-col :xs="24" :sm="12"><el-form-item label="单位"><el-input v-model="createForm.unit" data-testid="inventory-create-unit" /></el-form-item></el-col>
            </el-row>
            <el-form-item label="备注"><el-input v-model="createForm.notes" data-testid="inventory-create-notes" type="textarea" /></el-form-item>
          </el-collapse-item>
        </el-collapse>
        <div class="dialog-actions">
          <el-button data-testid="inventory-create-cancel" :disabled="busyAction === 'create'" @click="createVisible = false">取消</el-button>
          <el-button data-testid="inventory-create-submit" type="primary" native-type="submit" :loading="busyAction === 'create'">保存（演示数据）</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="editVisible" data-testid="inventory-edit-dialog" :teleported="false" title="编辑库存资料（演示数据）" width="min(94vw, 620px)">
      <el-alert title="数量、单价和库存价值只能通过库存流水变化，此处只编辑物料资料。" type="info" :closable="false" />
      <el-form label-position="top" @submit.prevent="updateItem">
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="品牌"><el-input v-model="editForm.brand" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="名称"><el-input v-model="editForm.name" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="型号"><el-input v-model="editForm.model" data-testid="inventory-edit-model" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="规格"><el-input v-model="editForm.specification" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="单位"><el-input v-model="editForm.unit" /></el-form-item></el-col>
        </el-row>
        <div class="dialog-actions">
          <el-button :disabled="busyAction === 'edit'" @click="editVisible = false">取消</el-button>
          <el-button data-testid="inventory-edit-submit" type="primary" native-type="submit" :loading="busyAction === 'edit'">保存资料</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="adjustVisible" data-testid="inventory-adjust-dialog" :teleported="false" title="库存调整（演示数据）" width="min(92vw, 560px)">
      <el-form label-position="top" @submit.prevent="adjustItem">
        <el-form-item label="库存物料"><strong class="selected-item">{{ selectedItemLabel }}</strong></el-form-item>
        <el-form-item label="数量变化"><el-input v-model="adjustForm.quantityDelta" placeholder="增加填 2.000，减少填 -0.500" /></el-form-item>
        <el-form-item label="原因"><el-input v-model="adjustForm.reason" /></el-form-item>
        <el-form-item label="发生日期"><el-date-picker v-model="adjustForm.occurredOn" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="busyAction === 'adjust'" @click="adjustVisible = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busyAction === 'adjust'">保存调整（演示数据）</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="issueVisible" data-testid="inventory-issue-dialog" :teleported="false" title="项目领用（演示数据）" width="min(94vw, 680px)">
      <el-form label-position="top" @submit.prevent="issueItem">
        <el-form-item label="库存物料"><strong class="selected-item">{{ selectedItemLabel }}</strong></el-form-item>
        <el-row :gutter="14">
          <el-col :xs="24" :sm="12"><el-form-item label="项目编号"><el-input v-model="issueForm.projectCode" data-testid="inventory-issue-project" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="领用日期"><el-date-picker v-model="issueForm.issuedOn" data-testid="inventory-issue-date" type="date" value-format="YYYY-MM-DD" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="领用人"><el-select v-model="issueForm.workerId" data-testid="inventory-issue-worker" :teleported="false"><el-option v-for="worker in workers" :key="worker.id" :label="worker.name" :value="worker.id" /></el-select></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="领用数量"><el-input v-model="issueForm.quantity" data-testid="inventory-issue-quantity" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="备注"><el-input v-model="issueForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="busyAction === 'issue'" @click="issueVisible = false">取消</el-button>
          <el-button data-testid="inventory-issue-submit" type="primary" native-type="submit" :loading="busyAction === 'issue'">确认领用（演示数据）</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="reversalVisible" data-testid="inventory-reversal-dialog" :teleported="false" title="冲销项目领用（演示数据）" width="min(92vw, 520px)">
      <el-alert title="冲销不会改写原领用记录，而是追加一条数量相反的库存流水。" type="warning" :closable="false" />
      <el-form label-position="top" @submit.prevent="reverseIssue">
        <el-form-item label="冲销日期"><el-date-picker v-model="reversalForm.reversedOn" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        <el-form-item label="冲销原因"><el-input v-model="reversalForm.reason" data-testid="inventory-reversal-reason" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button :disabled="busyAction === 'reverse'" @click="reversalVisible = false">取消</el-button>
          <el-button data-testid="inventory-reversal-submit" type="danger" native-type="submit" :loading="busyAction === 'reverse'">确认冲销</el-button>
        </div>
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.inventory-center { width: 100%; min-width: 0; }
.inventory-heading, .table-heading, .title-line, .dialog-actions { display: flex; align-items: center; }
.inventory-heading { justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.title-line { gap: 10px; }
.inventory-heading h2 { margin: 0; color: var(--sunyu-ink); font-size: 24px; }
.inventory-heading p { margin: 5px 0 0; color: var(--sunyu-muted); font-size: 13px; }
.feedback { margin-bottom: 12px; }
.inventory-card { min-width: 0; }
.table-heading { justify-content: space-between; gap: 14px; }
.inventory-search { width: min(100%, 300px); }
.table-scroll { width: 100%; overflow-x: auto; }
.inventory-table { min-width: 760px; }
.inventory-mobile-list { display: none; }
.more-information { margin: 2px 0 18px; border-bottom: 0; }
.selected-item { color: var(--sunyu-ink); line-height: 32px; }
.dialog-actions { justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.detail-heading, .movement-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.detail-heading > div { display: grid; gap: 4px; }
.detail-heading small, .movement-heading small { color: var(--sunyu-muted); }
.inventory-descriptions { margin-top: 16px; }
.movement-heading { margin: 22px 0 10px; }
.movement-scroll { max-width: 100%; }
.movement-table { min-width: 720px; }
@media (max-width: 700px) {
  .inventory-heading, .table-heading, .detail-heading, .movement-heading { align-items: stretch; flex-direction: column; }
  .inventory-heading > .el-button, .inventory-search { width: 100%; }
  .inventory-descriptions { --el-descriptions-table-border: 1px solid var(--el-border-color-lighter); }
}
@media (max-width: 520px) {
  .inventory-card > :deep(.el-card__body > .table-scroll) { display: none; }
  .inventory-mobile-list { display: grid; gap: 10px; }
  .inventory-mobile-item :deep(.el-card__body) { display: grid; gap: 10px; padding: 14px; }
  .mobile-item-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .mobile-item-heading :deep(.el-button) { height: auto; margin: 0; padding: 0; white-space: normal; text-align: left; }
  .inventory-mobile-item small { color: var(--sunyu-muted); overflow-wrap: anywhere; }
  .mobile-item-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .mobile-item-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
