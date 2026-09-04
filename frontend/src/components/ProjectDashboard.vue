<script setup lang="ts">
import { computed, defineAsyncComponent, inject, onBeforeUnmount, reactive, ref, toRaw, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { routeLocationKey, routerKey } from 'vue-router'

import { ApiError, requestJson } from '../api'
import type {
  ClosureType,
  CompanyRecord,
  ProjectDashboard as ProjectDashboardData,
  ProjectDetail,
  ProjectOperatingSnapshot,
} from '../domain/contracts'
import {
  createHttpProjectOperatingRepository,
  type ProjectCloseInput,
  type ProjectOperatingRepository,
  type ProjectRestoreInput,
} from '../repositories/project-operating.live'
import ProjectCommercialPanel from './project/ProjectCommercialPanel.vue'
import ProjectOverviewPanel from './project/ProjectOverviewPanel.vue'

const ProjectDocumentsPanel = defineAsyncComponent(() => import('./project/ProjectDocumentsPanel.vue'))
const ProcurementWorkspace = defineAsyncComponent(() => import('./procurement/ProcurementWorkspace.vue'))
const WorkforceCenter = defineAsyncComponent(() => import('./workforce/WorkforceCenter.vue'))
const DeliveryWorkspace = defineAsyncComponent(() => import('./delivery/DeliveryWorkspace.vue'))

const props = withDefaults(defineProps<{
  projectCode: string
  repository?: ProjectOperatingRepository
}>(), {
  repository: () => createHttpProjectOperatingRepository(),
})

const emit = defineEmits<{
  back: []
  'session-expired': [message: string]
}>()

const data = ref<ProjectDashboardData | null>(null)
const operating = ref<ProjectOperatingSnapshot | null>(null)
const projectPreview = ref<ProjectDetail | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const editVisible = ref(false)
const closeVisible = ref(false)
const restoreVisible = ref(false)
const projectActionError = ref<string | null>(null)
const refreshWarning = ref<string | null>(null)
const projectSaving = ref(false)
const companyLoading = ref(false)
const companyOptions = ref<Array<Pick<CompanyRecord, 'id' | 'name'>>>([])
const editForm = reactive({ company_id: null as number | null, name: '', description: '' })
const closeForm = reactive({ closure_type: null as ClosureType | null, reason: '' })
const restoreForm = reactive({ reason: '' })
let editFormBaseline = ''
let closeFormBaseline = ''
let restoreFormBaseline = ''
const unresolvedProjectClose = ref<Readonly<ProjectCloseInput> | null>(null)
const unresolvedProjectRestore = ref<Readonly<ProjectRestoreInput> | null>(null)
type ProjectWorkspaceTab =
  | 'home'
  | 'documents'
  | 'commercial'
  | 'procurement'
  | 'workforce'
  | 'delivery'
const route = inject(routeLocationKey, null)
const router = inject(routerKey, null)

function routedProjectCode(): string | null {
  const projectCode = route?.params.projectCode
  return typeof projectCode === 'string' ? projectCode : null
}

const routeNameToTab: Record<string, ProjectWorkspaceTab> = {
  project: 'home',
  'project-documents': 'documents',
  'project-document': 'documents',
  'project-commercial': 'commercial',
  'project-procurement': 'procurement',
  'project-workforce': 'workforce',
  'project-delivery': 'delivery',
}
const tabToRouteName: Record<ProjectWorkspaceTab, string> = {
  home: 'project',
  documents: 'project-documents',
  commercial: 'project-commercial',
  procurement: 'project-procurement',
  workforce: 'project-workforce',
  delivery: 'project-delivery',
}

function routedTab(): ProjectWorkspaceTab {
  if (routedProjectCode() !== props.projectCode || typeof route?.name !== 'string') return 'home'
  return routeNameToTab[route.name] ?? 'home'
}

const initialTab = (): ProjectWorkspaceTab => routedTab()
const activeTab = ref<ProjectWorkspaceTab>(initialTab())
const fieldView = ref<'site' | 'commissioning'>('site')
let loadVersion = 0
let projectContextVersion = 0
let repository = toRaw(props.repository)
let activeProjectMutationToken: symbol | null = null

interface ProjectMutationContext {
  token: symbol
  contextVersion: number
  projectCode: string
  repository: ProjectOperatingRepository
}

function startProjectMutation(): ProjectMutationContext {
  const token = Symbol('project-mutation')
  activeProjectMutationToken = token
  projectSaving.value = true
  return {
    token,
    contextVersion: projectContextVersion,
    projectCode: props.projectCode,
    repository,
  }
}

function ownsProjectMutation(context: ProjectMutationContext): boolean {
  return activeProjectMutationToken === context.token
    && context.contextVersion === projectContextVersion
    && context.projectCode === props.projectCode
    && context.repository === repository
}

function finishProjectMutation(context: ProjectMutationContext): void {
  if (activeProjectMutationToken !== context.token) return
  activeProjectMutationToken = null
  if (
    context.contextVersion === projectContextVersion
    && context.projectCode === props.projectCode
    && context.repository === repository
  ) projectSaving.value = false
}

const readonly = computed(() => (projectPreview.value?.status ?? data.value?.project.status) === 'archived')
const completionCheck = computed(() => data.value?.completion_check ?? null)
const closeSubmissionDisabled = computed(() => (
  projectSaving.value
  || unresolvedProjectClose.value !== null
  || closeForm.closure_type === null
  || closeForm.reason.trim().length === 0
  || (
    closeForm.closure_type === 'completed'
    && completionCheck.value?.ready !== true
  )
))
const restoreSubmissionDisabled = computed(() => (
  projectSaving.value
  || unresolvedProjectRestore.value !== null
  || restoreForm.reason.trim().length === 0
))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function isDefinitiveBusinessRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function isIndeterminateCloseFailure(error: unknown): boolean {
  return !(error instanceof ApiError)
    || error.status === 0
    || [408, 425, 429].includes(error.status)
    || error.status >= 500
}

async function canonicalizeProjectRoute(
  requestedProjectCode: string,
  canonicalProjectCode: string,
): Promise<void> {
  if (!router || !route || routedProjectCode() !== requestedProjectCode) return
  const routeName = route.name
  if (typeof routeName !== 'string' || !(routeName in routeNameToTab)) return
  if (requestedProjectCode === canonicalProjectCode) return
  await router.replace({
    name: routeName,
    params: { ...route.params, projectCode: canonicalProjectCode },
    query: route.query,
    hash: route.hash,
  })
}

async function loadDashboard(preserveCurrent = false): Promise<boolean> {
  const version = ++loadVersion
  const contextVersion = projectContextVersion
  const requestedProjectCode = props.projectCode
  const requestedRepository = repository
  if (!preserveCurrent) {
    loading.value = true
    loadError.value = null
    data.value = null
    operating.value = null
    projectPreview.value = null
  }
  refreshWarning.value = null
  try {
    const result = await requestedRepository.getProjectDashboard(requestedProjectCode)
    if (version === loadVersion && contextVersion === projectContextVersion && requestedRepository === repository) {
      await canonicalizeProjectRoute(requestedProjectCode, result.project.project_code)
    }
    if (version === loadVersion && contextVersion === projectContextVersion && requestedRepository === repository) {
      data.value = result
      operating.value = {
        stages: result.stages,
        commercial: result.commercial,
        costs: result.costs,
        profit: result.profit,
        receivables: result.receivables,
        todos: result.todos,
      }
      projectPreview.value = result.project
    }
    return version === loadVersion && contextVersion === projectContextVersion && requestedRepository === repository
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      emit('session-expired', error.message)
    }
    if (version !== loadVersion || contextVersion !== projectContextVersion || requestedRepository !== repository) return false
    if (!(error instanceof ApiError) || error.status !== 401) {
      if (preserveCurrent) {
        refreshWarning.value = `项目数据刷新失败：${errorMessage(error)}`
      } else {
        loadError.value = errorMessage(error)
      }
    }
    return false
  } finally {
    if (!preserveCurrent && version === loadVersion && contextVersion === projectContextVersion && requestedRepository === repository) loading.value = false
  }
}

