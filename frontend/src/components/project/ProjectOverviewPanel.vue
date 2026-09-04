<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ProjectOperatingSnapshot } from '../../domain/contracts'
import { formatChineseDate } from '../../domain/dates'
import { formatBasisPoints, formatMoney } from '../../domain/formatters'
import ProjectStagesPanel from './ProjectStagesPanel.vue'

const props = defineProps<{
  operating: ProjectOperatingSnapshot
  projectCode?: string
  readonly?: boolean
}>()

const emit = defineEmits<{ stagesChanged: [stages: ProjectOperatingSnapshot['stages']] }>()

const severityTypes = {
  info: 'info',
  warning: 'warning',
  danger: 'danger',
} as const

const severityLabels = {
  info: '提示',
  warning: '警告',
  danger: '严重',
} as const

const costCompleteness = computed(() => ({
  complete: { label: '成本口径完整', type: 'success' as const },
  partial: { label: '成本数据不完整', type: 'warning' as const },
  unavailable: { label: '成本尚未接通', type: 'info' as const },
})[props.operating.costs.completeness])

const stageFlowVisible = ref(false)
const stageLabels: Record<string, string> = {
  planning: '项目规划', site_survey: '现场测绘', quotation: '我方报价',
  technical_agreement: '技术协议', contract: '合同签订', advance_payment: '预付款',
  mechanical_design: '机械设计', electrical_design: '电气设计', procurement: '采购',
  staffing: '人员排单', mechanical_signoff: '机械图纸会签', electrical_signoff: '电气图纸会签',
  construction: '施工', progress_payment: '进度款', commissioning: '调试',
  acceptance: '验收', final_payment: '尾款', closeout: '收尾',
}
function isTerminalStage(status: ProjectOperatingSnapshot['stages'][number]['status']): boolean {
  return status === 'completed' || status === 'skipped'
}

const terminalStageCount = computed(() => props.operating.stages.filter((stage) => isTerminalStage(stage.status)).length)
const currentStageIndex = computed(() => props.operating.stages.findIndex((stage) => !isTerminalStage(stage.status)))
const currentStage = computed(() => props.operating.stages[currentStageIndex.value])
const nextStage = computed(() => props.operating.stages.find((stage, index) => (
  index > currentStageIndex.value && !isTerminalStage(stage.status)
)))

function stageLabel(stageCode: string): string {
  return stageLabels[stageCode] ?? stageCode
}

const currentStageText = computed(() => {
  if (props.operating.stages.length === 0) return '暂无阶段数据'
  if (currentStageIndex.value < 0) return '已完成全部流程'
  return stageLabel(currentStage.value!.stage_code)
})

const nextStageText = computed(() => {
  if (props.operating.stages.length === 0) return '暂无阶段数据'
  if (currentStageIndex.value < 0) return '已完成全部流程'
  if (currentStage.value?.status === 'blocked') return '等待解除阻塞'
  if (nextStage.value) return stageLabel(nextStage.value.stage_code)
  return '暂无下一阶段'
})
</script>

