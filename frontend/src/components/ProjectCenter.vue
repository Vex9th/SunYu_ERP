<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'

import { ApiError, requestJson } from '../api'
import type {
  CompanySummary,
  Project,
  ProjectFilter,
  ProjectPayload,
  ProjectSummary,
} from '../types'

const emit = defineEmits<{
  'session-expired': [message: string]
  'open-dashboard': [projectCode: string]
}>()

const projects = ref<ProjectSummary[]>([])
const companies = ref<CompanySummary[]>([])
const selectedStatus = ref<ProjectFilter>('active')
const loading = ref(true)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const projectBusy = ref(false)
const archiveBusy = ref(false)

const projectDialogVisible = ref(false)
const projectValidationError = ref<string | null>(null)
const projectForm = reactive({
  project_code: '',
  company_id: null as number | null,
  name: '',
  description: '',
})

const archiveDialogVisible = ref(false)
const archiveTarget = ref<ProjectSummary | null>(null)
const archiveReason = ref('')
let loadVersion = 0
let projectDialogVersion = 0
let projectMutationVersion = 0
let archiveDialogVersion = 0
let archiveMutationVersion = 0

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function handleSessionError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  emit('session-expired', error.message)
  return true
}

function optional(value: string): string | null {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

async function loadData(): Promise<void> {
  const version = ++loadVersion
  const status = selectedStatus.value
  let sessionErrorReported = false
  loading.value = true
  listError.value = null
  const observeFailure = (error: unknown): never => {
    const isSessionError = error instanceof ApiError && error.status === 401
    if (isSessionError && !sessionErrorReported) {
      handleSessionError(error)
      sessionErrorReported = true
    }
    throw error
  }
  const [projectResult, companyResult] = await Promise.allSettled([
    requestJson<ProjectSummary[]>(`/api/projects?status=${status}`).catch(observeFailure),
    requestJson<CompanySummary[]>('/api/companies').catch(observeFailure),
  ])
  if (version !== loadVersion) return
  if (projectResult.status === 'fulfilled' && companyResult.status === 'fulfilled') {
    projects.value = projectResult.value
    companies.value = companyResult.value
    listError.value = null
  } else if (!listError.value) {
    const failure = projectResult.status === 'rejected'
      ? projectResult.reason
      : companyResult.status === 'rejected'
        ? companyResult.reason
        : new Error('项目列表读取失败')
    listError.value = errorMessage(failure)
  }
  loading.value = false
}

function openProjectCreate(): void {
  projectDialogVersion += 1
  projectMutationVersion += 1
  projectBusy.value = false
  actionError.value = null
  projectValidationError.value = null
  projectForm.project_code = ''
  projectForm.company_id = null
  projectForm.name = ''
  projectForm.description = ''
  projectDialogVisible.value = true
}

function projectPayload(): ProjectPayload | null {
  const projectCode = projectForm.project_code.trim()
  const name = projectForm.name.trim()
  if (!projectCode || !name || projectForm.company_id === null) {
    projectValidationError.value = '请填写项目编号、项目名称并选择客户'
    return null
  }
  projectValidationError.value = null
  return {
    project_code: projectCode,
    company_id: projectForm.company_id,
    name,
    description: optional(projectForm.description),
  }
}

async function saveProject(): Promise<void> {
  if (projectBusy.value) return
  const payload = projectPayload()
  if (!payload) return
  const dialogVersion = projectDialogVersion
  const mutationVersion = ++projectMutationVersion
  projectBusy.value = true
  actionError.value = null
  try {
    await requestJson<Project>('/api/projects', { method: 'POST', body: payload })
    if (dialogVersion === projectDialogVersion) projectDialogVisible.value = false
    await loadData()
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === projectDialogVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === projectMutationVersion) projectBusy.value = false
  }
}

function beforeProjectClose(done: () => void): void {
  if (!projectBusy.value) done()
}

function openArchive(selected: ProjectSummary): void {
  archiveDialogVersion += 1
  archiveMutationVersion += 1
  archiveBusy.value = false
  archiveTarget.value = selected
  archiveReason.value = ''
  actionError.value = null
  archiveDialogVisible.value = true
}