function refreshDashboard(): void {
  void loadDashboard(true)
}

function statusLabel(status: ProjectDashboardData['project']['status']): string {
  return status === 'active' ? '在建' : '已归档'
}

function previewStatusLabel(project: ProjectDetail): string {
  if (project.status === 'active') return '在建'
  if (project.closure_type === 'completed') return '已完结'
  if (project.closure_type === 'cancelled') return '已取消'
  return '已归档'
}

async function loadCompanyOptions(): Promise<void> {
  if (!projectPreview.value || companyLoading.value) return
  companyLoading.value = true
  try {
    const companies = await requestJson<Array<Pick<CompanyRecord, 'id' | 'name'>>>('/api/companies')
    companyOptions.value = companies
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      emit('session-expired', error.message)
    } else {
      projectActionError.value = `客户列表读取失败：${errorMessage(error)}`
    }
  } finally {
    companyLoading.value = false
  }
}

function openProjectEdit(): void {
  if (!projectPreview.value || readonly.value || projectSaving.value) return
  editForm.company_id = projectPreview.value.company_id
  editForm.name = projectPreview.value.name
  editForm.description = projectPreview.value.description ?? ''
  editFormBaseline = JSON.stringify(editForm)
  projectActionError.value = null
  editVisible.value = true
  void loadCompanyOptions()
}

