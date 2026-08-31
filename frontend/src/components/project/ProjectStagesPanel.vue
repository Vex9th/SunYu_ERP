<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import type { ProjectOperatingSnapshot, ProjectStage, ProjectStageStatus } from '../../domain/contracts'
import type { ProjectOperatingRepository } from '../../repositories/project'
import { createPreviewProjectRepository } from '../../repositories/project.mock'

const props = withDefaults(defineProps<{
  projectCode?: string
  stages: ProjectOperatingSnapshot['stages']
  repository?: ProjectOperatingRepository
}>(), {
  projectCode: 'SY-2026-001',
  repository: () => createPreviewProjectRepository(),
})
const emit = defineEmits<{ changed: [stages: ProjectStage[]] }>()

const copyStages = (stages: ProjectStage[]): ProjectStage[] => stages.map((stage) => ({ ...stage }))
const displayStages = ref<ProjectStage[]>(copyStages(props.stages))
const scheduleVisible = ref(false)
const transitionVisible = ref(false)
const selectedStageCode = ref('')
const actionError = ref<string | null>(null)
const saving = ref(false)

watch(() => props.stages, (stages) => { displayStages.value = copyStages(stages) }, { deep: true })

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
const completedCount = computed(() => displayStages.value.filter((stage) => stage.status === 'completed').length)
const selectedStage = computed(() => displayStages.value.find((stage) => stage.stage_code === selectedStageCode.value))
const availableTransitions = computed(() => selectedStage.value ? transitionOptions[selectedStage.value.status] : [])

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

function replaceStage(stage: ProjectStage): void {
  const index = displayStages.value.findIndex((item) => item.stage_code === stage.stage_code)
  if (index >= 0) displayStages.value.splice(index, 1, { ...stage })
  emit('changed', copyStages(displayStages.value))
}

function openSchedule(stage: ProjectStage): void {
  selectedStageCode.value = stage.stage_code
  Object.assign(scheduleForm, {
    planned_start_on: stage.planned_start_on ?? '',
    planned_end_on: stage.planned_end_on ?? '',
    notes: stage.notes ?? '',
  })
  actionError.value = null
  scheduleVisible.value = true
}

async function saveSchedule(): Promise<void> {
  if (!selectedStage.value) return
  saving.value = true
  actionError.value = null
  try {
    const result = await props.repository.updateStageSchedule(props.projectCode, selectedStage.value.stage_code, {
      planned_start_on: nullable(scheduleForm.planned_start_on),
      planned_end_on: nullable(scheduleForm.planned_end_on),
      notes: nullable(scheduleForm.notes),
      expected_revision: selectedStage.value.revision,
    })
    replaceStage(result.data)
    scheduleVisible.value = false
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '排期保存失败'
  } finally {
    saving.value = false
  }
}

function openTransition(stage: ProjectStage): void {
  selectedStageCode.value = stage.stage_code
  transitionForm.to_status = transitionOptions[stage.status][0] ?? 'in_progress'
  transitionForm.reason = ''
  actionError.value = null
  transitionVisible.value = true
}

async function saveTransition(): Promise<void> {
  if (!selectedStage.value) return
  saving.value = true
  actionError.value = null
  try {
    const result = await props.repository.transitionStage(props.projectCode, selectedStage.value.stage_code, {
      to_status: transitionForm.to_status,
      occurred_at: new Date().toISOString(),
      reason: nullable(transitionForm.reason),
      expected_revision: selectedStage.value.revision,
    })
    replaceStage(result.data)
    transitionVisible.value = false
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '状态流转失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-card data-testid="project-demo-stages" class="stage-flow" shadow="never">
    <template #header>
      <div class="stage-flow__heading">
        <div>
          <el-text tag="strong" size="large">完整项目流程</el-text>
          <p class="section-note">排期和状态操作只写入演示数据，不调用尚未实现的后端接口。</p>
        </div>
        <el-space><el-tag type="warning" effect="plain">演示数据</el-tag><el-tag type="info">{{ completedCount }} / {{ displayStages.length }} 已完成</el-tag></el-space>
      </div>
    </template>

    <el-timeline class="stage-timeline">
      <el-timeline-item v-for="(stage, index) in displayStages" :key="stage.stage_code"
        :data-testid="`stage-row-${stage.stage_code}`" :type="statusTypes[stage.status]" :hollow="stage.status === 'pending'">
        <div class="stage-row">
          <div class="stage-row__main">
            <span class="stage-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <strong>{{ stageLabels[stage.stage_code] ?? stage.stage_code }}</strong>
            <el-tag size="small" :type="statusTypes[stage.status]">{{ statusLabels[stage.status] }}</el-tag>
            <span class="stage-row__actions">
              <el-button :data-testid="`stage-schedule-${stage.stage_code}`" link type="primary" @click="openSchedule(stage)">编辑排期</el-button>
              <el-button :data-testid="`stage-transition-${stage.stage_code}`" link @click="openTransition(stage)">变更状态</el-button>
            </span>
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
        </div>
      </el-timeline-item>
    </el-timeline>

    <el-dialog v-model="scheduleVisible" title="编辑阶段排期 · 演示" :teleported="false" width="min(92vw, 520px)">
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveSchedule">
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12"><el-form-item label="计划开始"><el-input data-testid="stage-schedule-start" v-model="scheduleForm.planned_start_on" placeholder="YYYY-MM-DD" /></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="计划完成"><el-input data-testid="stage-schedule-end" v-model="scheduleForm.planned_end_on" placeholder="YYYY-MM-DD" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="排期备注"><el-input data-testid="stage-schedule-notes" v-model="scheduleForm.notes" type="textarea" /></el-form-item>
        <el-button data-testid="stage-schedule-save" type="primary" :loading="saving" @click="saveSchedule">保存演示排期</el-button>
      </el-form>
    </el-dialog>

    <el-dialog v-model="transitionVisible" title="变更阶段状态 · 演示" :teleported="false" width="min(92vw, 500px)">
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveTransition">
        <el-form-item label="目标状态" required>
          <el-select data-testid="stage-transition-status" v-model="transitionForm.to_status" style="width: 100%">
            <el-option v-for="status in availableTransitions" :key="status" :label="statusLabels[status]" :value="status" />
          </el-select>
        </el-form-item>
        <el-form-item label="原因（阻塞、跳过或重开时必填）"><el-input data-testid="stage-transition-reason" v-model="transitionForm.reason" type="textarea" /></el-form-item>
        <el-button data-testid="stage-transition-save" type="primary" :loading="saving" @click="saveTransition">确认演示流转</el-button>
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
.stage-row__reason { color: var(--el-color-danger-dark-2); }
.stage-row__note { color: var(--el-text-color-secondary); }
.stage-row__actions { display: inline-flex; align-items: center; margin-left: auto; }
@media (max-width: 640px) {
  .stage-flow__heading, .stage-row__main { align-items: flex-start; flex-wrap: wrap; }
  .stage-row__actions { width: 100%; margin-left: 26px; }
}
</style>
