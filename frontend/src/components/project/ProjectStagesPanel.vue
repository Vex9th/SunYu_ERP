<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { ElMessageBox } from 'element-plus'

import { ApiError } from '../../api'
import type { ProjectOperatingSnapshot, ProjectStage, ProjectStageStatus } from '../../domain/contracts'
import { createHttpProjectOperatingRepository } from '../../repositories/project-operating.live'
import type { ProjectStageRepository } from '../../repositories/project'

const props = withDefaults(defineProps<{
  projectCode?: string
  stages: ProjectOperatingSnapshot['stages']
  repository?: ProjectStageRepository
  readonly?: boolean
}>(), {
  projectCode: 'SY-2026-001',
  repository: () => createHttpProjectOperatingRepository(),
  readonly: false,
})
const emit = defineEmits<{ changed: [stages: ProjectStage[]] }>()

const copyStages = (stages: ProjectStage[]): ProjectStage[] => stages.map((stage) => ({ ...stage }))
const displayStages = ref<ProjectStage[]>(copyStages(props.stages))
const scheduleVisible = ref(false)
const transitionVisible = ref(false)
const selectedStageCode = ref('')
const actionError = ref<string | null>(null)
const saving = ref(false)
const loading = ref(false)
const loadError = ref<string | null>(null)
const stagesLoaded = ref(false)
let loadSequence = 0
let contextGeneration = 0
interface PendingTransition {
  generation: number
  projectCode: string
  repository: ProjectStageRepository
  stageCode: string
  input: {
    to_status: ProjectStageStatus
    occurred_at: string
    reason: string | null
    expected_revision: number
  }
}
const unresolvedTransition = shallowRef<PendingTransition | null>(null)

function resetTransientState(): void {
  scheduleVisible.value = false
  transitionVisible.value = false
  selectedStageCode.value = ''
  actionError.value = null
  saving.value = false
  unresolvedTransition.value = null
}

watch(() => props.stages, (stages) => {
  if (!stagesLoaded.value) displayStages.value = copyStages(stages)
}, { deep: true })

watch(
  [() => props.projectCode, () => props.repository],
  () => {
    contextGeneration += 1
    resetTransientState()
    void loadProjectStages()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  contextGeneration += 1
  loadSequence += 1
  resetTransientState()
  loading.value = false
  loadError.value = null
  stagesLoaded.value = false
})

const stageLabels: Record<string, string> = {
  planning: '项目规划', site_survey: '现场测绘', quotation: '我方报价',
  technical_agreement: '技术协议', contract: '合同签订', advance_payment: '预付款',
  mechanical_design: '机械设计', electrical_design: '电气设计', procurement: '采购',
  staffing: '人员排单', mechanical_signoff: '机械图纸会签', electrical_signoff: '电气图纸会签',
  construction: '施工', progress_payment: '进度款', commissioning: '调试',
  acceptance: '验收', final_payment: '尾款', closeout: '收尾',
}
const statusLabels: Record<ProjectStageStatus, string> = {
  pending: '未开始', in_progress: '进行中', blocked: '阻塞', completed: '已完成', skipped: '已跳过',
}
const statusTypes: Record<ProjectStageStatus, 'info' | 'primary' | 'danger' | 'success' | 'warning'> = {
  pending: 'info', in_progress: 'primary', blocked: 'danger', completed: 'success', skipped: 'warning',
}
const transitionOptions: Record<ProjectStageStatus, ProjectStageStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['blocked', 'completed', 'skipped'],
  blocked: ['in_progress', 'skipped'],
  completed: ['in_progress'],
  skipped: ['in_progress'],
}

