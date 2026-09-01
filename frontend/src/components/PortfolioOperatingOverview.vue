<script setup lang="ts">
import { onMounted, ref } from 'vue'

import type { GlobalDashboard } from '../domain/contracts'
import { formatMoney } from '../domain/formatters'
import { createHttpProjectOperatingRepository } from '../repositories/project-operating.live'

const emit = defineEmits<{
  'open-project': [projectCode: string]
}>()

const dashboard = ref<GlobalDashboard | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const repository = createHttpProjectOperatingRepository()

const stageLabels: Record<string, string> = {
  planning: '项目规划', site_survey: '现场测绘', quotation: '我方报价',
  technical_agreement: '技术协议', contract: '合同签订', advance_payment: '预付款',
  mechanical_design: '机械设计', electrical_design: '电气设计', procurement: '采购',
  staffing: '人员排单', mechanical_signoff: '机械图纸会签', electrical_signoff: '电气图纸会签',
  construction: '施工', progress_payment: '进度款', commissioning: '调试',
  acceptance: '验收', final_payment: '尾款', closeout: '收尾',
}

async function loadDashboard(): Promise<void> {
  loading.value = true
  loadError.value = null
  dashboard.value = null
  try {
    dashboard.value = await repository.getGlobalDashboard()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '经营总览读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadDashboard)

function severityType(severity: GlobalDashboard['todos'][number]['severity']): 'info' | 'warning' | 'error' {
  return severity === 'danger' ? 'error' : severity
}

function stageLabel(stageCode: string | undefined): string {
  if (!stageCode) return '未开始'
  return stageLabels[stageCode] ?? stageCode
}
</script>

<template>
  <el-space
    data-testid="portfolio-operating-overview"
    class="page-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="20"
  >
    <header class="overview-heading">
      <div>
        <h2>经营总览</h2>
        <p>在建项目、应收和当前阶段集中查看。</p>
      </div>
      <el-tag data-testid="portfolio-operating-live" type="success" effect="plain">真实后端</el-tag>
    </header>

    <el-card v-if="loading" shadow="never"><el-skeleton :rows="6" animated /></el-card>

    <el-result
      v-else-if="loadError"
      data-testid="portfolio-operating-error"
      icon="error"
      title="经营总览读取失败"
      :sub-title="loadError"
    >
      <template #extra><el-button data-testid="portfolio-operating-retry" type="primary" @click="loadDashboard">重新读取</el-button></template>
    </el-result>

    <template v-else-if="dashboard">
      <div data-testid="backup-compact" class="backup-compact">
        <el-tag :type="dashboard.backup.healthy ? 'success' : 'warning'">
          {{ dashboard.backup.healthy ? '备份正常' : '备份待检查' }}
        </el-tag>
        <el-text type="info">{{ dashboard.backup.message ?? `最近成功：${dashboard.backup.last_success_at ?? '暂无记录'}` }}</el-text>
      </div>

      <el-row :gutter="16" class="metric-grid">
        <el-col :xs="12" :md="8" :xl="4">
          <el-card class="metric-card" shadow="never">
            <el-statistic title="在建项目" :value="dashboard.summary.active_project_count" />
            <el-text type="info">当前经营主线中的活跃项目</el-text>
          </el-card>
        </el-col>
        <el-col :xs="12" :md="8" :xl="4">
          <el-card class="metric-card metric-card--attention" shadow="never">
            <el-statistic title="逾期应收" :value="dashboard.summary.overdue_receivable_count" />
            <el-text type="info">只统计后端判定的逾期节点</el-text>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8" :xl="4">
          <el-card class="metric-card" shadow="never">
            <div class="metric-value"><span>合同分摊额</span><strong>{{ formatMoney(dashboard.summary.contracted_amount_cents) }}</strong></div>
            <el-text type="info">有效合同在项目中的分摊合计</el-text>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8" :xl="4">
          <el-card class="metric-card" shadow="never">
            <div class="metric-value"><span>未收金额</span><strong>{{ formatMoney(dashboard.summary.outstanding_receivable_cents) }}</strong></div>
            <el-text type="info">实际到账与计划应收独立计算</el-text>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8" :xl="4">
          <el-card class="metric-card" shadow="never">
            <div class="metric-value"><span>实际到账</span><strong>{{ formatMoney(dashboard.summary.received_amount_cents) }}</strong></div>
            <el-text type="info">已经确认的到账流水</el-text>
          </el-card>
        </el-col>
        <el-col :xs="24" :md="8" :xl="4">
          <el-card class="metric-card" shadow="never">
            <el-statistic title="近期交付" :value="dashboard.summary.upcoming_delivery_count" />
            <el-text type="info">即将到期的项目交付</el-text>
          </el-card>
        </el-col>
      </el-row>

      <el-card class="data-card" shadow="never">
        <template #header>
          <el-row justify="space-between" align="middle">
            <div>
              <el-text tag="strong" size="large">项目经营台账</el-text>
              <p class="section-note">报价不作为收入，利润只使用合同分摊额和实际成本。</p>
            </div>
            <el-tag type="info">生成于 {{ dashboard.generated_at }}</el-tag>
          </el-row>
        </template>
        <div class="overview-table-scroll">
        <el-table class="overview-project-table" :data="dashboard.projects" row-key="project.id">
          <el-table-column prop="project.project_code" label="项目编号" width="125" show-overflow-tooltip />
          <el-table-column prop="project.name" label="项目名称" min-width="160">
            <template #default="scope"><el-button :data-testid="`portfolio-open-project-${scope.row.project.project_code}`" class="project-open-link" link type="primary" @click="emit('open-project', scope.row.project.project_code)">{{ scope.row.project.name }}</el-button></template>
          </el-table-column>
          <el-table-column prop="project.company_name" label="客户公司" min-width="150" show-overflow-tooltip />
          <el-table-column label="当前阶段" min-width="100">
            <template #default="scope">{{ stageLabel(scope.row.current_stage?.stage_code) }}</template>
          </el-table-column>
          <el-table-column label="合同分摊额" min-width="115">
            <template #default="scope">{{ formatMoney(scope.row.contracted_amount_cents) }}</template>
          </el-table-column>
          <el-table-column label="实际到账" min-width="115">
            <template #default="scope">{{ formatMoney(scope.row.received_amount_cents) }}</template>
          </el-table-column>
          <el-table-column label="未收金额" min-width="115">
            <template #default="scope">{{ formatMoney(scope.row.outstanding_receivable_cents) }}</template>
          </el-table-column>
          <el-table-column prop="final_delivery_on" label="最终交付" min-width="100" />
          <el-table-column label="实际利润" min-width="115">
            <template #default="scope">{{ formatMoney(scope.row.actual_profit_cents) }}</template>
          </el-table-column>
        </el-table>
        </div>
        <div class="overview-mobile-projects">
          <el-card v-for="item in dashboard.projects" :key="item.project.id" shadow="never">
            <div class="mobile-project-heading"><el-button :data-testid="`portfolio-mobile-open-${item.project.project_code}`" link type="primary" @click="emit('open-project', item.project.project_code)">{{ item.project.name }}</el-button><el-tag size="small" type="info">{{ stageLabel(item.current_stage?.stage_code) }}</el-tag></div>
            <small>{{ item.project.project_code }} · {{ item.project.company_name }}</small>
            <el-descriptions :column="2" size="small" border>
              <el-descriptions-item label="未收">{{ formatMoney(item.outstanding_receivable_cents) }}</el-descriptions-item>
              <el-descriptions-item label="利润">{{ formatMoney(item.actual_profit_cents) }}</el-descriptions-item>
              <el-descriptions-item label="最终交付" :span="2">{{ item.final_delivery_on || '未设置' }}</el-descriptions-item>
            </el-descriptions>
          </el-card>
        </div>
      </el-card>

      <el-row :gutter="20">
        <el-col :xs="24">
          <el-card class="data-card" shadow="never">
            <template #header><el-text tag="strong" size="large">经营待办</el-text></template>
            <el-empty v-if="dashboard.todos.length === 0" description="当前没有待办" />
            <el-space v-else direction="vertical" alignment="stretch" fill>
              <el-alert
                v-for="todo in dashboard.todos"
                :key="`${todo.code}-${todo.project_code ?? 'global'}`"
                :title="todo.title"
                :description="`${todo.due_on ?? '无截止日期'} · ${todo.description ?? '暂无说明'}`"
                :type="severityType(todo.severity)"
                :closable="false"
                show-icon
              />
            </el-space>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </el-space>
</template>

<style scoped>
.overview-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.overview-heading h2 { margin: 0; font-size: 22px; }
.overview-heading p { margin: 4px 0 0; color: var(--el-text-color-secondary); }
.backup-compact { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 12px; border: 1px solid var(--sunyu-line); border-radius: 6px; background: var(--sunyu-surface); }
.backup-compact .el-text { min-width: 0; overflow-wrap: anywhere; }
.overview-table-scroll { width: 100%; min-width: 0; max-width: 100%; overflow-x: auto; }
.overview-project-table { width: 100%; min-width: 1095px; }
.overview-mobile-projects { display: none; }
.project-open-link { height: auto; white-space: normal; text-align: left; line-height: 1.45; }
@media (max-width: 1180px) {
  .overview-heading { align-items: flex-start; }
  .overview-table-scroll { display: none; }
  .overview-mobile-projects { display: grid; gap: 10px; }
  .overview-mobile-projects :deep(.el-card__body) { display: grid; gap: 10px; padding: 12px; }
  .mobile-project-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .mobile-project-heading :deep(.el-button) { height: auto; margin: 0; padding: 0; white-space: normal; text-align: left; }
  .overview-mobile-projects small { color: var(--sunyu-muted); overflow-wrap: anywhere; }
}
</style>
