<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'

import { ApiError, requestJson } from '../api'
import type { CompanySummary, ProjectSummary } from '../types'

const emit = defineEmits<{
  navigate: [page: 'projects' | 'companies' | 'system']
  'open-project': [projectCode: string]
  'session-expired': [message: string]
}>()

const projects = ref<ProjectSummary[]>([])
const companies = ref<CompanySummary[]>([])
const PortfolioOperatingOverview = defineAsyncComponent(() => import('./PortfolioOperatingOverview.vue'))
type LoadState = 'loading' | 'ready' | 'error'
const projectState = ref<LoadState>('loading')
const companyState = ref<LoadState>('loading')
const projectError = ref<string | null>(null)
const companyError = ref<string | null>(null)
let loadVersion = 0

const recentProjects = computed(() => projects.value.slice(0, 5))
const contactCount = computed(() => companies.value.reduce((sum, company) => sum + company.contact_count, 0))
const incompleteCompanyCount = computed(() => companies.value.filter(
  (company) => !company.taxpayer_id || company.contact_count === 0,
).length)
const loadError = computed(() => [projectError.value, companyError.value].filter(Boolean).join('；') || null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

async function loadWorkbench(): Promise<void> {
  const version = ++loadVersion
  let sessionErrorReported = false
  projects.value = []
  companies.value = []
  projectState.value = 'loading'
  companyState.value = 'loading'
  projectError.value = null
  companyError.value = null

  function handleFailure(error: unknown, target: 'projects' | 'companies'): void {
    if (error instanceof ApiError && error.status === 401) {
      if (!sessionErrorReported) {
        sessionErrorReported = true
        emit('session-expired', error.message)
      }
      return
    }
    if (version !== loadVersion) return
    if (target === 'projects') {
      projectState.value = 'error'
      projectError.value = errorMessage(error)
    } else {
      companyState.value = 'error'
      companyError.value = errorMessage(error)
    }
  }

  await Promise.all([
    requestJson<ProjectSummary[]>('/api/projects?status=active')
      .then((value) => {
        if (version !== loadVersion) return
        projects.value = value
        projectState.value = 'ready'
      })
      .catch((error: unknown) => handleFailure(error, 'projects')),
    requestJson<CompanySummary[]>('/api/companies')
      .then((value) => {
        if (version !== loadVersion) return
        companies.value = value
        companyState.value = 'ready'
      })
      .catch((error: unknown) => handleFailure(error, 'companies')),
  ])
}

onMounted(loadWorkbench)
</script>

<template>
  <el-space
    data-testid="workbench-overview"
    class="page-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="20"
  >
    <section class="page-heading page-heading--hero">
      <div>
        <h1>今天先处理什么</h1>
        <p>项目经营、采购库存和施工交付均连接本机真实数据，日常事项可直接处理。</p>
      </div>
      <el-button type="primary" size="large" @click="emit('navigate', 'projects')">
        进入项目中心
      </el-button>
    </section>

    <el-alert
      v-if="loadError"
      data-testid="workbench-error"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
    >
      <template #default>
        <el-button link type="primary" @click="loadWorkbench">重新读取</el-button>
      </template>
    </el-alert>

    <PortfolioOperatingOverview @open-project="emit('open-project', $event)" />

    <el-card data-testid="workbench-summary" class="workbench-summary" shadow="never">
      <template #header><el-text tag="strong">基础资料</el-text></template>
      <el-skeleton v-if="projectState === 'loading' || companyState === 'loading'" :rows="1" animated />
      <el-descriptions v-else :column="4" border size="small">
        <el-descriptions-item label="在建项目"><span data-testid="workbench-active-projects" class="workbench-summary__item">{{ projectState === 'ready' ? projects.length : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="合作公司"><span data-testid="workbench-companies" class="workbench-summary__item">{{ companyState === 'ready' ? companies.length : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="联系人"><span class="workbench-summary__item">{{ companyState === 'ready' ? contactCount : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="资料待完善"><span class="workbench-summary__item">{{ companyState === 'ready' ? incompleteCompanyCount : '--' }}</span></el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-row>
      <el-col data-testid="workbench-recent-projects" :xs="24" :xl="24">
        <el-card class="content-card" shadow="never">
          <template #header>
            <el-row justify="space-between" align="middle">
              <div>
                <el-text tag="strong" size="large">最近在建项目</el-text>
                <p class="section-note">从项目进入，查看已经真实录入的资料与文档统计。</p>
              </div>
              <el-button link type="primary" @click="emit('navigate', 'projects')">查看全部</el-button>
            </el-row>
          </template>
          <el-skeleton v-if="projectState === 'loading'" :rows="5" animated />
          <el-result
            v-else-if="projectState === 'error'"
            data-testid="workbench-project-error"
            icon="error"
            title="项目数据读取失败"
            sub-title="当前无法判断是否存在在建项目。"
          >
            <template #extra><el-button type="primary" @click="loadWorkbench">重新读取</el-button></template>
          </el-result>
          <el-empty v-else-if="recentProjects.length === 0" description="暂无在建项目">
            <el-button type="primary" @click="emit('navigate', 'projects')">建立第一个项目</el-button>
          </el-empty>
          <div v-else class="workbench-project-table-scroll">
          <el-table class="workbench-project-table" :data="recentProjects" row-key="id">
            <el-table-column prop="project_code" label="项目编号" width="150" show-overflow-tooltip />
            <el-table-column prop="name" label="项目名称" min-width="260">
              <template #default="scope"><el-button class="project-open-link" link type="primary" @click="emit('open-project', scope.row.project_code)">{{ scope.row.name }}</el-button></template>
            </el-table-column>
            <el-table-column prop="company_name" label="客户公司" min-width="320">
              <template #default="scope"><span class="project-company-cell">{{ scope.row.company_name }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default><el-tag type="success">在建</el-tag></template>
            </el-table-column>
          </el-table>
          </div>
          <div class="workbench-mobile-projects">
            <el-card v-for="project in recentProjects" :key="project.id" shadow="never">
              <el-button link type="primary" @click="emit('open-project', project.project_code)">{{ project.name }}</el-button>
              <small>{{ project.project_code }} · {{ project.company_name }}</small>
              <el-tag size="small" type="success">在建</el-tag>
            </el-card>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </el-space>
</template>

<style scoped>
.workbench-project-table-scroll { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
.workbench-project-table { width: 100%; min-width: 0; }
.workbench-mobile-projects { display: none; }
.project-company-cell { display: block; white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
.project-open-link { height: auto; white-space: normal; text-align: left; line-height: 1.45; }
@media (max-width: 1180px) {
  .workbench-project-table-scroll { display: none; }
  .workbench-mobile-projects { display: grid; gap: 10px; }
  .workbench-mobile-projects :deep(.el-card__body) { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; padding: 12px; }
  .workbench-mobile-projects :deep(.el-button) { height: auto; margin: 0; padding: 0; white-space: normal; text-align: left; justify-self: start; }
  .workbench-mobile-projects small { grid-column: 1 / -1; color: var(--sunyu-muted); overflow-wrap: anywhere; }
}
</style>
