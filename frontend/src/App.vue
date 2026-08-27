<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'

import { requestJson, requestVoid } from './api'
import AuthPanel from './components/AuthPanel.vue'
import DashboardPanel from './components/DashboardPanel.vue'
import type {
  BackupCreated,
  BackupSettingsPayload,
  BackupSettingsResponse,
  SessionState,
  SystemOverview,
} from './types'

const appLoading = ref(true)
const session = ref<SessionState | null>(null)
const overview = ref<SystemOverview | null>(null)
const requestError = ref<string | null>(null)
const authBusy = ref(false)
const logoutBusy = ref(false)
const overviewLoading = ref(false)
const backupBusy = ref(false)
const saveBusy = ref(false)
const successNotice = ref<string | null>(null)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

async function loadOverview(): Promise<void> {
  overviewLoading.value = true
  try {
    overview.value = await requestJson<SystemOverview>('/api/system/overview')
  } finally {
    overviewLoading.value = false
  }
}

async function loadSession(): Promise<void> {
  requestError.value = null
  try {
    session.value = await requestJson<SessionState>('/api/auth/session')
    if (session.value.authenticated) {
      await loadOverview()
    }
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    appLoading.value = false
  }
}

async function retrySession(): Promise<void> {
  appLoading.value = true
  await loadSession()
}

async function authenticate(password: string): Promise<void> {
  if (!session.value || authBusy.value) return
  authBusy.value = true
  requestError.value = null
  successNotice.value = null
  const requiresSetup = !session.value.password_configured
  try {
    if (requiresSetup) {
      await requestVoid('/api/auth/setup', { method: 'POST', body: { password } })
      session.value = { authenticated: false, password_configured: true }
    }
    await requestVoid('/api/auth/login', { method: 'POST', body: { password } })
    session.value = { authenticated: true, password_configured: true }
    await loadOverview()
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    authBusy.value = false
  }
}

async function logout(): Promise<void> {
  if (logoutBusy.value) return
  logoutBusy.value = true
  requestError.value = null
  successNotice.value = null
  try {
    await requestVoid('/api/auth/logout', { method: 'POST' })
    overview.value = null
    session.value = { authenticated: false, password_configured: true }
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    logoutBusy.value = false
  }
}

async function saveBackup(settings: BackupSettingsPayload): Promise<void> {
  if (!overview.value || saveBusy.value) return
  saveBusy.value = true
  requestError.value = null
  successNotice.value = null
  try {
    const backup = await requestJson<BackupSettingsResponse>(
      '/api/system/backup-settings',
      { method: 'PUT', body: settings },
    )
    overview.value = {
      ...overview.value,
      backup: { ...backup, last_run: overview.value.backup.last_run },
    }
    successNotice.value = '备份设置已保存'
    ElMessage.success(successNotice.value)
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    saveBusy.value = false
  }
}

async function backupNow(): Promise<void> {
  if (backupBusy.value) return
  backupBusy.value = true
  requestError.value = null
  successNotice.value = null
  try {
    await requestJson<BackupCreated>('/api/system/backups', { method: 'POST' })
    await loadOverview()
    ElMessage.success('备份已完成')
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    backupBusy.value = false
  }
}

onMounted(loadSession)
</script>

<template>
  <el-container v-if="appLoading" data-testid="app-loading" direction="vertical">
    <el-main>
      <el-row justify="center">
        <el-col :xs="24" :sm="18" :md="12" :lg="8">
          <el-card shadow="never">
            <el-result icon="info" title="正在载入 SunYu ERP" sub-title="正在确认本机会话和数据状态" />
          </el-card>
        </el-col>
      </el-row>
    </el-main>
  </el-container>

  <el-container v-else-if="!session" data-testid="startup-error" direction="vertical">
    <el-main>
      <el-row justify="center">
        <el-col :xs="24" :sm="18" :md="12" :lg="8">
          <el-card shadow="never">
            <el-result icon="error" title="本地服务暂时不可用" sub-title="未读取到会话状态，暂不开放密码设置。">
              <template #extra>
                <el-space direction="vertical" fill>
                  <el-alert
                    :title="requestError ?? '无法连接本地服务'"
                    type="error"
                    show-icon
                    :closable="false"
                  />
                  <el-button data-testid="startup-retry" type="primary" @click="retrySession">
                    重新连接
                  </el-button>
                </el-space>
              </template>
            </el-result>
          </el-card>
        </el-col>
      </el-row>
    </el-main>
  </el-container>

  <AuthPanel
    v-else-if="!session.authenticated"
    :password-configured="session.password_configured"
    :busy="authBusy"
    :request-error="requestError"
    @submit="authenticate"
  />

  <DashboardPanel
    v-else
    :overview="overview"
    :loading="overviewLoading"
    :request-error="requestError"
    :success-notice="successNotice"
    :backup-busy="backupBusy"
    :save-busy="saveBusy"
    :logout-busy="logoutBusy"
    @logout="logout"
    @save-backup="saveBackup"
    @backup-now="backupNow"
  />
</template>
