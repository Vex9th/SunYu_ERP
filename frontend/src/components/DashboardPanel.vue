<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from 'vue'

import type { BackupSettingsPayload, SystemOverview } from '../types'
import CompanyCenter from './CompanyCenter.vue'
import HomeWorkbench from './HomeWorkbench.vue'
import ProjectCenter from './ProjectCenter.vue'
import ProjectDashboard from './ProjectDashboard.vue'

const InventoryCenter = defineAsyncComponent(() => import('./inventory/InventoryCenter.vue'))

const props = defineProps<{
  overview: SystemOverview | null
  loading: boolean
  overviewError: string | null
  requestError: string | null
  systemRequestError: string | null
  successNotice: string | null
  backupBusy: boolean
  saveBusy: boolean
  logoutBusy: boolean
}>()

const emit = defineEmits<{
  logout: []
  saveBackup: [settings: BackupSettingsPayload]
  backupNow: []
  refreshOverview: []
  'session-expired': [message: string]
}>()

type WorkspacePage =
  | 'overview'
  | 'projects'
  | 'companies'
  | 'inventory'
  | 'system'

const selectedPage = ref<WorkspacePage>('overview')
const dashboardProjectCode = ref<string | null>(null)

const workspacePages: WorkspacePage[] = ['overview', 'projects', 'companies', 'inventory', 'system']

const backupForm = reactive({
  enabled: false,
  directory: '',
  intervalHours: 24,
  retentionDays: 30,
})
const validationError = ref<string | null>(null)

watch(
  () => props.overview?.backup,
  (backup) => {
    if (!backup) return
    backupForm.enabled = backup.enabled
    backupForm.directory = backup.directory ?? ''
    backupForm.intervalHours = backup.interval_hours
    backupForm.retentionDays = backup.retention_days
  },
  { immediate: true },
)

const backupStatus = computed(() => (props.overview?.backup.enabled ? '已启用' : '已关闭'))
const lastRunTime = computed(() => {
  const run = props.overview?.backup.last_run
  return run ? (run.finished_at ?? run.started_at) : '尚未执行'
})
const lastRunStatus = computed(() => {
  const status = props.overview?.backup.last_run?.status
  if (!status) return null
  return { running: '进行中', success: '成功', failed: '失败' }[status] ?? status
})
const lastRunStatusType = computed(() => {
  const status = props.overview?.backup.last_run?.status
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'warning'
  return 'info'
})

function saveBackup(): void {
  validationError.value = null
  const directory = backupForm.directory.trim()
  if (backupForm.enabled && directory.length === 0) {
    validationError.value = '请输入备份目录'
    return
  }
  if (
    !Number.isInteger(backupForm.intervalHours) ||
    backupForm.intervalHours < 1 ||
    backupForm.intervalHours > 8760
  ) {
    validationError.value = '备份间隔必须是 1 至 8760 小时的整数'
    return
  }
  if (
    !Number.isInteger(backupForm.retentionDays) ||
    backupForm.retentionDays < 0 ||
    backupForm.retentionDays > 3650
  ) {
    validationError.value = '保留天数必须是 0 至 3650 的整数'
    return
  }
  emit('saveBackup', {
    directory: backupForm.enabled ? directory : null,
    interval_hours: backupForm.intervalHours,
    retention_days: backupForm.retentionDays,
  })
}

function selectPage(index: string): void {
  if (!workspacePages.includes(index as WorkspacePage)) return
  selectedPage.value = index as WorkspacePage
  dashboardProjectCode.value = null
}

function navigate(page: 'projects' | 'companies' | 'system'): void {
  selectPage(page)
}

function openProjectDashboard(projectCode: string): void {
  selectedPage.value = 'projects'
  dashboardProjectCode.value = projectCode
}
</script>