const scheduleForm = reactive({ planned_start_on: '', planned_end_on: '', notes: '' })
const transitionForm = reactive({ to_status: 'in_progress' as ProjectStageStatus, reason: '' })
let scheduleFormBaseline = ''
let transitionFormBaseline = ''
const completedCount = computed(() => displayStages.value.filter((stage) => stage.status === 'completed').length)
const selectedStage = computed(() => displayStages.value.find((stage) => stage.stage_code === selectedStageCode.value))
const currentStage = computed(() => (
  displayStages.value.find((stage) => stage.status === 'in_progress')
  ?? displayStages.value.find((stage) => stage.status === 'blocked')
  ?? displayStages.value.find((stage) => stage.status === 'pending')
  ?? displayStages.value[displayStages.value.length - 1]
  ?? null
))
const availableTransitions = computed(() => selectedStage.value ? transitionOptions[selectedStage.value.status] : [])
const canWrite = computed(() => !props.readonly && stagesLoaded.value && !loading.value && !loadError.value)
const transitionNeedsReason = computed(() => {
  const fromStatus = selectedStage.value?.status
  const toStatus = transitionForm.to_status
  return toStatus === 'blocked'
    || toStatus === 'skipped'
    || (toStatus === 'in_progress' && ['blocked', 'completed', 'skipped'].includes(fromStatus ?? ''))
})
const transitionDialogTitle = computed(() => {
  if (selectedStage.value?.status === 'blocked') return '处理阶段阻塞'
  if (selectedStage.value?.status === 'completed' || selectedStage.value?.status === 'skipped') return '重新打开阶段'
  return '变更阶段状态'
})
const transitionSaveDisabled = computed(() => (
  saving.value
  || unresolvedTransition.value !== null
  || (transitionNeedsReason.value && transitionForm.reason.trim().length === 0)
))

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

