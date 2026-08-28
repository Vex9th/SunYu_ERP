<script setup lang="ts">
import { ref, watch } from 'vue'

import { ApiError, requestJson } from '../api'
import type { ProjectDashboardData } from '../types'

const props = defineProps<{
  projectCode: string
}>()

const emit = defineEmits<{
  back: []
  'session-expired': [message: string]
}>()

const data = ref<ProjectDashboardData | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
let loadVersion = 0

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

async function loadDashboard(): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  loadError.value = null
  data.value = null
  try {
    const response = await requestJson<ProjectDashboardData>(
      `/api/projects/${encodeURIComponent(props.projectCode)}/dashboard`,
    )
    if (version === loadVersion) data.value = response
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

watch(() => props.projectCode, loadDashboard, { immediate: true })
</script>

<template>
  <el-space direction="vertical" alignment="stretch" fill :size="16">
    <el-card shadow="never">
      <el-row justify="space-between" align="middle">
        <el-space>
          <el-button data-testid="project-dashboard-back" @click="emit('back')">返回项目中心</el-button>
          <el-text tag="strong" size="large">独立项目仪表台 · {{ projectCode }}</el-text>
        </el-space>
        <el-tag v-if="data" :type="data.project.status === 'active' ? 'success' : 'info'">
          {{ statusLabel(data.project.status) }}
        </el-tag>
      </el-row>
    </el-card>

    <el-alert
      title="当前展示已录入的项目基础资料与文档统计"
      description="还未录入的成本、收款和进度不会用假数据填充。"
      type="info"
      show-icon
      :closable="false"
    />

    <el-card v-if="loading" data-testid="project-dashboard-loading" shadow="never">
      <el-skeleton :rows="8" animated />
    </el-card>
    <el-result v-else-if="loadError" data-testid="project-dashboard-error" icon="error" title="项目仪表台读取失败" :sub-title="loadError">
      <template #extra><el-button data-testid="project-dashboard-retry" type="primary" @click="loadDashboard">重新读取</el-button></template>
    </el-result>

    <template v-else-if="data">
      <el-card shadow="never">
        <template #header><el-text tag="strong">项目资料</el-text></template>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="项目编号">{{ data.project.project_code }}</el-descriptions-item>
          <el-descriptions-item label="状态"><el-tag :type="data.project.status === 'active' ? 'success' : 'info'">{{ statusLabel(data.project.status) }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="项目名称">{{ data.project.name }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ data.company.name }}</el-descriptions-item>
          <el-descriptions-item label="项目说明" :span="2">{{ data.project.description ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="归档原因">{{ data.project.archive_reason ?? '未归档' }}</el-descriptions-item>
          <el-descriptions-item label="归档时间">{{ data.project.archived_at ?? '未归档' }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never">
        <template #header><el-text tag="strong">客户开票资料</el-text></template>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="公司名称" :span="2">{{ data.company.name }}</el-descriptions-item>
          <el-descriptions-item label="税号">{{ data.company.taxpayer_id ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册电话">{{ data.company.registered_phone ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="注册地址" :span="2">{{ data.company.registered_address ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="开户行">{{ data.company.bank_name ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="银行账号">{{ data.company.bank_account ?? '未录入' }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ data.company.notes ?? '无' }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never">
        <template #header><el-text tag="strong">客户联系人</el-text></template>
        <el-empty v-if="data.contacts.length === 0" data-testid="contacts-empty" description="暂无联系人" />
        <el-table v-else :data="data.contacts" row-key="id">
          <el-table-column prop="name" label="姓名" />
          <el-table-column prop="position" label="职务"><template #default="scope">{{ scope.row.position ?? '未录入' }}</template></el-table-column>
          <el-table-column prop="phone" label="电话"><template #default="scope">{{ scope.row.phone ?? '未录入' }}</template></el-table-column>
          <el-table-column prop="email" label="邮箱"><template #default="scope">{{ scope.row.email ?? '未录入' }}</template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header>
          <el-row justify="space-between" align="middle">
            <el-text tag="strong">项目文档统计</el-text>
            <el-space>
              <el-tag type="primary">文档 {{ data.documents.document_count }}</el-tag>
              <el-tag type="info">版本 {{ data.documents.version_count }}</el-tag>
            </el-space>
          </el-row>
        </template>
        <el-empty v-if="data.documents.categories.length === 0" data-testid="documents-empty" description="暂无文档归档" />
        <el-table v-else :data="data.documents.categories" row-key="category">
          <el-table-column prop="category" label="资料分类" />
          <el-table-column prop="document_count" label="文档数" />
          <el-table-column prop="version_count" label="版本数" />
        </el-table>
      </el-card>
    </template>
  </el-space>
</template>
