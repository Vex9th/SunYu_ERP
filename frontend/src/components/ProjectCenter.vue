<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'

import { ApiError, createRetriablePostSender, requestJson } from '../api'
import type { ProjectDetail } from '../domain/contracts'
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
const companyLoading = ref(true)
const listError = ref<string | null>(null)
const companyLoadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const projectBusy = ref(false)
const archiveBusy = ref(false)
const searchQuery = ref('')
const filteredProjects = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  if (!query) return projects.value
  return projects.value.filter((project) => [
    project.project_code,
    project.name,
    project.company_name,
  ].some((value) => value.toLocaleLowerCase('zh-CN').includes(query)))
})

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
const archiveExpectedRevision = ref<number | null>(null)
interface ArchiveCloseRequest {
  readonly path: string
  readonly body: {
    readonly closure_type: 'cancelled'
    readonly reason: string
    readonly expected_revision: number
  }
}
const unresolvedArchiveRequest = ref<ArchiveCloseRequest | null>(null)
const projectClosePosts = createRetriablePostSender()
let projectLoadVersion = 0
let companyLoadVersion = 0
let sessionErrorReported = false
let projectDialogVersion = 0
let projectMutationVersion = 0
let archiveDialogVersion = 0
let archiveMutationVersion = 0
let projectDialogTrigger: HTMLElement | null = null
let archiveDialogTrigger: HTMLElement | null = null
let projectFormBaseline = ''

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function handleSessionError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  if (!sessionErrorReported) {
    sessionErrorReported = true
    emit('session-expired', error.message)
  }
  return true
}

function isDefinitiveBusinessRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function isIndeterminateCloseFailure(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 0 || [408, 425, 429].includes(error.status) || error.status >= 500)
}

function optional(value: string): string | null {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

async function loadProjects(): Promise<void> {
  const version = ++projectLoadVersion
  const status = selectedStatus.value
  loading.value = true
  listError.value = null
  try {
    const value = await requestJson<ProjectSummary[]>(`/api/projects?status=${status}`)
    if (version !== projectLoadVersion) return
    projects.value = value
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== projectLoadVersion) return
    if (!isSessionError) listError.value = errorMessage(error)
  } finally {
    if (version === projectLoadVersion) loading.value = false
  }
}

async function loadCompanies(): Promise<void> {
  const version = ++companyLoadVersion
  companyLoading.value = true
  companyLoadError.value = null
  try {
    const value = await requestJson<CompanySummary[]>('/api/companies')
    if (version !== companyLoadVersion) return
    companies.value = value
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (version !== companyLoadVersion) return
    if (!isSessionError) {
      companies.value = []
      companyLoadError.value = errorMessage(error)
    }
  } finally {
    if (version === companyLoadVersion) companyLoading.value = false
  }
}

async function loadData(): Promise<void> {
  await Promise.allSettled([loadProjects(), loadCompanies()])
}

function eventTrigger(event: MouseEvent): HTMLElement | null {
  return event.currentTarget instanceof HTMLElement ? event.currentTarget : null
}

function restoreFocus(target: HTMLElement | null): void {
  void nextTick(() => {
    if (target?.isConnected) target.focus()
  })
}

function restoreProjectDialogFocus(): void {
  const target = projectDialogTrigger
  projectDialogTrigger = null
  restoreFocus(target)
}

function restoreArchiveDialogFocus(): void {
  const target = archiveDialogTrigger
  archiveDialogTrigger = null
  restoreFocus(target)
}

function openProjectCreate(event: MouseEvent): void {
  projectDialogTrigger = eventTrigger(event)
  projectDialogVersion += 1
  projectMutationVersion += 1
  projectBusy.value = false
  actionError.value = null
  projectValidationError.value = null
  projectForm.project_code = ''
  projectForm.company_id = null
  projectForm.name = ''
  projectForm.description = ''
  projectFormBaseline = projectFormFingerprint()
  projectDialogVisible.value = true
}