async function loadProjectStages(): Promise<void> {
  const sequence = ++loadSequence
  displayStages.value = copyStages(props.stages)
  stagesLoaded.value = false
  loading.value = true
  loadError.value = null
  try {
    const result = await props.repository.listProjectStages(props.projectCode)
    if (sequence !== loadSequence) return
    displayStages.value = copyStages(result.data)
    stagesLoaded.value = true
  } catch (error) {
    if (sequence !== loadSequence) return
    loadError.value = error instanceof Error ? error.message : '无法读取项目阶段'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function replaceStage(stage: ProjectStage): void {
  const index = displayStages.value.findIndex((item) => item.stage_code === stage.stage_code)
  if (index >= 0) displayStages.value.splice(index, 1, { ...stage })
  emit('changed', copyStages(displayStages.value))
}

function isCurrentContext(
  generation: number,
  projectCode: string,
  repository: ProjectStageRepository,
): boolean {
  return generation === contextGeneration
    && projectCode === props.projectCode
    && repository === props.repository
}

function fillScheduleForm(stage: ProjectStage): void {
  Object.assign(scheduleForm, {
    planned_start_on: stage.planned_start_on ?? '',
    planned_end_on: stage.planned_end_on ?? '',
    notes: stage.notes ?? '',
  })
}

function selectScheduleStage(stageCode: string): void {
  const stage = displayStages.value.find((item) => item.stage_code === stageCode)
  if (stage) fillScheduleForm(stage)
}

function scheduleFormFingerprint(): string {
  return JSON.stringify([selectedStageCode.value, scheduleForm])
}

function transitionFormFingerprint(): string {
  return JSON.stringify([selectedStageCode.value, transitionForm])
}

function openSchedule(stage: ProjectStage | null = currentStage.value): void {
  if (!canWrite.value) return
  if (!stage) return
  selectedStageCode.value = stage.stage_code
  fillScheduleForm(stage)
  scheduleFormBaseline = scheduleFormFingerprint()
  actionError.value = null
  scheduleVisible.value = true
}

async function saveSchedule(): Promise<void> {
  const stage = selectedStage.value
  if (!stage || !canWrite.value) return
  const generation = contextGeneration
  const projectCode = props.projectCode
  const repository = props.repository
  saving.value = true
  actionError.value = null
  try {
    const result = await repository.updateStageSchedule(projectCode, stage.stage_code, {
      planned_start_on: nullable(scheduleForm.planned_start_on),
      planned_end_on: nullable(scheduleForm.planned_end_on),
      notes: nullable(scheduleForm.notes),
      expected_revision: stage.revision,
    })
    if (!isCurrentContext(generation, projectCode, repository)) return
    replaceStage(result.data)
    scheduleVisible.value = false
  } catch (error) {
    if (!isCurrentContext(generation, projectCode, repository)) return
    actionError.value = error instanceof Error ? error.message : '排期保存失败'
  } finally {
    if (isCurrentContext(generation, projectCode, repository)) saving.value = false
  }
}

function openTransition(stage: ProjectStage | null = currentStage.value): void {
  if (!canWrite.value) return
  if (!stage) return
  selectedStageCode.value = stage.stage_code
  transitionForm.to_status = transitionOptions[stage.status][0] ?? 'in_progress'
  transitionForm.reason = ''
  transitionFormBaseline = transitionFormFingerprint()
  actionError.value = null
  transitionVisible.value = true
}

function transitionOptionLabel(status: ProjectStageStatus): string {
  if (selectedStage.value?.status === 'blocked' && status === 'in_progress') return '解决阻塞（恢复进行）'
  if (status === 'skipped') return '跳过本阶段'
  if (selectedStage.value?.status === 'completed' || selectedStage.value?.status === 'skipped') return '重新打开为进行中'
  return statusLabels[status]
}

function isIndeterminateFailure(error: unknown): boolean {
  return !(error instanceof ApiError)
    || error.status === 0
    || [408, 425, 429].includes(error.status)
    || error.status >= 500
}

async function sendTransition(pending: PendingTransition): Promise<void> {
  saving.value = true
  actionError.value = null
  try {
    const result = await pending.repository.transitionStage(
      pending.projectCode,
      pending.stageCode,
      pending.input,
    )
    if (!isCurrentContext(pending.generation, pending.projectCode, pending.repository)) return
    unresolvedTransition.value = null
    replaceStage(result.data)
    transitionVisible.value = false
  } catch (error) {
    if (!isCurrentContext(pending.generation, pending.projectCode, pending.repository)) return
    if (isIndeterminateFailure(error)) {
      unresolvedTransition.value = pending
      actionError.value = '状态变更结果未知，请保持当前内容并原样重试'
    } else {
      unresolvedTransition.value = null
      actionError.value = error instanceof Error ? error.message : '状态流转失败'
    }
  } finally {
    if (isCurrentContext(pending.generation, pending.projectCode, pending.repository)) saving.value = false
  }
}

function saveTransition(): Promise<void> | undefined {
  const stage = selectedStage.value
  if (!stage || !canWrite.value || unresolvedTransition.value !== null) return undefined
  if (transitionNeedsReason.value && transitionForm.reason.trim().length === 0) {
    actionError.value = '请填写本次状态处理原因'
    return undefined
  }
  const pending: PendingTransition = {
    generation: contextGeneration,
    projectCode: props.projectCode,
    repository: props.repository,
    stageCode: stage.stage_code,
    input: {
      to_status: transitionForm.to_status,
      occurred_at: new Date().toISOString(),
      reason: nullable(transitionForm.reason),
      expected_revision: stage.revision,
    },
  }
  return sendTransition(pending)
}

function retryOriginalTransition(): Promise<void> | undefined {
  const pending = unresolvedTransition.value
  if (!pending || saving.value) return undefined
  if (!isCurrentContext(pending.generation, pending.projectCode, pending.repository)) return undefined
  return sendTransition(pending)
}

function confirmDirtyClose(dirty: boolean, done: () => void): void {
  if (!dirty) {
    done()
    return
  }
  void ElMessageBox.confirm(
    '关闭后未保存的内容会丢失，确定关闭吗？',
    '放弃未保存内容',
    {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '继续填写',
    },
  ).then(() => done()).catch(() => undefined)
}

function beforeScheduleClose(done: () => void): void {
  if (saving.value) return
  confirmDirtyClose(scheduleFormFingerprint() !== scheduleFormBaseline, done)
}

function beforeTransitionClose(done: () => void): void {
  if (saving.value || unresolvedTransition.value !== null) return
  confirmDirtyClose(transitionFormFingerprint() !== transitionFormBaseline, done)
}

function cancelSchedule(): void {
  beforeScheduleClose(() => { scheduleVisible.value = false })
}

function cancelTransition(): void {
  beforeTransitionClose(() => { transitionVisible.value = false })
}
</script>

<template>
  <el-card data-testid="project-stages" class="stage-flow" shadow="never">
    <template #header>
      <div class="stage-flow__heading">
        <div>
          <el-text tag="strong" size="large">完整项目流程</el-text>
          <p class="section-note">查看当前项目阶段，并维护排期和实际进展。</p>
        </div>
        <el-space wrap>
          <el-tag v-if="readonly" type="info" effect="plain">项目已归档，仅供查看</el-tag>
          <el-tag type="info">{{ completedCount }} / {{ displayStages.length }} 已完成</el-tag>
          <el-button
            v-if="currentStage && !readonly"
            :data-testid="`stage-schedule-${currentStage.stage_code}`"
            :disabled="!canWrite"
            @click="openSchedule()"
          >维护排期</el-button>
          <el-button
            v-if="currentStage && !readonly"
            :data-testid="`stage-transition-${currentStage.stage_code}`"
            type="primary"
            :disabled="!canWrite"
              @click="openTransition()"
          >{{ currentStage.status === 'blocked' ? '处理阻塞' : '更新当前阶段' }}</el-button>
        </el-space>
      </div>
    </template>

    <el-alert
      v-if="loading"
      data-testid="project-stages-loading"
      title="正在读取项目阶段…"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="loadError"
      data-testid="project-stages-load-error"
      title="项目阶段读取失败"
      :description="`${loadError}；读取失败期间为只读状态，当前保留页面已有阶段供查看。`"
      type="error"
      :closable="false"
      show-icon
    />

    <el-empty
      v-if="stagesLoaded && !loading && !loadError && displayStages.length === 0"
      data-testid="project-stages-empty"
      description="当前项目没有阶段记录"
    />
    <el-timeline v-else-if="displayStages.length > 0" class="stage-timeline">
      <el-timeline-item v-for="(stage, index) in displayStages" :key="stage.stage_code"
        :data-testid="`stage-row-${stage.stage_code}`" :type="statusTypes[stage.status]" :hollow="stage.status === 'pending'">
        <div class="stage-row">
          <div class="stage-row__main">
            <span class="stage-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <strong>{{ stageLabels[stage.stage_code] ?? stage.stage_code }}</strong>
            <el-tag size="small" :type="statusTypes[stage.status]">{{ statusLabels[stage.status] }}</el-tag>
          </div>
          <div class="stage-row__detail">
            <span v-if="stage.planned_start_on || stage.planned_end_on">计划 {{ stage.planned_start_on ?? '--' }} 至 {{ stage.planned_end_on ?? '--' }}</span>
            <span v-else>暂无计划日期</span>
          </div>
          <div v-if="stage.status_reason" class="stage-row__reason" :data-testid="`stage-status-reason-${stage.stage_code}`">
            <strong>状态原因：</strong>{{ stage.status_reason }}
          </div>
          <div v-if="stage.notes" class="stage-row__note">
            <strong>排期备注：</strong>{{ stage.notes }}
          </div>
          <div v-if="!readonly && canWrite && ['completed', 'skipped'].includes(stage.status)" class="stage-row__correction">
            <el-button
              :data-testid="`stage-reopen-${stage.stage_code}`"
              link
              type="primary"
              @click="openTransition(stage)"
            >重新打开</el-button>
          </div>
          <div v-else-if="!readonly && canWrite && stage.status === 'blocked' && stage.stage_code !== currentStage?.stage_code" class="stage-row__correction">
            <el-button
              :data-testid="`stage-unblock-${stage.stage_code}`"
              link
              type="warning"
              @click="openTransition(stage)"
            >处理阻塞</el-button>
          </div>
        </div>
      </el-timeline-item>
    </el-timeline>

    <el-dialog
      v-model="scheduleVisible"
      title="编辑阶段排期"
      :teleported="false"
      width="min(92vw, 520px)"
      :before-close="beforeScheduleClose"
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
      <el-form label-position="top" :disabled="saving" @submit.prevent="saveSchedule">
        <el-form-item label="阶段" required>
          <el-select data-testid="stage-schedule-stage" v-model="selectedStageCode" style="width: 100%" @update:model-value="selectScheduleStage">
            <el-option
              v-for="stage in displayStages"
              :key="stage.stage_code"
              :label="stageLabels[stage.stage_code] ?? stage.stage_code"
              :value="stage.stage_code"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12"><el-form-item label="计划开始"><el-date-picker data-testid="stage-schedule-start" v-model="scheduleForm.planned_start_on" type="date" value-format="YYYY-MM-DD" clearable style="width: 100%" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="计划完成"><el-date-picker data-testid="stage-schedule-end" v-model="scheduleForm.planned_end_on" type="date" value-format="YYYY-MM-DD" clearable style="width: 100%" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="排期备注"><el-input data-testid="stage-schedule-notes" v-model="scheduleForm.notes" type="textarea" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="stage-schedule-cancel" native-type="button" :disabled="saving" @click="cancelSchedule">取消</el-button>
          <el-button data-testid="stage-schedule-save" type="primary" native-type="submit" :loading="saving" :disabled="saving">保存排期</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="transitionVisible"
      :title="transitionDialogTitle"
      :teleported="false"
      width="min(92vw, 500px)"
      :before-close="beforeTransitionClose"
      :close-on-click-modal="!saving && unresolvedTransition === null"
      :close-on-press-escape="!saving && unresolvedTransition === null"
      :show-close="!saving && unresolvedTransition === null"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
      <el-alert
        v-if="selectedStage?.status === 'blocked'"
        title="解决阻塞会恢复为进行中；跳过本阶段会结束该阶段。两种操作都不会删除原阻塞记录。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert
        v-else-if="selectedStage?.status === 'completed' || selectedStage?.status === 'skipped'"
        title="原完成记录会保留在阶段历史中；请说明为什么需要重新打开。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-form label-position="top" @submit.prevent="saveTransition">
        <el-form-item label="目标状态" required>
          <el-select data-testid="stage-transition-status" v-model="transitionForm.to_status" style="width: 100%" :disabled="saving || unresolvedTransition !== null">
            <el-option v-for="status in availableTransitions" :key="status" :label="transitionOptionLabel(status)" :value="status" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理原因" :required="transitionNeedsReason"><el-input data-testid="stage-transition-reason" v-model="transitionForm.reason" type="textarea" :disabled="saving || unresolvedTransition !== null" /></el-form-item>
        <div class="dialog-actions">
          <el-button data-testid="stage-transition-cancel" native-type="button" :disabled="saving || unresolvedTransition !== null" @click="cancelTransition">取消</el-button>
          <el-button v-if="unresolvedTransition" data-testid="stage-transition-original-retry" type="danger" native-type="button" :loading="saving" @click.prevent.stop="retryOriginalTransition">原样重试</el-button>
          <el-button v-else data-testid="stage-transition-save" type="primary" native-type="submit" :loading="saving" :disabled="transitionSaveDisabled">确认状态变更</el-button>
        </div>
      </el-form>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.stage-flow, .stage-timeline { min-width: 0; }
.stage-flow__heading, .stage-row__main, .stage-row__detail { display: flex; align-items: center; gap: 10px; }
.stage-flow__heading { justify-content: space-between; }
.stage-flow__heading .section-note { margin: 4px 0 0; }
.stage-timeline { padding-left: 4px; }
.stage-row { display: grid; gap: 4px; padding-bottom: 4px; }
.stage-index { color: var(--el-text-color-placeholder); font-variant-numeric: tabular-nums; }
.stage-row__detail { flex-wrap: wrap; color: var(--el-text-color-secondary); font-size: 13px; }
.stage-row__reason, .stage-row__note { font-size: 13px; line-height: 1.6; }
.stage-row__correction { justify-self: start; }
.stage-row__reason { color: var(--el-color-danger-dark-2); }
.stage-row__note { color: var(--el-text-color-secondary); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
@media (max-width: 640px) {
  .stage-flow__heading, .stage-row__main { align-items: flex-start; flex-wrap: wrap; }
}
</style>