async function archiveProject(): Promise<void> {
  if (archiveBusy.value || !archiveTarget.value) return
  const dialogVersion = archiveDialogVersion
  const mutationVersion = ++archiveMutationVersion
  const projectCode = archiveTarget.value.project_code
  archiveBusy.value = true
  actionError.value = null
  try {
    await requestJson<Project>(
      `/api/projects/${encodeURIComponent(projectCode)}/archive`,
      { method: 'POST', body: { reason: optional(archiveReason.value) } },
    )
    if (dialogVersion === archiveDialogVersion) archiveDialogVisible.value = false
    await loadData()
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === archiveDialogVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === archiveMutationVersion) archiveBusy.value = false
  }
}

function beforeArchiveClose(done: () => void): void {
  if (!archiveBusy.value) done()
}

function statusLabel(status: ProjectSummary['status']): string {
  return status === 'active' ? '在建' : '已归档'
}

watch(projectDialogVisible, (visible) => {
  if (visible) return
  projectDialogVersion += 1
  projectMutationVersion += 1
  projectBusy.value = false
})

watch(archiveDialogVisible, (visible) => {
  if (visible) return
  archiveDialogVersion += 1
  archiveMutationVersion += 1
  archiveBusy.value = false
  archiveTarget.value = null
})

onMounted(loadData)
</script>