async function saveProjectEdit(): Promise<void> {
  if (!projectPreview.value || readonly.value || projectSaving.value) return
  const name = editForm.name.trim()
  if (!name || editForm.company_id === null) {
    projectActionError.value = '请输入项目名称并选择客户'
    return
  }
  const context = startProjectMutation()
  const input = {
    company_id: editForm.company_id,
    name,
    description: editForm.description.trim() || null,
    expected_revision: projectPreview.value.revision,
  }
  projectActionError.value = null
  try {
    const result = await context.repository.updateProject(context.projectCode, input)
    if (!ownsProjectMutation(context)) return
    loadVersion += 1
    projectPreview.value = result
    if (data.value) {
      data.value = {
        ...data.value,
        project: result,
        company: result.company_id === data.value.company.id
          ? data.value.company
          : { ...data.value.company, id: result.company_id, name: result.company_name },
      }
    }
    editVisible.value = false
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      emit('session-expired', error.message)
    } else if (ownsProjectMutation(context)) {
      projectActionError.value = errorMessage(error)
    }
  } finally {
    finishProjectMutation(context)
  }
}

function openProjectClose(): void {
  if (readonly.value || projectSaving.value) return
  closeForm.closure_type = null
  closeForm.reason = ''
  closeFormBaseline = JSON.stringify(closeForm)
  unresolvedProjectClose.value = null
  projectActionError.value = null
  closeVisible.value = true
}

function openProjectRestore(): void {
  if (!projectPreview.value || !readonly.value || projectSaving.value) return
  restoreForm.reason = ''
  restoreFormBaseline = JSON.stringify(restoreForm)
  unresolvedProjectRestore.value = null
  projectActionError.value = null
  restoreVisible.value = true
}

async function reconcileProjectRestore(
  input: Readonly<ProjectRestoreInput>,
  context: ProjectMutationContext,
  keepUnresolved: boolean,
  message: string,
): Promise<void> {
  const refreshed = await loadDashboard(true)
  if (!ownsProjectMutation(context) || !restoreVisible.value) return
  if (!refreshed) {
    unresolvedProjectRestore.value = keepUnresolved ? input : null
    projectActionError.value = keepUnresolved
      ? '恢复请求结果未知且状态核对失败，请原样重试'
      : '项目状态已变化，但最新状态读取失败，请稍后重试'
    return
  }
  if (projectPreview.value?.status === 'active') {
    unresolvedProjectRestore.value = null
    projectActionError.value = null
    restoreVisible.value = false
    return
  }
  unresolvedProjectRestore.value = keepUnresolved ? input : null
  projectActionError.value = message
}