<template>
  <el-space
    data-testid="project-panel-overview"
    class="project-panel-stack"
    direction="vertical"
    alignment="stretch"
    fill
    :size="20"
  >
    <el-card data-testid="project-stage-summary" class="stage-summary-card" shadow="never">
      <div class="stage-summary">
        <div data-testid="project-current-stage" class="stage-summary__item"><span>当前阶段</span><strong>{{ currentStageText }}</strong></div>
        <div class="stage-summary__item"><span>整体进度</span><strong>{{ terminalStageCount }} / {{ operating.stages.length }}</strong></div>
        <div data-testid="project-next-stage" class="stage-summary__item"><span>下一步</span><strong>{{ nextStageText }}</strong></div>
        <div class="stage-summary__actions">
          <el-tag :type="operating.todos.length > 0 ? 'warning' : 'success'">待办 {{ operating.todos.length }}</el-tag>
          <el-button data-testid="project-stage-flow-open" plain @click="stageFlowVisible = true">查看完整流程</el-button>
        </div>
      </div>
    </el-card>

    <el-row data-testid="project-demo-finance" :gutter="16" class="metric-grid">
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card class="metric-card" shadow="never">
          <div class="metric-value"><span>合同分摊额</span><strong>{{ formatMoney(operating.profit.contracted_amount_cents) }}</strong></div>
          <el-text type="info">有效合同在当前项目的分摊</el-text>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card class="metric-card" shadow="never">
          <div class="metric-value"><span>实际到账</span><strong>{{ formatMoney(operating.receivables.received_amount_cents) }}</strong></div>
          <el-text type="info">到账与发票保持独立</el-text>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card class="metric-card" shadow="never">
          <div class="metric-value"><span>实际成本</span><strong>{{ formatMoney(operating.profit.actual_cost_cents) }}</strong></div>
          <el-text type="info">已领用、人员与现场材料</el-text>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :xl="6">
        <el-card class="metric-card metric-card--attention" shadow="never">
          <div class="metric-value"><span>实际利润</span><strong>{{ formatMoney(operating.profit.actual_profit_cents) }}</strong></div>
          <el-text type="info">利润率 {{ formatBasisPoints(operating.profit.margin_basis_points) }}</el-text>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20">
      <el-col :xs="24" :xl="15">
        <el-card data-testid="project-demo-costs" class="data-card cost-ledger" shadow="never">
          <template #header>
            <el-row justify="space-between" align="middle">
              <div>
                <el-text tag="strong" size="large">成本与采购边界</el-text>
                <p class="section-note">利润只扣实际发生成本，采购承诺、库存资产和付款现金流另列。</p>
              </div>
              <el-tag data-testid="project-cost-completeness" :type="costCompleteness.type">
                {{ costCompleteness.label }}
              </el-tag>
            </el-row>
          </template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="已领用库存成本">{{ formatMoney(operating.costs.material_consumed_cents) }}</el-descriptions-item>
            <el-descriptions-item label="已发生人员成本">{{ formatMoney(operating.costs.labor_cents) }}</el-descriptions-item>
            <el-descriptions-item label="现场材料成本">{{ formatMoney(operating.costs.field_material_cents) }}</el-descriptions-item>
            <el-descriptions-item label="实际成本合计"><strong>{{ formatMoney(operating.costs.total_cents) }}</strong></el-descriptions-item>
            <el-descriptions-item label="采购承诺（不计利润）">{{ formatMoney(operating.costs.procurement_committed_cents) }}</el-descriptions-item>
            <el-descriptions-item label="已到货库存资产">{{ formatMoney(operating.costs.procurement_received_cents) }}</el-descriptions-item>
            <el-descriptions-item label="采购付款现金流">{{ formatMoney(operating.costs.procurement_paid_cents) }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
      <el-col :xs="24" :xl="9">
        <el-card data-testid="project-demo-todos" class="data-card todo-card" shadow="never">
          <template #header>
            <div>
              <el-text tag="strong" size="large">当前关注</el-text>
              <p class="section-note">只展示后端待办描述，不猜测处理页面。</p>
            </div>
          </template>
          <el-empty v-if="operating.todos.length === 0" description="当前没有待办" />
          <div v-else class="todo-list">
            <div v-for="todo in operating.todos" :key="todo.code" class="todo-item">
              <el-tag :type="severityTypes[todo.severity]" effect="dark" size="small">
                {{ severityLabels[todo.severity] }} · {{ todo.due_on ? formatChineseDate(todo.due_on) : '无截止日期' }}
              </el-tag>
              <strong>{{ todo.title }}</strong>
              <p>{{ todo.description ?? '暂无说明' }}</p>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-drawer v-model="stageFlowVisible" title="完整项目流程" :teleported="false" size="min(92vw, 720px)">
      <ProjectStagesPanel
        v-if="stageFlowVisible"
        :project-code="projectCode ?? 'SY-2026-001'"
        :stages="operating.stages"
        :readonly="readonly"
        @changed="emit('stagesChanged', $event)"
      />
    </el-drawer>
  </el-space>
</template>

<style scoped>
.stage-summary-card { min-width: 0; }
.stage-summary {
  display: grid;
  grid-template-columns: minmax(120px, .8fr) minmax(100px, .6fr) minmax(160px, 1.2fr) auto;
  align-items: center;
  gap: 12px 20px;
}
.stage-summary__item { display: grid; gap: 4px; min-width: 0; }
.stage-summary__item span { color: var(--el-text-color-secondary); font-size: 13px; }
.stage-summary__item strong { overflow-wrap: anywhere; }
.stage-summary__actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
@media (max-width: 900px) {
  .stage-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stage-summary__actions { justify-content: flex-start; }
}
@media (max-width: 520px) { .stage-summary { grid-template-columns: 1fr; } }
</style>