<template>
  <el-space class="page-stack" direction="vertical" alignment="stretch" fill :size="20">
    <section class="page-heading">
      <div>
        <h1>项目中心</h1>
        <p>选择一个项目即可开始处理。</p>
      </div>
      <el-button data-testid="project-create-open" type="primary" size="large" @click="openProjectCreate">新建项目</el-button>
    </section>

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-row justify="space-between" align="middle">
          <el-text tag="strong" size="large">项目列表</el-text>
          <el-radio-group data-testid="project-filter" v-model="selectedStatus" :disabled="loading" @change="loadData">
            <el-radio-button value="active">在建</el-radio-button>
            <el-radio-button value="archived">已归档</el-radio-button>
            <el-radio-button value="all">全部</el-radio-button>
          </el-radio-group>
        </el-row>
      </template>

      <el-space data-testid="project-list-stack" class="project-list-stack" direction="vertical" alignment="stretch" fill :size="16">
        <el-alert v-if="actionError" data-testid="project-action-error" :title="actionError" type="error" show-icon :closable="false" />
        <el-skeleton v-if="loading" data-testid="projects-loading" :rows="6" animated />
        <el-result v-else-if="listError" data-testid="projects-error" icon="error" title="项目列表读取失败" :sub-title="listError">
          <template #extra><el-button data-testid="projects-retry" type="primary" @click="loadData">重新读取</el-button></template>
        </el-result>
        <el-empty v-else-if="projects.length === 0" data-testid="projects-empty" :description="selectedStatus === 'active' ? '暂无在建项目' : '当前筛选下暂无项目'" />
        <div v-else class="project-list-content">
          <el-table class="project-list-table" :data="projects" row-key="id">
            <el-table-column prop="project_code" label="项目编号" width="132" show-overflow-tooltip />
            <el-table-column prop="name" label="项目名称" min-width="220">
              <template #default="scope"><el-button :data-testid="`project-dashboard-${scope.row.project_code}`" class="project-name-link" link type="primary" @click="emit('open-dashboard', scope.row.project_code)">{{ scope.row.name }}</el-button></template>
            </el-table-column>
            <el-table-column prop="company_name" label="客户公司" min-width="260">
              <template #default="scope"><span :data-testid="`project-company-cell-${scope.row.id}`" class="project-company-cell">{{ scope.row.company_name }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'">{{ statusLabel(scope.row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="scope">
                <el-button v-if="scope.row.status === 'active'" :data-testid="`project-archive-${scope.row.project_code}`" link type="danger" @click="openArchive(scope.row)">归档</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="project-mobile-list">
            <el-card
              v-for="project in projects"
              :key="project.id"
              :data-testid="`project-mobile-card-${project.id}`"
              class="project-mobile-card"
              shadow="never"
            >
              <div class="project-mobile-heading">
                <div>
                  <strong>{{ project.name }}</strong>
                  <span>{{ project.project_code }}</span>
                </div>
                <el-tag :type="project.status === 'active' ? 'success' : 'info'">{{ statusLabel(project.status) }}</el-tag>
              </div>
              <span class="project-mobile-company">客户：{{ project.company_name }}</span>
              <div class="project-mobile-actions">
                <el-button :data-testid="`project-mobile-open-${project.project_code}`" type="primary" @click="emit('open-dashboard', project.project_code)">进入项目</el-button>
                <el-button v-if="project.status === 'active'" type="danger" plain @click="openArchive(project)">归档</el-button>
              </div>
            </el-card>
          </div>
        </div>
      </el-space>
    </el-card>

    <el-dialog
      v-model="projectDialogVisible"
      data-testid="project-form-dialog"
      :teleported="false"
      title="新建项目"
      width="min(92vw, 560px)"
      :before-close="beforeProjectClose"
      :close-on-click-modal="!projectBusy"
      :close-on-press-escape="!projectBusy"
      :show-close="!projectBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert v-if="projectValidationError" :title="projectValidationError" type="error" show-icon :closable="false" />
      <el-alert v-if="companies.length === 0" title="请先在「公司联系人」中录入公司" type="warning" show-icon :closable="false" />
      <el-form label-position="top" @submit.prevent="saveProject">
        <el-form-item label="项目编号" required><el-input data-testid="project-code" v-model="projectForm.project_code" :disabled="projectBusy" /></el-form-item>
        <el-form-item label="客户" required>
          <el-select data-testid="project-company" v-model="projectForm.company_id" filterable :disabled="projectBusy" placeholder="选择公司">
            <el-option v-for="item in companies" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称" required><el-input data-testid="project-name" v-model="projectForm.name" :disabled="projectBusy" /></el-form-item>
        <el-form-item label="项目说明"><el-input data-testid="project-description" v-model="projectForm.description" type="textarea" :disabled="projectBusy" /></el-form-item>
        <el-button data-testid="project-save" type="primary" native-type="submit" :loading="projectBusy" :disabled="projectBusy || companies.length === 0">创建项目</el-button>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="archiveDialogVisible"
      data-testid="archive-dialog"
      :teleported="false"
      title="归档项目"
      width="min(92vw, 500px)"
      :before-close="beforeArchiveClose"
      :close-on-click-modal="!archiveBusy"
      :close-on-press-escape="!archiveBusy"
      :show-close="!archiveBusy"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert :title="`归档后项目仍可查看，项目编号为 ${archiveTarget?.project_code ?? ''}。`" type="warning" show-icon :closable="false" />
      <el-form label-position="top" @submit.prevent="archiveProject">
        <el-form-item label="归档原因（可选）"><el-input data-testid="archive-reason" v-model="archiveReason" type="textarea" :disabled="archiveBusy" /></el-form-item>
        <el-button data-testid="archive-confirm" type="danger" native-type="submit" :loading="archiveBusy" :disabled="archiveBusy">确认归档</el-button>
      </el-form>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.project-list-stack,
.project-list-stack > :deep(.el-space__item),
.project-list-content,
.project-list-table { width: 100%; min-width: 0; }
.project-mobile-list { display: none; }
.project-company-cell { display: block; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
.project-name-link { height: auto; white-space: normal; text-align: left; line-height: 1.45; }
@media (max-width: 640px) {
  .project-list-table { display: none; }
  .project-mobile-list { display: grid; gap: 10px; }
  .project-mobile-card :deep(.el-card__body) { display: grid; gap: 12px; padding: 14px; }
  .project-mobile-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .project-mobile-heading > div { display: grid; min-width: 0; gap: 4px; }
  .project-mobile-heading strong,
  .project-mobile-company { overflow-wrap: anywhere; }
  .project-mobile-heading span,
  .project-mobile-company { color: var(--sunyu-muted); }
  .project-mobile-actions { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .project-mobile-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