async function sendProjectRestore(
  input: Readonly<ProjectRestoreInput>,
  context: ProjectMutationContext,
): Promise<void> {
  try {
    const result = await context.repository.restoreProject(context.projectCode, input)
    if (!ownsProjectMutation(context)) return
    loadVersion += 1
    unresolvedProjectRestore.value = null
    projectPreview.value = result
    if (data.value) data.value = { ...data.value, project: result }
    restoreVisible.value = false
  } catch (error) {
    const isSessionError = error instanceof ApiError && error.status === 401
    if (isSessionError) emit('session-expired', error.message)
    if (!ownsProjectMutation(context)) return
    if (isDefinitiveBusinessRejection(error)) unresolvedProjectRestore.value = null
    if (isSessionError) return
    if (
      error instanceof ApiError
      && ['REVISION_CONFLICT', 'PROJECT_ALREADY_ACTIVE'].includes(error.errorCode ?? '')
    ) {
      await reconcileProjectRestore(
        input,
        context,
        false,
        '项目资料已变化，请核对最新状态后再次恢复',
      )
      return
    }
    if (isIndeterminateCloseFailure(error)) {
      await reconcileProjectRestore(
        input,
        context,
        true,
        '项目仍是归档状态，但原恢复请求结果未知，请原样重试',
      )
      return
    }
    projectActionError.value = errorMessage(error)
  }
}

async function saveProjectRestore(): Promise<void> {
  if (
    !projectPreview.value
    || !readonly.value
    || projectSaving.value
    || unresolvedProjectRestore.value
  ) return
  const reason = restoreForm.reason.trim()
  if (!reason) {
    projectActionError.value = '请填写恢复原因'
    return
  }
  const input: Readonly<ProjectRestoreInput> = {
    reason,
    expected_revision: projectPreview.value.revision,
  }
  const context = startProjectMutation()
  projectActionError.value = null
  try {
    await sendProjectRestore(input, context)
  } finally {
    finishProjectMutation(context)
  }
}

async function retryOriginalProjectRestore(): Promise<void> {
  const input = unresolvedProjectRestore.value
  if (!input || projectSaving.value) return
  const context = startProjectMutation()
  projectActionError.value = null
  try {
    await sendProjectRestore(input, context)
  } finally {
    finishProjectMutation(context)
  }
}

async function reconcileProjectClose(
  input: Readonly<ProjectCloseInput>,
  context: ProjectMutationContext,
  keepUnresolved: boolean,
  activeMessage: string,
): Promise<void> {
  const refreshed = await loadDashboard(true)
  if (!ownsProjectMutation(context) || !closeVisible.value) return
  if (!refreshed) {
    if (keepUnresolved) {
      unresolvedProjectClose.value = input
      projectActionError.value = '完结请求结果未知且状态核对失败，请原样重试或重新核对状态'
    } else {
      projectActionError.value = '项目状态已变化，但最新仪表台读取失败，请稍后重试'
    }
    return
  }
  if (projectPreview.value?.status === 'archived') {
    unresolvedProjectClose.value = null
    projectActionError.value = null
    closeVisible.value = false
    return
  }
  unresolvedProjectClose.value = keepUnresolved ? input : null
  projectActionError.value = activeMessage
}

async function sendProjectClose(
  input: Readonly<ProjectCloseInput>,
  context: ProjectMutationContext,
): Promise<void> {
  try {
    const result = await context.repository.closeProject(context.projectCode, input)
    if (!ownsProjectMutation(context)) return
    loadVersion += 1
    unresolvedProjectClose.value = null
    projectPreview.value = result
    if (data.value) data.value = { ...data.value, project: result }
    closeVisible.value = false
  } catch (error) {
    const isSessionError = error instanceof ApiError && error.status === 401
    if (isSessionError) emit('session-expired', error.message)
    if (!ownsProjectMutation(context)) return
    if (isDefinitiveBusinessRejection(error)) unresolvedProjectClose.value = null
    if (isSessionError) return
    if (
      error instanceof ApiError
      && ['REVISION_CONFLICT', 'PROJECT_COMPLETION_BLOCKED'].includes(error.errorCode ?? '')
    ) {
      await reconcileProjectClose(
        input,
        context,
        false,
        error.errorCode === 'PROJECT_COMPLETION_BLOCKED'
          ? '已读取最新完结条件，请核对后再次确认'
          : '项目资料已更新，请核对后再次确认完结',
      )
      return
    }
    if (isIndeterminateCloseFailure(error)) {
      await reconcileProjectClose(
        input,
        context,
        true,
        '项目仍在建，但原完结请求结果仍未知，请原样重试或重新核对状态',
      )
      return
    }
    projectActionError.value = errorMessage(error)
  }
}

