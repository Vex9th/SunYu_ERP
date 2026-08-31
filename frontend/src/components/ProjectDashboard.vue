<script setup lang="ts">
import { defineAsyncComponent, reactive, ref, watch } from 'vue'

import { ApiError } from '../api'
import type { ClosureType, ProjectDetail, ProjectOperatingSnapshot } from '../domain/contracts'
import { createHttpProjectRepository } from '../repositories/project'
import type { DataSource } from '../repositories/common'
import type { ProjectDashboardData } from '../types'
import ProjectCommercialPanel from './project/ProjectCommercialPanel.vue'
import ProjectOverviewPanel from './project/ProjectOverviewPanel.vue'
import ProjectRecordsPanel from './project/ProjectRecordsPanel.vue'

const ProjectDocumentsPanel = defineAsyncComponent(() => import('./project/ProjectDocumentsPanel.vue'))
const ProcurementWorkspace = defineAsyncComponent(() => import('./procurement/ProcurementWorkspace.vue'))
const WorkforceCenter = defineAsyncComponent(() => import('./workforce/WorkforceCenter.vue'))
const DeliveryWorkspace = defineAsyncComponent(() => import('./delivery/DeliveryWorkspace.vue'))

const props = defineProps<{
  projectCode: string
}>()

const emit = defineEmits<{
  back: []
  'session-expired': [message: string]
}>()

const data = ref<ProjectDashboardData | null>(null)
const operating = ref<ProjectOperatingSnapshot | null>(null)
const projectPreview = ref<ProjectDetail | null>(null)
const baseSource = ref<DataSource | null>(null)
const operatingSource = ref<DataSource | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const editVisible = ref(false)
const closeVisible = ref(false)
const projectActionError = ref<string | null>(null)
const projectSaving = ref(false)
const editForm = reactive({ name: '', description: '' })
const closeForm = reactive({ closure_type: 'completed' as ClosureType, reason: '' })
type ProjectWorkspaceTab =
  | 'home'
  | 'documents'
  | 'commercial'
  | 'procurement'
  | 'workforce'
  | 'delivery'
const initialTab = (): ProjectWorkspaceTab => 'home'
const activeTab = ref<ProjectWorkspaceTab>(initialTab())
const fieldView = ref<'site' | 'commissioning'>('site')
let loadVersion = 0
const repository = createHttpProjectRepository()
const operatingRepository = import('../repositories/project.mock').then(({ createPreviewProjectRepository }) => (
  createPreviewProjectRepository()
))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

