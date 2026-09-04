<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'

import { ApiError, requestJson } from '../api'
import type { CompanySummary, ProjectSummary } from '../types'

const emit = defineEmits<{
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
let projectLoadVersion = 0
let companyLoadVersion = 0
let sessionErrorReported = false

const contactCount = computed(() => companies.value.reduce((sum, company) => sum + company.contact_count, 0))
const incompleteCompanyCount = computed(() => companies.value.filter(
  (company) => !company.taxpayer_id || company.contact_count === 0,
).length)
const loadError = computed(() => [projectError.value, companyError.value].filter(Boolean).join('；') || null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function handleFailure(error: unknown, target: 'projects' | 'companies'): void {
  if (error instanceof ApiError && error.status === 401) {
    if (!sessionErrorReported) {
      sessionErrorReported = true
      emit('session-expired', error.message)
    }
    return
  }
  if (target === 'projects') {
    projectState.value = 'error'
    projectError.value = errorMessage(error)
  } else {
    companyState.value = 'error'
    companyError.value = errorMessage(error)
  }
}

async function loadProjects(): Promise<void> {
  const version = ++projectLoadVersion
  projects.value = []
  projectState.value = 'loading'
  projectError.value = null
  try {
    const value = await requestJson<ProjectSummary[]>('/api/projects?status=active')
    if (version !== projectLoadVersion) return
    projects.value = value
    projectState.value = 'ready'
  } catch (error) {
    if (version === projectLoadVersion) handleFailure(error, 'projects')
  }
}

async function loadCompanies(): Promise<void> {
  const version = ++companyLoadVersion
  companies.value = []
  companyState.value = 'loading'
  companyError.value = null
  try {
    const value = await requestJson<CompanySummary[]>('/api/companies')
    if (version !== companyLoadVersion) return
    companies.value = value
    companyState.value = 'ready'
  } catch (error) {
    if (version === companyLoadVersion) handleFailure(error, 'companies')
  }
}

onMounted(() => {
  void loadProjects()
  void loadCompanies()
})
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
        <p>项目经营、采购库存和施工交付集中在这里，日常事项可直接处理。</p>
      </div>
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
        <el-button v-if="projectError" data-testid="workbench-project-retry" link type="primary" @click="loadProjects">重试项目</el-button>
        <el-button v-if="companyError" data-testid="workbench-company-retry" link type="primary" @click="loadCompanies">重试公司</el-button>
      </template>
    </el-alert>

    <PortfolioOperatingOverview @open-project="emit('open-project', $event)" />

    <el-card data-testid="workbench-summary" class="workbench-summary" shadow="never">
      <template #header><el-text tag="strong">基础资料</el-text></template>
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="在建项目"><span data-testid="workbench-active-projects" class="workbench-summary__item">{{ projectState === 'loading' ? '正在读取' : projectState === 'ready' ? projects.length : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="合作公司"><span data-testid="workbench-companies" class="workbench-summary__item">{{ companyState === 'loading' ? '正在读取' : companyState === 'ready' ? companies.length : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="联系人"><span class="workbench-summary__item">{{ companyState === 'loading' ? '正在读取' : companyState === 'ready' ? contactCount : '--' }}</span></el-descriptions-item>
        <el-descriptions-item label="资料待完善"><span class="workbench-summary__item">{{ companyState === 'loading' ? '正在读取' : companyState === 'ready' ? incompleteCompanyCount : '--' }}</span></el-descriptions-item>
      </el-descriptions>
    </el-card>

  </el-space>
</template>