function projectFormFingerprint(): string {
  return JSON.stringify(projectForm)
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
    const createdProject = await requestJson<Project>('/api/projects', { method: 'POST', body: payload })
    if (dialogVersion === projectDialogVersion) projectDialogVisible.value = false
    void loadData()
    if (dialogVersion === projectDialogVersion) emit('open-dashboard', createdProject.project_code)
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
  if (projectBusy.value) return
  if (projectFormFingerprint() === projectFormBaseline) {
    done()
    return
  }
  void ElMessageBox.confirm(
    '关闭后未保存的项目信息会丢失，确定关闭吗？',
    '放弃未保存内容',
    { type: 'warning', confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' },
  ).then(() => done()).catch(() => undefined)
}

function closeProjectDialog(): void {
  beforeProjectClose(() => { projectDialogVisible.value = false })
}

function openArchive(selected: ProjectSummary, event: MouseEvent): void {
  archiveDialogTrigger = eventTrigger(event)
  archiveDialogVersion += 1
  archiveMutationVersion += 1
  archiveBusy.value = false
  archiveTarget.value = selected
  archiveReason.value = ''
  archiveExpectedRevision.value = null
  unresolvedArchiveRequest.value = null
  actionError.value = null
  archiveDialogVisible.value = true
}

async function reconcileArchiveState(
  projectPath: string,
  dialogVersion: number,
): Promise<'active' | 'archived' | 'failed' | 'stale'> {
  try {
    const detail = await requestJson<ProjectDetail>(projectPath)
    if (dialogVersion !== archiveDialogVersion) return 'stale'
    if (detail.status === 'archived') {
      unresolvedArchiveRequest.value = null
      archiveDialogVisible.value = false
      await loadData()
      return 'archived'
    }
    archiveExpectedRevision.value = detail.revision
    return 'active'
  } catch (error) {
    handleSessionError(error)
    if (dialogVersion !== archiveDialogVersion) return 'stale'
    return 'failed'
  }
}

async function handleArchiveCloseFailure(
  error: unknown,
  request: ArchiveCloseRequest,
  dialogVersion: number,
): Promise<void> {
  const isSessionError = handleSessionError(error)
  if (dialogVersion !== archiveDialogVersion) return
  if (isDefinitiveBusinessRejection(error)) unresolvedArchiveRequest.value = null
  if (isSessionError) return
  if (error instanceof ApiError && error.errorCode === 'REVISION_CONFLICT') {
    const state = await reconcileArchiveState(
      request.path.slice(0, -'/close'.length),
      dialogVersion,
    )
    if (state === 'active') actionError.value = '项目资料已更新，请核对后再次确认取消'
    if (state === 'failed') actionError.value = '项目资料已变化，但最新状态读取失败，请稍后重试'
    return
  }
  if (isIndeterminateCloseFailure(error)) {
    const state = await reconcileArchiveState(
      request.path.slice(0, -'/close'.length),
      dialogVersion,
    )
    if (state === 'active') {
      unresolvedArchiveRequest.value = request
      actionError.value = '项目仍在建，但原取消请求结果仍未知，请原样重试或重新核对状态'
    } else if (state === 'failed') {
      unresolvedArchiveRequest.value = request
      actionError.value = '取消请求结果未知且状态核对失败，请原样重试或重新核对状态'
    }
    return
  }
  actionError.value = errorMessage(error)
}

async function sendArchiveClose(
  request: ArchiveCloseRequest,
  dialogVersion: number,
): Promise<void> {
  try {
    await projectClosePosts.send<ProjectDetail>(request.path, request.body)
    if (dialogVersion === archiveDialogVersion) {
      unresolvedArchiveRequest.value = null
      archiveDialogVisible.value = false
    }
    await loadData()
  } catch (error) {
    await handleArchiveCloseFailure(error, request, dialogVersion)
  }
}

async function archiveProject(): Promise<void> {
  if (archiveBusy.value || unresolvedArchiveRequest.value || !archiveTarget.value) return
  const reason = archiveReason.value.trim()
  if (!reason) {
    actionError.value = '请填写取消原因'
    return
  }
  const dialogVersion = archiveDialogVersion
  const mutationVersion = ++archiveMutationVersion
  const projectCode = archiveTarget.value.project_code
  const projectPath = `/api/projects/${encodeURIComponent(projectCode)}`
  const closePath = `${projectPath}/close`
  archiveBusy.value = true
  actionError.value = null
  try {
    if (archiveExpectedRevision.value === null) {
      const detail = await requestJson<ProjectDetail>(projectPath)
      if (dialogVersion !== archiveDialogVersion) return
      archiveExpectedRevision.value = detail.revision
    }
    const expectedRevision = archiveExpectedRevision.value
    if (expectedRevision === null) return
    await sendArchiveClose({
      path: closePath,
      body: {
        closure_type: 'cancelled',
        reason,
        expected_revision: expectedRevision,
      },
    }, dialogVersion)
  } catch (error) {
    const isSessionError = handleSessionError(error)
    if (!isSessionError && dialogVersion === archiveDialogVersion) {
      actionError.value = errorMessage(error)
    }
  } finally {
    if (mutationVersion === archiveMutationVersion) archiveBusy.value = false
  }
}

async function retryOriginalArchiveRequest(): Promise<void> {
  const request = unresolvedArchiveRequest.value
  if (!request || archiveBusy.value) return
  const dialogVersion = archiveDialogVersion
  const mutationVersion = ++archiveMutationVersion
  archiveBusy.value = true
  actionError.value = null
  try {
    await sendArchiveClose(request, dialogVersion)
  } finally {
    if (mutationVersion === archiveMutationVersion) archiveBusy.value = false
  }
}

async function recheckArchiveState(): Promise<void> {
  const request = unresolvedArchiveRequest.value
  if (!request || archiveBusy.value) return
  const dialogVersion = archiveDialogVersion
  const mutationVersion = ++archiveMutationVersion
  archiveBusy.value = true
  actionError.value = null
  try {
    const state = await reconcileArchiveState(
      request.path.slice(0, -'/close'.length),
      dialogVersion,
    )
    if (state === 'active') {
      actionError.value = '项目仍在建，但原取消请求结果仍未知，请原样重试或继续核对状态'
    }
    if (state === 'failed') {
      actionError.value = '状态核对仍然失败，请原样重试或稍后再次核对'
    }
  } finally {
    if (mutationVersion === archiveMutationVersion) archiveBusy.value = false
  }
}

function beforeArchiveClose(done: () => void): void {
  if (!archiveBusy.value && !unresolvedArchiveRequest.value) done()
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
  archiveExpectedRevision.value = null
  unresolvedArchiveRequest.value = null
})