<template>
  <el-container data-testid="dashboard" class="workspace-shell">
    <el-aside data-testid="nav-column" class="workspace-aside" width="216px">
      <div class="brand-block">
        <div class="brand-mark">SY</div>
        <div>
          <div class="brand-name">SunYu ERP</div>
          <div class="brand-caption">工业项目工作台</div>
        </div>
      </div>

      <el-menu
        :default-active="selectedPage"
        class="workspace-menu"
        background-color="transparent"
        text-color="#aeb9c8"
        active-text-color="#ffffff"
        @select="selectPage"
      >
        <el-menu-item data-testid="nav-overview" index="overview">总览</el-menu-item>
        <el-menu-item data-testid="nav-projects" index="projects">项目</el-menu-item>
        <el-menu-item data-testid="nav-companies" index="companies">联系人</el-menu-item>
        <el-menu-item v-if="InventoryCenter" data-testid="nav-inventory" index="inventory">库存</el-menu-item>
        <el-menu-item data-testid="nav-system" index="system">设置</el-menu-item>
      </el-menu>

      <div class="aside-status">
        <span class="status-dot" :class="{ 'status-dot--warning': !overview?.scheduler.alive }" />
        <div>
          <strong>{{ overview?.scheduler.alive ? '本地服务正常' : '系统状态待检查' }}</strong>
          <small>数据保存在当前主机</small>
        </div>
      </div>
    </el-aside>

    <el-container class="workspace-main">
      <el-header class="workspace-topbar">
        <el-tag :type="overview?.scheduler.alive ? 'success' : 'warning'" effect="plain">
          {{ overview?.scheduler.alive ? '本地服务正常' : '系统状态待检查' }}
        </el-tag>
        <el-button
          data-testid="logout"
          plain
          :loading="logoutBusy"
          :disabled="logoutBusy || backupBusy || saveBusy"
          @click="emit('logout')"
        >
          退出登录
        </el-button>
      </el-header>

      <el-main data-testid="content-column" class="workspace-content">
        <el-alert
          v-if="requestError"
          data-testid="request-error"
          :title="requestError"
          type="error"
          show-icon
          :closable="false"
        />
        <HomeWorkbench
          v-if="selectedPage === 'overview' && !dashboardProjectCode"
          @navigate="navigate"
          @open-project="openProjectDashboard"
          @session-expired="emit('session-expired', $event)"
        />
        <ProjectDashboard
          v-if="dashboardProjectCode"
          :project-code="dashboardProjectCode"
          @back="dashboardProjectCode = null"
          @session-expired="emit('session-expired', $event)"
        />
        <ProjectCenter
          v-if="selectedPage === 'projects'"
          v-show="!dashboardProjectCode"
          @open-dashboard="openProjectDashboard"
          @session-expired="emit('session-expired', $event)"
        />
        <CompanyCenter
          v-if="selectedPage === 'companies'"
          @session-expired="emit('session-expired', $event)"
        />
        <InventoryCenter
          v-if="InventoryCenter && selectedPage === 'inventory'"
        />
        <el-space
          v-show="selectedPage === 'system' && !dashboardProjectCode"
          class="page-stack system-settings"
          direction="vertical"
          alignment="stretch"
          fill
          :size="16"
        >
          <section class="page-heading">
            <div>
              <h1>系统设置</h1>
              <p>本地数据与备份。</p>
            </div>
            <el-button
              v-if="overview"
              data-testid="backup-now"
              type="primary"
              size="large"
              :loading="backupBusy"
              :disabled="backupBusy || saveBusy || !overview.backup.enabled"
              @click="emit('backupNow')"
            >
              立即备份
            </el-button>
          </section>
          <el-alert
            v-if="systemRequestError"
            data-testid="system-request-error"
            :title="systemRequestError"
            type="error"
            show-icon
            :closable="false"
          />
          <el-alert
            v-if="successNotice"
            :title="successNotice"
            type="success"
            show-icon
            :closable="false"
          />

          <el-card v-if="loading && !overview" data-testid="overview-loading" shadow="never">
            <el-skeleton :rows="5" animated />
            <el-text type="info">正在读取系统状态</el-text>
          </el-card>

          <el-card v-else-if="!overview" data-testid="overview-error" shadow="never">
            <el-result
              icon="error"
              title="系统概况读取失败"
              :sub-title="overviewError ?? '未能读取本地数据与备份状态'"
            >
              <template #extra>
                <el-button
                  data-testid="overview-retry"
                  type="primary"
                  :loading="loading"
                  :disabled="loading"
                  @click="emit('refreshOverview')"
                >
                  重新读取
                </el-button>
              </template>
            </el-result>
          </el-card>

          <template v-else>
          <el-row :gutter="16">
            <el-col :xs="24" :lg="12">
              <el-card shadow="never">
                <template #header>
                  <el-text tag="strong">系统状态</el-text>
                </template>
                <el-descriptions data-testid="scheduler-status" :column="1" border>
                  <el-descriptions-item label="数据目录">
                    <el-text>{{ overview.data_directory }}</el-text>
                  </el-descriptions-item>
                  <el-descriptions-item label="SQLite 数据库">
                    <el-text>{{ overview.database_path }}</el-text>
                  </el-descriptions-item>
                  <el-descriptions-item label="备份调度器">
                    <el-tag :type="overview.scheduler.alive ? 'success' : 'danger'">
                      {{ overview.scheduler.alive ? '运行中' : '已停止' }}
                    </el-tag>
                  </el-descriptions-item>
                  <el-descriptions-item label="最近调度错误时间">
                    {{ overview.scheduler.last_error_at ?? '无' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="最近调度错误码">
                    {{ overview.scheduler.last_error_code ?? '无' }}
                  </el-descriptions-item>
                </el-descriptions>
              </el-card>
            </el-col>

            <el-col :xs="24" :lg="12">
              <el-card shadow="never">
                <template #header>
                  <el-row justify="space-between" align="middle">
                    <el-text tag="strong">备份状态</el-text>
                    <el-tag :type="overview.backup.enabled ? 'success' : 'info'">
                      {{ overview.backup.enabled ? '策略有效' : '尚未启用' }}
                    </el-tag>
                  </el-row>
                </template>
                <el-descriptions :column="1" border>
                  <el-descriptions-item label="自动备份">
                    <el-tag :type="overview.backup.enabled ? 'success' : 'info'">
                      {{ backupStatus }}
                    </el-tag>
                  </el-descriptions-item>
                  <el-descriptions-item label="备份目录">
                    {{ overview.backup.directory ?? '未设置' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="执行间隔">
                    {{ overview.backup.interval_hours }} 小时
                  </el-descriptions-item>
                  <el-descriptions-item label="保留周期">
                    {{ overview.backup.retention_days }} 天
                  </el-descriptions-item>
                  <el-descriptions-item v-if="lastRunStatus" label="最近状态">
                    <el-tag data-testid="last-run-status" :type="lastRunStatusType">
                      {{ lastRunStatus }}
                    </el-tag>
                  </el-descriptions-item>
                  <el-descriptions-item label="最近执行">
                    {{ lastRunTime }}
                  </el-descriptions-item>
                  <el-descriptions-item
                    v-if="overview.backup.last_run?.target_path"
                    label="最近目录"
                  >
                    {{ overview.backup.last_run.target_path }}
                  </el-descriptions-item>
                  <el-descriptions-item
                    v-if="overview.backup.last_run?.error_message"
                    label="最近错误"
                  >
                    <el-text type="danger">{{ overview.backup.last_run.error_message }}</el-text>
                  </el-descriptions-item>
                </el-descriptions>
              </el-card>
            </el-col>
          </el-row>

          <el-card shadow="never">
            <template #header>
              <el-space direction="vertical" alignment="start" :size="4">
                <el-text tag="strong">自动备份设置</el-text>
                <el-text type="info">目录可以直接选择群晖同步到本机的文件夹。</el-text>
              </el-space>
            </template>

            <el-alert
              v-if="validationError"
              :title="validationError"
              type="error"
              show-icon
              :closable="false"
            />
            <el-divider v-if="validationError" />

            <el-form label-position="top" @submit.prevent="saveBackup">
              <el-form-item label="启用自动备份">
                <el-switch
                  data-testid="backup-enabled"
                  v-model="backupForm.enabled"
                  :disabled="saveBusy"
                  aria-label="启用自动备份"
                />
              </el-form-item>
              <el-form-item label="备份目录">
                <el-input
                  data-testid="backup-directory"
                  v-model="backupForm.directory"
                  placeholder="例如 D:\SynologyDrive\SunYu ERP Backups"
                  :disabled="!backupForm.enabled || saveBusy"
                  aria-label="本机备份目录"
                />
              </el-form-item>
              <el-row :gutter="16">
                <el-col :xs="24" :md="12">
                  <el-form-item label="执行间隔（小时）">
                    <el-input-number
                      data-testid="backup-interval"
                      v-model="backupForm.intervalHours"
                      :min="1"
                      :max="8760"
                      :step="1"
                      step-strictly
                      controls-position="right"
                      :disabled="saveBusy"
                      aria-label="自动备份间隔小时数"
                    />
                  </el-form-item>
                </el-col>
                <el-col :xs="24" :md="12">
                  <el-form-item label="自动清理周期（天）">
                    <el-input-number
                      data-testid="backup-retention"
                      v-model="backupForm.retentionDays"
                      :min="0"
                      :max="3650"
                      :step="1"
                      step-strictly
                      controls-position="right"
                      :disabled="saveBusy"
                      aria-label="备份保留天数"
                    />
                  </el-form-item>
                </el-col>
              </el-row>
              <el-button
                data-testid="backup-save"
                native-type="submit"
                type="primary"
                :loading="saveBusy"
                :disabled="saveBusy || backupBusy"
              >
                保存备份设置
              </el-button>
            </el-form>
          </el-card>
          </template>
        </el-space>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.system-settings,
.system-settings > :deep(.el-space__item),
.system-settings :deep(.el-card) { width: 100%; min-width: 0 !important; max-width: 100%; }
.system-settings :deep(.el-descriptions__table) { width: 100%; table-layout: fixed; }
.system-settings :deep(.el-descriptions__label) { width: 132px; }
.system-settings :deep(.el-descriptions__content),
.system-settings :deep(.el-text) { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
@media (max-width: 520px) {
  .system-settings :deep(.el-descriptions__label) { width: 92px; }
}
</style>