async function saveProjectClose(): Promise<void> {
  if (
    !projectPreview.value
    || readonly.value
    || projectSaving.value
    || unresolvedProjectClose.value
  ) return
  const closureType = closeForm.closure_type
  if (closureType === null) {
    projectActionError.value = '请选择正常完结或提前终止'
    return
  }
  const reason = closeForm.reason.trim()
  if (!reason) {
    projectActionError.value = '请填写完结原因'
    return
  }
  if (closureType === 'completed' && completionCheck.value?.ready !== true) {
    projectActionError.value = '正常完结条件尚未全部满足'
    return
  }
  const input: Readonly<ProjectCloseInput> = {
    closure_type: closureType,
    reason,
    expected_revision: projectPreview.value.revision,
  }
  const context = startProjectMutation()
  projectActionError.value = null
  try {
    await sendProjectClose(input, context)
  } finally {
    finishProjectMutation(context)
  }
}

async function retryOriginalProjectClose(): Promise<void> {
  const input = unresolvedProjectClose.value
  if (!input || projectSaving.value) return
  const context = startProjectMutation()
  projectActionError.value = null
  try {
    await sendProjectClose(input, context)
  } finally {
    finishProjectMutation(context)
  }
}

async function recheckProjectCloseState(): Promise<void> {
  const input = unresolvedProjectClose.value
  if (!input || projectSaving.value) return
  const context = startProjectMutation()
  projectActionError.value = null
  try {
    await reconcileProjectClose(
      input,
      context,
      true,
      '项目仍在建，但原完结请求结果仍未知，请原样重试或继续核对状态',
    )
  } finally {
    finishProjectMutation(context)
  }
}

