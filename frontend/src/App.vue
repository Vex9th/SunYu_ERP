<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { inject, onMounted, ref } from 'vue'
import { routeLocationKey } from 'vue-router'

import { ApiError, requestJson, requestVoid } from './api'
import AuthPanel from './components/AuthPanel.vue'
import DashboardPanel from './components/DashboardPanel.vue'
import NotFoundPage from './components/NotFoundPage.vue'
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
const overviewError = ref<string | null>(null)
const requestError = ref<string | null>(null)
const systemRequestError = ref<string | null>(null)
const authBusy = ref(false)
const logoutBusy = ref(false)
const overviewLoading = ref(false)
const backupBusy = ref(false)
const saveBusy = ref(false)
const successNotice = ref<string | null>(null)
const route = inject(routeLocationKey, null)
let sessionEpoch = 0
let overviewRequestVersion = 0
let backupOperationVersion = 0
let saveOperationVersion = 0

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试'
}

function setSession(nextSession: SessionState): void {
  sessionEpoch += 1
  overviewRequestVersion += 1
  backupOperationVersion += 1
  saveOperationVersion += 1
  overviewLoading.value = false
  backupBusy.value = false
  saveBusy.value = false
  session.value = nextSession
}

function clearWorkspaceState(): void {
  overview.value = null
  overviewError.value = null
  systemRequestError.value = null
  successNotice.value = null
}

function handleSystemRequestError(error: unknown, expectedEpoch = sessionEpoch): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  if (expectedEpoch !== sessionEpoch) return true
  clearWorkspaceState()
  setSession({ authenticated: false, password_configured: true })
  requestError.value = errorMessage(error)
  return true
}

function handleSessionExpired(message: string): void {
  clearWorkspaceState()
  setSession({ authenticated: false, password_configured: true })
  requestError.value = message
}

async function loadOverview(): Promise<boolean> {
  if (!session.value?.authenticated) return false
  const expectedEpoch = sessionEpoch
  const requestVersion = ++overviewRequestVersion
  overviewLoading.value = true
  overviewError.value = null
  try {
    const response = await requestJson<SystemOverview>('/api/system/overview')
    if (expectedEpoch !== sessionEpoch || requestVersion !== overviewRequestVersion) return false
    overview.value = response
    return true
  } catch (error) {
    if (expectedEpoch !== sessionEpoch || requestVersion !== overviewRequestVersion) return false
    overview.value = null
    if (!handleSystemRequestError(error, expectedEpoch)) {
      overviewError.value = errorMessage(error)
    }
    return false
  } finally {
    if (expectedEpoch === sessionEpoch && requestVersion === overviewRequestVersion) {
      overviewLoading.value = false
    }
  }
}

async function loadSession(): Promise<void> {
  requestError.value = null
  try {
    const response = await requestJson<SessionState>('/api/auth/session')
    setSession(response)
    if (response.authenticated) {
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
  systemRequestError.value = null
  successNotice.value = null
  const requiresSetup = !session.value.password_configured
  try {
    if (requiresSetup) {
      await requestVoid('/api/auth/setup', { method: 'POST', body: { password } })
      setSession({ authenticated: false, password_configured: true })
    }
    await requestVoid('/api/auth/login', { method: 'POST', body: { password } })
    setSession({ authenticated: true, password_configured: true })
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
  systemRequestError.value = null
  successNotice.value = null
  const expectedEpoch = sessionEpoch
  try {
    await requestVoid('/api/auth/logout', { method: 'POST' })
    if (expectedEpoch !== sessionEpoch) return
    clearWorkspaceState()
    setSession({ authenticated: false, password_configured: true })
  } catch (error) {
    if (expectedEpoch === sessionEpoch) requestError.value = errorMessage(error)
  } finally {
    logoutBusy.value = false
  }
}

async function saveBackup(settings: BackupSettingsPayload): Promise<void> {
  if (!overview.value || saveBusy.value) return
  const expectedEpoch = sessionEpoch
  const operationVersion = ++saveOperationVersion
  saveBusy.value = true
  systemRequestError.value = null
  successNotice.value = null
  try {
    const backup = await requestJson<BackupSettingsResponse>(
      '/api/system/backup-settings',
      { method: 'PUT', body: settings },
    )
    if (expectedEpoch !== sessionEpoch || !overview.value) return
    overview.value = {
      ...overview.value,
      backup: { ...backup, last_run: overview.value.backup.last_run },
    }
    successNotice.value = '备份设置已保存'
    ElMessage.success(successNotice.value)
  } catch (error) {
    if (expectedEpoch !== sessionEpoch) return
    if (!handleSystemRequestError(error, expectedEpoch)) {
      systemRequestError.value = errorMessage(error)
    }
  } finally {
    if (expectedEpoch === sessionEpoch && operationVersion === saveOperationVersion) {
      saveBusy.value = false
    }
  }
}

async function backupNow(): Promise<void> {
  if (backupBusy.value) return
  const expectedEpoch = sessionEpoch
  const operationVersion = ++backupOperationVersion
  backupBusy.value = true
  systemRequestError.value = null
  successNotice.value = null
  try {
    const backup = await requestJson<BackupCreated>('/api/system/backups', { method: 'POST' })
    if (expectedEpoch !== sessionEpoch) return
    if (backup.warning) {
      ElMessage.warning('备份已完成，但自动清理失败，请检查备份目录')
    } else {
      ElMessage.success('备份已完成')
    }
    await loadOverview()
  } catch (error) {
    if (expectedEpoch !== sessionEpoch) return
    if (!handleSystemRequestError(error, expectedEpoch)) {
      systemRequestError.value = errorMessage(error)
    }
  } finally {
    if (expectedEpoch === sessionEpoch && operationVersion === backupOperationVersion) {
      backupBusy.value = false
    }
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

  <NotFoundPage v-else-if="route?.name === 'not-found'" />

  <DashboardPanel
    v-else
    :overview="overview"
    :loading="overviewLoading"
    :overview-error="overviewError"
    :request-error="requestError"
    :system-request-error="systemRequestError"
    :success-notice="successNotice"
    :backup-busy="backupBusy"
    :save-busy="saveBusy"
    :logout-busy="logoutBusy"
    @logout="logout"
    @save-backup="saveBackup"
    @backup-now="backupNow"
    @refresh-overview="loadOverview"
    @session-expired="handleSessionExpired"
  />
</template>