onMounted(() => { void loadData() })
</script>

<template>
  <el-space class="page-stack" direction="vertical" alignment="stretch" fill :size="20">
    <section class="page-heading">
      <div>
        <h1>项目中心</h1>
        <p>选择一个项目即可开始处理。</p>
      </div>
      <el-button data-testid="project-create-open" type="primary" size="large" :disabled="companyLoading || companyLoadError !== null" @click="openProjectCreate($event)">新建项目</el-button>
    </section>

    <el-card class="data-card" shadow="never">
      <template #header>
        <el-row class="project-list-toolbar" justify="space-between" align="middle">
          <el-text tag="strong" size="large">项目列表</el-text>
          <el-space wrap>
            <el-input data-testid="project-search" v-model="searchQuery" clearable placeholder="搜索编号、名称或客户" aria-label="搜索项目" />
            <el-radio-group data-testid="project-filter" v-model="selectedStatus" :disabled="loading" @change="loadProjects">
              <el-radio-button value="active">在建</el-radio-button>
              <el-radio-button value="archived">已归档</el-radio-button>
              <el-radio-button value="all">全部</el-radio-button>
            </el-radio-group>
          </el-space>
        </el-row>
      </template>

      <el-space data-testid="project-list-stack" class="project-list-stack" direction="vertical" alignment="stretch" fill :size="16">
        <el-alert v-if="actionError" data-testid="project-action-error" :title="actionError" type="error" show-icon :closable="false" />
        <el-alert
          v-if="companyLoadError"
          data-testid="project-company-warning"
          :title="`项目列表已读取，但${companyLoadError}；暂时不能新建项目。`"
          type="warning"
          show-icon
          :closable="false"
        >
          <template #default><el-button data-testid="project-companies-retry" link type="primary" @click="loadCompanies">重试公司资料</el-button></template>
        </el-alert>
        <el-skeleton v-if="loading" data-testid="projects-loading" :rows="6" animated />
        <el-result v-else-if="listError" data-testid="projects-error" icon="error" title="项目列表读取失败" :sub-title="listError">
          <template #extra><el-button data-testid="projects-retry" type="primary" @click="loadProjects">重新读取</el-button></template>
        </el-result>
        <el-empty v-else-if="filteredProjects.length === 0" data-testid="projects-empty" :description="projects.length === 0 ? (selectedStatus === 'active' ? '暂无在建项目' : '当前筛选下暂无项目') : '没有匹配的项目'" />
        <div v-else class="project-list-content">
          <el-table class="project-list-table" :data="filteredProjects" row-key="id">
            <el-table-column prop="project_code" label="项目编号" width="132" show-overflow-tooltip />
            <el-table-column prop="name" label="项目名称" min-width="220">
              <template #default="scope"><strong class="project-name">{{ scope.row.name }}</strong></template>
            </el-table-column>
            <el-table-column prop="company_name" label="客户公司" min-width="260">
              <template #default="scope"><span :data-testid="`project-company-cell-${scope.row.id}`" class="project-company-cell">{{ scope.row.company_name }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'">{{ statusLabel(scope.row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="操作" width="160">
              <template #default="scope">
                <div :data-testid="`project-row-actions-${scope.row.project_code}`" class="project-row-actions">
                  <el-button :data-testid="`project-dashboard-${scope.row.project_code}`" link type="primary" @click="emit('open-dashboard', scope.row.project_code)">进入项目</el-button>
                  <el-button v-if="scope.row.status === 'active'" :data-testid="`project-archive-${scope.row.project_code}`" link type="danger" @click="openArchive(scope.row, $event)">取消项目</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div class="project-mobile-list">
            <el-card
              v-for="project in filteredProjects"
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
                <el-button v-if="project.status === 'active'" type="danger" plain @click="openArchive(project, $event)">取消项目</el-button>
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
      @close-auto-focus="restoreProjectDialogFocus"
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
        <div class="dialog-actions">
          <el-button data-testid="project-cancel" :disabled="projectBusy" @click="closeProjectDialog">取消</el-button>
          <el-button data-testid="project-save" type="primary" native-type="submit" :loading="projectBusy" :disabled="projectBusy || companies.length === 0">创建项目</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="archiveDialogVisible"
      data-testid="archive-dialog"
      :teleported="false"
      title="取消项目并归档"
      width="min(92vw, 500px)"
      :before-close="beforeArchiveClose"
      :close-on-click-modal="!archiveBusy && !unresolvedArchiveRequest"
      :close-on-press-escape="!archiveBusy && !unresolvedArchiveRequest"
      :show-close="!archiveBusy && !unresolvedArchiveRequest"
      @close-auto-focus="restoreArchiveDialogFocus"
    >
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
      <el-alert :title="`取消后项目将归档并变成只读，项目编号为 ${archiveTarget?.project_code ?? ''}。`" type="warning" show-icon :closable="false" />
      <el-form label-position="top" @submit.prevent="archiveProject">
        <el-form-item label="取消原因" required><el-input data-testid="archive-reason" v-model="archiveReason" type="textarea" :disabled="archiveBusy || unresolvedArchiveRequest !== null" /></el-form-item>
        <el-space v-if="unresolvedArchiveRequest" wrap>
          <el-button data-testid="archive-original-retry" type="danger" :loading="archiveBusy" :disabled="archiveBusy" @click="retryOriginalArchiveRequest">原样重试</el-button>
          <el-button data-testid="archive-reconcile-retry" :disabled="archiveBusy" @click="recheckArchiveState">重新核对状态</el-button>
        </el-space>
        <el-button v-else data-testid="archive-confirm" type="danger" native-type="submit" :loading="archiveBusy" :disabled="archiveBusy">确认取消并归档</el-button>
      </el-form>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
.project-list-stack,
.project-list-stack > :deep(.el-space__item),
.project-list-content,
.project-list-table { width: 100%; min-width: 0; }
.project-mobile-list { display: none; }
.project-company-cell { display: block; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
.project-name { color: var(--el-text-color-primary); }
.project-row-actions { display: flex; align-items: center; gap: 8px; }
.project-list-toolbar { gap: 12px; }
.project-list-toolbar :deep(.el-input) { width: min(280px, 100%); }
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