function updateStages(stages: ProjectOperatingSnapshot['stages']): void {
  if (!operating.value) return
  operating.value = { ...operating.value, stages }
  if (data.value) data.value = { ...data.value, stages }
  refreshDashboard()
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

function beforeProjectEditClose(done: () => void): void {
  if (projectSaving.value) return
  confirmDirtyClose(JSON.stringify(editForm) !== editFormBaseline, done)
}

function beforeProjectCloseClose(done: () => void): void {
  if (projectSaving.value || unresolvedProjectClose.value !== null) return
  confirmDirtyClose(JSON.stringify(closeForm) !== closeFormBaseline, done)
}

function beforeProjectRestoreClose(done: () => void): void {
  if (projectSaving.value || unresolvedProjectRestore.value !== null) return
  confirmDirtyClose(JSON.stringify(restoreForm) !== restoreFormBaseline, done)
}

function cancelProjectEdit(): void {
  beforeProjectEditClose(() => { editVisible.value = false })
}

function cancelProjectClose(): void {
  beforeProjectCloseClose(() => { closeVisible.value = false })
}

function cancelProjectRestore(): void {
  beforeProjectRestoreClose(() => { restoreVisible.value = false })
}

watch(
  [() => props.projectCode, () => props.repository],
  ([, nextRepository]) => {
    projectContextVersion += 1
    loadVersion += 1
    activeProjectMutationToken = null
    repository = toRaw(nextRepository)
    activeTab.value = initialTab()
    fieldView.value = 'site'
    editVisible.value = false
    closeVisible.value = false
    restoreVisible.value = false
    companyOptions.value = []
    companyLoading.value = false
    unresolvedProjectClose.value = null
    unresolvedProjectRestore.value = null
    projectSaving.value = false
    projectActionError.value = null
    void loadDashboard()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  projectContextVersion += 1
  loadVersion += 1
  activeProjectMutationToken = null
  projectSaving.value = false
  unresolvedProjectClose.value = null
  unresolvedProjectRestore.value = null
})

watch(
  () => route?.fullPath,
  () => {
    if (routedProjectCode() !== props.projectCode) return
    activeTab.value = routedTab()
  },
)

watch(activeTab, (tab, previousTab) => {
  if (tab !== 'workforce') fieldView.value = 'site'
  if (
    tab === 'home'
    && previousTab
    && previousTab !== 'home'
    && data.value?.project.project_code === props.projectCode
  ) refreshDashboard()
  if (!router) return
  const routeName = tabToRouteName[tab]
  if (route?.name !== routeName) {
    void router.push({ name: routeName, params: { projectCode: props.projectCode } })
  }
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
        </el-space>
        <el-dropdown
          v-if="(projectPreview?.status ?? data.project.status) === 'active'"
          :teleported="false"
          trigger="click"
        >
          <el-button plain :disabled="!projectPreview">项目操作</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item data-testid="project-edit-open" @click="openProjectEdit">编辑项目</el-dropdown-item>
              <el-dropdown-item data-testid="project-close-open" divided @click="openProjectClose">完结并归档</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          v-else
          data-testid="project-restore-open"
          type="primary"
          plain
          :disabled="!projectPreview"
          @click="openProjectRestore"
        >恢复为在建</el-button>
      </div>
    </section>

    <el-card v-if="loading" data-testid="project-dashboard-loading" shadow="never">
      <el-skeleton :rows="8" animated />
    </el-card>
    <el-result v-else-if="loadError" data-testid="project-dashboard-error" icon="error" title="项目工作页读取失败" :sub-title="loadError">
      <template #extra><el-button data-testid="project-dashboard-retry" type="primary" @click="loadDashboard">重新读取</el-button></template>
    </el-result>

    <template v-else-if="data">
      <el-alert
        v-if="readonly"
        data-testid="project-archive-readonly"
        title="此项目已归档，当前工作区仅供查看；如需继续执行，可从右上角恢复为在建"
        type="info"
        show-icon
        :closable="false"
      />
      <el-alert
        v-if="refreshWarning"
        :title="refreshWarning"
        type="warning"
        show-icon
        :closable="false"
      />
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
            :readonly="readonly"
            @stages-changed="updateStages"
          />
        </el-tab-pane>
        <el-tab-pane name="documents" lazy>
          <template #label><span data-testid="project-nav-documents">资料与设计</span></template>
          <el-space class="project-panel-stack" direction="vertical" alignment="stretch" fill :size="20">
            <ProjectDocumentsPanel
              v-if="ProjectDocumentsPanel"
              :key="data.project.project_code"
              :project-code="data.project.project_code"
              :readonly="readonly"
              @changed="refreshDashboard"
            />
          </el-space>
        </el-tab-pane>
        <el-tab-pane v-if="operating" name="commercial" lazy>
          <template #label><span data-testid="project-nav-commercial">报价与收款</span></template>
          <ProjectCommercialPanel
            :operating="operating"
            :project-code="data.project.project_code"
            :customer-company="{ id: data.company.id, name: data.company.name }"
            :readonly="readonly"
            @changed="refreshDashboard"
          />
        </el-tab-pane>
        <el-tab-pane v-if="ProcurementWorkspace" name="procurement" lazy>
          <template #label><span data-testid="project-nav-procurement">采购</span></template>
          <ProcurementWorkspace
            :project-code="data.project.project_code"
            :customer-company="{ id: data.company.id, name: data.company.name }"
            :readonly="readonly"
            @changed="refreshDashboard"
          />
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
              :readonly="readonly"
              @changed="refreshDashboard"
            />
            <DeliveryWorkspace
              v-if="DeliveryWorkspace && fieldView === 'commissioning'"
              :project-code="data.project.project_code"
              scope="commissioning"
              :readonly="readonly"
              @changed="refreshDashboard"
            />
          </div>
        </el-tab-pane>
        <el-tab-pane v-if="DeliveryWorkspace" name="delivery" lazy>
          <template #label><span data-testid="project-nav-delivery">验收与售后</span></template>
          <DeliveryWorkspace
            :project-code="data.project.project_code"
            scope="delivery"
            :readonly="readonly"
            @changed="refreshDashboard"
            @open-commercial="activeTab = 'commercial'"
          />
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-dialog
      v-model="editVisible"
      title="编辑项目"
      :teleported="false"
      width="min(92vw, 520px)"
      :before-close="beforeProjectEditClose"
      :close-on-click-modal="!projectSaving"
      :close-on-press-escape="!projectSaving"
      :show-close="!projectSaving"
    >
      <el-alert v-if="projectActionError" :title="projectActionError" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="saveProjectEdit">
        <el-form-item label="客户" required>
          <el-select
            data-testid="project-edit-company"
            v-model="editForm.company_id"
            filterable
            :loading="companyLoading"
            :disabled="projectSaving"
            placeholder="选择公司"
          >
            <el-option v-for="company in companyOptions" :key="company.id" :label="company.name" :value="company.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目名称" required><el-input data-testid="project-edit-name" v-model="editForm.name" :disabled="projectSaving" /></el-form-item>
        <el-form-item label="项目说明"><el-input data-testid="project-edit-description" v-model="editForm.description" type="textarea" :disabled="projectSaving" /></el-form-item>
        <el-text type="info">保存后立即更新当前项目资料。</el-text>
        <div class="dialog-actions">
          <el-button data-testid="project-edit-cancel" native-type="button" :disabled="projectSaving" @click="cancelProjectEdit">取消</el-button>
          <el-button data-testid="project-edit-save" type="primary" native-type="submit" :loading="projectSaving" :disabled="projectSaving || companyLoading">保存修改</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog
      v-model="closeVisible"
      title="完结项目"
      :teleported="false"
      width="min(92vw, 500px)"
      :before-close="beforeProjectCloseClose"
      :close-on-click-modal="!projectSaving && !unresolvedProjectClose"
      :close-on-press-escape="!projectSaving && !unresolvedProjectClose"
      :show-close="!projectSaving && !unresolvedProjectClose"
    >
        <el-alert v-if="projectActionError" :title="projectActionError" type="error" :closable="false" />
        <el-form label-position="top" @submit.prevent="saveProjectClose">
          <el-form-item label="完结类型" required>
            <el-radio-group data-testid="project-close-type" v-model="closeForm.closure_type" :disabled="projectSaving || unresolvedProjectClose !== null">
              <el-radio value="completed">正常完结</el-radio>
              <el-radio value="cancelled">提前终止</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-alert
            v-if="closeForm.closure_type === 'completed' && completionCheck"
            data-testid="project-close-completion-check"
            :title="completionCheck.ready ? '正常完结条件已满足' : '正常完结条件尚未全部满足'"
            :type="completionCheck.ready ? 'success' : 'warning'"
            show-icon
            :closable="false"
          >
            <div class="completion-checklist">
              <div data-testid="project-close-check-stages" class="completion-checklist__item">
                <el-tag :type="completionCheck.stages_ready ? 'success' : 'danger'" size="small">{{ completionCheck.stages_ready ? '已满足' : '未满足' }}</el-tag>
                <span>所有项目阶段已完成或已跳过</span>
              </div>
              <div data-testid="project-close-check-final-acceptance" class="completion-checklist__item">
                <el-tag :type="completionCheck.final_acceptance_ready ? 'success' : 'danger'" size="small">{{ completionCheck.final_acceptance_ready ? '已满足' : '未满足' }}</el-tag>
                <span>最终验收已通过或带整改通过</span>
              </div>
              <div data-testid="project-close-check-receivables" class="completion-checklist__item">
                <el-tag :type="completionCheck.receivables_ready ? 'success' : 'danger'" size="small">{{ completionCheck.receivables_ready ? '已满足' : '未满足' }}</el-tag>
                <span>项目未收款为 0</span>
              </div>
            </div>
          </el-alert>
          <el-alert
            v-else-if="closeForm.closure_type === 'cancelled'"
            data-testid="project-close-cancelled-warning"
            title="提前终止会将项目标记为已取消并归档；无需满足正常完结条件。"
            type="warning"
            show-icon
            :closable="false"
          />
          <el-form-item label="完结原因" required><el-input data-testid="project-close-reason" v-model="closeForm.reason" type="textarea" :disabled="projectSaving || unresolvedProjectClose !== null" /></el-form-item>
          <el-text type="info">完结后项目进入归档，历史资料仍然保留。</el-text>
          <div v-if="unresolvedProjectClose" class="dialog-actions">
            <el-button data-testid="project-close-cancel" native-type="button" disabled @click="cancelProjectClose">取消</el-button>
            <el-button data-testid="project-close-reconcile-retry" :disabled="projectSaving" @click="recheckProjectCloseState">重新核对状态</el-button>
            <el-button data-testid="project-close-original-retry" type="danger" :loading="projectSaving" :disabled="projectSaving" @click="retryOriginalProjectClose">原样重试</el-button>
          </div>
          <div v-else class="dialog-actions">
            <el-button data-testid="project-close-cancel" native-type="button" :disabled="projectSaving" @click="cancelProjectClose">取消</el-button>
            <el-button data-testid="project-close-save" type="danger" native-type="submit" :loading="projectSaving" :disabled="closeSubmissionDisabled">确认完结</el-button>
          </div>
        </el-form>
    </el-dialog>

    <el-dialog
      v-model="restoreVisible"
      title="恢复项目"
      :teleported="false"
      width="min(92vw, 500px)"
      :before-close="beforeProjectRestoreClose"
      :close-on-click-modal="!projectSaving && !unresolvedProjectRestore"
      :close-on-press-escape="!projectSaving && !unresolvedProjectRestore"
      :show-close="!projectSaving && !unresolvedProjectRestore"
    >
      <el-alert v-if="projectActionError" :title="projectActionError" type="error" :closable="false" />
      <el-alert
        v-if="projectPreview?.closure_type === 'completed'"
        data-testid="project-restore-completed-warning"
        title="这是已完结项目。恢复后会重新进入在建状态，原完结记录会保留在审计历史。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else-if="projectPreview?.closure_type === 'cancelled'"
        data-testid="project-restore-cancelled-warning"
        title="这是已取消项目。恢复后会重新进入在建状态，原取消记录会保留在审计历史。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else
        title="恢复后项目重新进入在建状态，原归档记录会保留在审计历史。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-form label-position="top" @submit.prevent="saveProjectRestore">
        <el-form-item label="恢复原因" required>
          <el-input
            data-testid="project-restore-reason"
            v-model="restoreForm.reason"
            type="textarea"
            :disabled="projectSaving || unresolvedProjectRestore !== null"
            placeholder="例如：客户确认继续实施，项目重新启动"
          />
        </el-form-item>
        <div class="dialog-actions">
          <el-button
            data-testid="project-restore-cancel"
            native-type="button"
            :disabled="projectSaving || unresolvedProjectRestore !== null"
            @click="cancelProjectRestore"
          >取消</el-button>
          <el-button
            v-if="unresolvedProjectRestore"
            data-testid="project-restore-original-retry"
            type="danger"
            :loading="projectSaving"
            :disabled="projectSaving"
            @click="retryOriginalProjectRestore"
          >原样重试</el-button>
          <el-button
            v-else
            data-testid="project-restore-save"
            type="primary"
            native-type="submit"
            :loading="projectSaving"
            :disabled="restoreSubmissionDisabled"
          >确认恢复</el-button>
        </div>
      </el-form>
    </el-dialog>
  </el-space>
</template>

<style scoped>
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
.completion-checklist { display: grid; gap: 8px; margin-top: 10px; }
.completion-checklist__item { display: flex; align-items: center; gap: 8px; }
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
  .project-actions :deep(.el-dropdown),
  .project-actions :deep(.el-button) { width: 100%; margin-left: 0; }
}
</style>