async function loadDashboard(): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  loadError.value = null
  data.value = null
  operating.value = null
  projectPreview.value = null
  baseSource.value = null
  operatingSource.value = null
  try {
    const demo = await operatingRepository
    const [baseResult, operatingResult] = await Promise.all([
      repository.getBaseDashboard(props.projectCode),
      demo.getOperatingSnapshot(props.projectCode),
    ])
    const previewResult = await demo.openProject({
      ...baseResult.data.project,
      company_name: baseResult.data.company.name,
      closure_type: null,
      revision: 1,
    })
    if (version === loadVersion) {
      data.value = baseResult.data
      baseSource.value = baseResult.source
      operating.value = operatingResult?.data ?? null
      operatingSource.value = operatingResult?.source ?? null
      projectPreview.value = previewResult.data
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      emit('session-expired', error.message)
    }
    if (version !== loadVersion) return
    if (!(error instanceof ApiError) || error.status !== 401) {
      loadError.value = errorMessage(error)
    }
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

function statusLabel(status: ProjectDashboardData['project']['status']): string {
  return status === 'active' ? '在建' : '已归档'
}

function previewStatusLabel(project: ProjectDetail): string {
  if (project.status === 'active') return '在建'
  return project.closure_type === 'completed' ? '已完结' : '已取消'
}

function openProjectEdit(): void {
  if (!projectPreview.value) return
  editForm.name = projectPreview.value.name
  editForm.description = projectPreview.value.description ?? ''
  projectActionError.value = null
  editVisible.value = true
}

async function saveProjectEdit(): Promise<void> {
  if (!projectPreview.value) return
  const version = loadVersion
  projectSaving.value = true
  projectActionError.value = null
  try {
    const demo = await operatingRepository
    const result = await demo.updateProject(props.projectCode, {
      company_id: projectPreview.value.company_id,
      name: editForm.name,
      description: editForm.description.trim() || null,
      expected_revision: projectPreview.value.revision,
    })
    if (version === loadVersion) {
      projectPreview.value = result.data
      editVisible.value = false
    }
  } catch (error) {
    if (version === loadVersion) projectActionError.value = errorMessage(error)
  } finally {
    projectSaving.value = false
  }
}

function openProjectClose(): void {
  closeForm.closure_type = 'completed'
  closeForm.reason = ''
  projectActionError.value = null
  closeVisible.value = true
}

async function saveProjectClose(): Promise<void> {
  if (!projectPreview.value) return
  const version = loadVersion
  projectSaving.value = true
  projectActionError.value = null
  try {
    const demo = await operatingRepository
    const result = await demo.closeProject(props.projectCode, {
      closure_type: closeForm.closure_type,
      reason: closeForm.reason,
      expected_revision: projectPreview.value.revision,
    })
    if (version === loadVersion) {
      projectPreview.value = result.data
      closeVisible.value = false
    }
  } catch (error) {
    if (version === loadVersion) projectActionError.value = errorMessage(error)
  } finally {
    projectSaving.value = false
  }
}

function updateStages(stages: ProjectOperatingSnapshot['stages']): void {
  if (!operating.value) return
  operating.value = { ...operating.value, stages }
}

watch(
  () => props.projectCode,
  () => {
    activeTab.value = initialTab()
    fieldView.value = 'site'
    editVisible.value = false
    closeVisible.value = false
    projectActionError.value = null
    void loadDashboard()
  },
  { immediate: true },
)

watch(activeTab, (tab) => {
  if (tab !== 'workforce') fieldView.value = 'site'
})
</script>

<template>
  <el-space class="page-stack" direction="vertical" alignment="stretch" fill :size="20">
    <section class="project-hero">
      <el-button data-testid="project-dashboard-back" plain @click="emit('back')">返回项目中心</el-button>
      <div class="project-identity">
        <el-text type="info">{{ projectCode }}</el-text>
        <h1>{{ projectPreview?.name ?? data?.project.name ?? projectCode }}</h1>
        <p>{{ data ? `${data.company.name} · ${projectPreview?.description ?? data.project.description ?? '暂无项目说明'}` : '正在读取项目资料' }}</p>
        <el-text v-if="projectPreview?.archive_reason" type="info">完结说明：{{ projectPreview.archive_reason }}</el-text>
      </div>
      <div v-if="data" class="project-actions">
        <el-space class="project-statuses" wrap>
          <el-tag v-if="projectPreview" data-testid="project-status" :type="projectPreview.status === 'active' ? 'success' : 'info'">{{ previewStatusLabel(projectPreview) }}</el-tag>
          <el-tag v-else :type="data.project.status === 'active' ? 'success' : 'info'">{{ statusLabel(data.project.status) }}</el-tag>
          <el-tag v-if="baseSource === 'live'" data-testid="project-live-notice" type="success" effect="plain">真实后端</el-tag>
          <el-tag v-if="operatingSource === 'demo'" data-testid="project-demo-notice" type="warning" effect="plain">演示数据</el-tag>
        </el-space>
        <el-space v-if="(projectPreview?.status ?? data.project.status) === 'active'" class="project-primary-actions" wrap fill>
          <el-button data-testid="project-edit-open" plain :disabled="!projectPreview" @click="openProjectEdit">编辑演示项目</el-button>
          <el-button data-testid="project-close-open" plain type="danger" :disabled="!projectPreview" @click="openProjectClose">演示完结</el-button>
        </el-space>
      </div>
    </section>

    <el-card v-if="loading" data-testid="project-dashboard-loading" shadow="never">
      <el-skeleton :rows="8" animated />
    </el-card>
    <el-result v-else-if="loadError" data-testid="project-dashboard-error" icon="error" title="项目工作页读取失败" :sub-title="loadError">
      <template #extra><el-button data-testid="project-dashboard-retry" type="primary" @click="loadDashboard">重新读取</el-button></template>
    </el-result>

    <template v-else-if="data">
      <el-tabs
        v-model="activeTab"
        data-testid="project-workspace-tabs"
        class="project-workspace-tabs"
      >
        <el-tab-pane v-if="operating" name="home">
          <template #label><span data-testid="project-nav-home">项目首页</span></template>
          <ProjectOverviewPanel
            :operating="operating"
            :project-code="data.project.project_code"
            @stages-changed="updateStages"
          />
        </el-tab-pane>
        <el-tab-pane name="documents" lazy>
          <template #label><span data-testid="project-nav-documents">资料与设计</span></template>
          <el-space class="project-panel-stack" direction="vertical" alignment="stretch" fill :size="20">
            <ProjectRecordsPanel :data="data" />
            <ProjectDocumentsPanel
              v-if="ProjectDocumentsPanel"
              :key="data.project.project_code"
              :project-code="data.project.project_code"
            />
          </el-space>
        </el-tab-pane>
        <el-tab-pane v-if="operating" name="commercial" lazy>
          <template #label><span data-testid="project-nav-commercial">报价与收款</span></template>
          <ProjectCommercialPanel
            :operating="operating"
            :project-code="data.project.project_code"
            :customer-company="{ id: data.company.id, name: data.company.name }"
          />
        </el-tab-pane>
        <el-tab-pane v-if="ProcurementWorkspace" name="procurement" lazy>
          <template #label><span data-testid="project-nav-procurement">采购</span></template>
          <ProcurementWorkspace :project-code="data.project.project_code" />
        </el-tab-pane>
        <el-tab-pane v-if="operating" name="workforce" lazy>
          <template #label><span data-testid="project-nav-workforce">施工与调试</span></template>
          <div class="field-workspace">
            <el-radio-group v-model="fieldView" data-testid="field-workspace-nav" class="field-workspace-nav">
              <el-radio-button data-testid="field-workspace-site" value="site">今日施工</el-radio-button>
              <el-radio-button data-testid="field-workspace-commissioning" value="commissioning">调试与变更</el-radio-button>
            </el-radio-group>
            <WorkforceCenter
              v-if="WorkforceCenter && fieldView === 'site'"
              :project-code="data.project.project_code"
            />
            <DeliveryWorkspace
              v-if="DeliveryWorkspace && fieldView === 'commissioning'"
              :project-code="data.project.project_code"
              scope="commissioning"
            />
          </div>
        </el-tab-pane>
        <el-tab-pane v-if="DeliveryWorkspace" name="delivery" lazy>
          <template #label><span data-testid="project-nav-delivery">验收与售后</span></template>
          <DeliveryWorkspace :project-code="data.project.project_code" scope="delivery" />
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-dialog v-model="editVisible" title="编辑项目 · 演示" :teleported="false" width="min(92vw, 520px)">
      <el-alert v-if="projectActionError" :title="projectActionError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveProjectEdit">
        <el-form-item label="项目名称" required><el-input data-testid="project-edit-name" v-model="editForm.name" /></el-form-item>
        <el-form-item label="项目说明"><el-input data-testid="project-edit-description" v-model="editForm.description" type="textarea" /></el-form-item>
        <el-text type="info">当前只保存为演示数据，不改动真实项目。</el-text>
        <div class="dialog-actions"><el-button data-testid="project-edit-save" type="primary" :loading="projectSaving" @click="saveProjectEdit">保存演示修改</el-button></div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="closeVisible" title="完结项目 · 演示" :teleported="false" width="min(92vw, 500px)">
      <el-alert v-if="projectActionError" :title="projectActionError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveProjectClose">
        <el-form-item label="完结类型" required>
          <el-radio-group v-model="closeForm.closure_type">
            <el-radio value="completed">已完成</el-radio>
            <el-radio value="cancelled">已取消</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="完结原因" required><el-input data-testid="project-close-reason" v-model="closeForm.reason" type="textarea" /></el-form-item>
        <el-text type="info">完结后演示页不再提供编辑操作，真实后端数据不受影响。</el-text>
        <div class="dialog-actions"><el-button data-testid="project-close-save" type="danger" :loading="projectSaving" @click="saveProjectClose">确认演示完结</el-button></div>
      </el-form>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.dialog-actions { margin-top: 16px; }
.field-workspace { display: grid; gap: 14px; min-width: 0; }
.field-workspace-nav { justify-self: start; }
.project-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
@media (max-width: 1180px) {
  .project-hero { grid-template-columns: auto minmax(0, 1fr); gap: 12px 18px; }
  .project-actions { grid-column: 1 / -1; justify-self: end; }
}
@media (max-width: 560px) {
  .field-workspace-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .field-workspace-nav :deep(.el-radio-button__inner) { width: 100%; padding-inline: 8px; }
  .project-actions { align-items: stretch; flex-direction: column; width: 100%; }
  .project-statuses { justify-content: flex-start; }
  .project-primary-actions,
  .project-primary-actions > :deep(.el-space__item) { width: 100%; }
  .project-primary-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
