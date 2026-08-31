import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PortfolioOperatingOverview from '../components/PortfolioOperatingOverview.vue'
import ProjectCommercialPanel from '../components/project/ProjectCommercialPanel.vue'
import ProjectDocumentsPanel from '../components/project/ProjectDocumentsPanel.vue'
import ProjectStagesPanel from '../components/project/ProjectStagesPanel.vue'
import type { ProjectStageRepository } from '../repositories/project'
import { MockProjectRepository } from '../repositories/project.mock'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountComponent(component: object, props: Record<string, unknown> = {}): VueWrapper {
  return mount(component, {
    attachTo: document.body,
    props,
    global: { plugins: [ElementPlus] },
  })
}

function stageRepository(repository: MockProjectRepository): ProjectStageRepository {
  return {
    async listProjectStages(projectCode) {
      const snapshot = await repository.getOperatingSnapshot(projectCode)
      return { source: snapshot.source, data: snapshot.data.stages }
    },
    updateStageSchedule: (...args) => repository.updateStageSchedule(...args),
    transitionStage: (...args) => repository.transitionStage(...args),
  }
}

describe('P0 preview workspaces', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('全局经营面板只消费冻结 GlobalDashboard 字段并明确标记演示数据', async () => {
    const repository = new MockProjectRepository()
    const result = await repository.getGlobalDashboard()

    expect(result.source).toBe('demo')
    expect(Object.keys(result.data).sort()).toEqual(['backup', 'generated_at', 'projects', 'summary', 'todos'])
    expect(Object.keys(result.data.summary).sort()).toEqual([
      'active_project_count',
      'contracted_amount_cents',
      'outstanding_receivable_cents',
      'overdue_receivable_count',
      'received_amount_cents',
      'upcoming_delivery_count',
    ])

    const wrapper = mountComponent(PortfolioOperatingOverview)
    await settle()

    expect(wrapper.get('[data-testid="portfolio-operating-overview"]').text()).toContain('演示数据')
    expect(wrapper.text()).not.toContain('P0 ')
    expect(wrapper.text()).not.toContain('独立 Mock Repository')
    expect(wrapper.text()).toContain('合同分摊额')
    expect(wrapper.text()).toContain('实际到账')
    expect(wrapper.text()).toContain('近期交付')
    expect(wrapper.text()).toContain('逾期应收')
    expect(wrapper.text()).toContain('机械设计')
    expect(wrapper.get('[data-testid="backup-compact"]').text()).toContain('备份')
    expect(wrapper.find('[data-testid="portfolio-operating-overview"] .el-result').exists()).toBe(false)
    await wrapper.get('[data-testid="portfolio-open-project-SY-2026-001"]').trigger('click')
    expect(wrapper.emitted('open-project')).toEqual([['SY-2026-001']])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('完整项目流程可编辑排期并流转阶段状态', async () => {
    const repository = new MockProjectRepository()
    const snapshot = (await repository.getOperatingSnapshot('SY-2026-001')).data
    const scheduled = await repository.updateStageSchedule('SY-2026-001', 'mechanical_design', {
      planned_start_on: '2026-09-01',
      planned_end_on: '2026-09-20',
      notes: '先完成机械图纸',
      expected_revision: 5,
    })
    expect(scheduled.data.revision).toBe(6)
    expect(scheduled.data.planned_end_on).toBe('2026-09-20')
    const transitioned = await repository.transitionStage('SY-2026-001', 'mechanical_design', {
      to_status: 'completed',
      occurred_at: '2026-09-20T09:00:00+08:00',
      reason: null,
      expected_revision: 6,
    })
    expect(transitioned.data.status).toBe('completed')
    expect(transitioned.data.revision).toBe(7)
    await expect(repository.updateStageSchedule('SY-2026-001', 'mechanical_design', {
      planned_start_on: null,
      planned_end_on: null,
      notes: null,
      expected_revision: 5,
    })).rejects.toThrow('记录已更新')

    const uiSnapshot = (await repository.getOperatingSnapshot('SY-2026-001')).data
    const wrapper = mountComponent(ProjectStagesPanel, {
      projectCode: 'SY-2026-001',
      stages: uiSnapshot.stages,
      repository: stageRepository(repository),
    })
    await settle()

    expect(wrapper.findAll('[data-testid^="stage-row-"]')).toHaveLength(18)
    expect(wrapper.get('[data-testid="stage-row-mechanical_design"]').text()).toContain('机械设计')
    expect(wrapper.text()).toContain('等待客户确认现场接口尺寸')
    await wrapper.get('[data-testid="stage-schedule-mechanical_design"]').trigger('click')
    await wrapper.get('[data-testid="stage-schedule-save"]').trigger('click')
    await settle()
    expect(wrapper.text()).not.toContain('记录已更新')
    expect(wrapper.get('[data-testid="stage-row-mechanical_design"]').text()).toContain('2026-09-20')

    await wrapper.get('[data-testid="stage-transition-staffing"]').trigger('click')
    await wrapper.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()
    const finalSnapshot = (await repository.getOperatingSnapshot('SY-2026-001')).data
    expect(finalSnapshot.stages.find((stage) => stage.stage_code === 'staffing')?.status).toBe('in_progress')
    const changes = wrapper.emitted('changed') as Array<[typeof finalSnapshot.stages]>
    expect(changes[changes.length - 1]?.[0].find((stage) => stage.stage_code === 'staffing')?.status).toBe('in_progress')
    expect(wrapper.get('[data-testid="stage-row-staffing"]').text()).toContain('进行中')
    expect(wrapper.emitted('changed')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('阶段状态原因在保存后以明确标签展示，不与排期备注互相覆盖', async () => {
    const repository = new MockProjectRepository()
    const initial = (await repository.getOperatingSnapshot('SY-2026-001')).data
    const staffing = initial.stages.find((stage) => stage.stage_code === 'staffing')!
    await repository.updateStageSchedule('SY-2026-001', 'staffing', {
      planned_start_on: null,
      planned_end_on: null,
      notes: '人员计划待项目日期确认',
      expected_revision: staffing.revision,
    })
    const snapshot = (await repository.getOperatingSnapshot('SY-2026-001')).data
    const wrapper = mountComponent(ProjectStagesPanel, {
      projectCode: 'SY-2026-001',
      stages: snapshot.stages,
      repository: stageRepository(repository),
    })
    await settle()

    await wrapper.get('[data-testid="stage-transition-staffing"]').trigger('click')
    await wrapper.getComponent('[data-testid="stage-transition-status"]').setValue('skipped')
    await wrapper.get('[data-testid="stage-transition-reason"]').setValue('客户暂不安排施工人员')
    await wrapper.get('[data-testid="stage-transition-save"]').trigger('click')
    await settle()

    const row = wrapper.get('[data-testid="stage-row-staffing"]')
    expect(row.get('[data-testid="stage-status-reason-staffing"]').text())
      .toBe('状态原因：客户暂不安排施工人员')
    expect(row.text()).toContain('排期备注：人员计划待项目日期确认')
  })

  it('文档版本台账在本地演示新建、追加版本、归档和下载边界', async () => {
    const createObjectUrl = vi.fn(() => 'blob:demo-document')
    const revokeObjectUrl = vi.fn()
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const wrapper = mountComponent(ProjectDocumentsPanel, { projectCode: 'SY-2026-001' })
    await settle()

    expect(wrapper.get('[data-testid="project-documents-panel"]').text()).toContain('演示数据')
    expect(wrapper.findAll('.el-alert').length).toBeLessThanOrEqual(1)
    expect(wrapper.text()).toContain('现场测绘记录')
    expect(wrapper.text()).toContain('现场勘查')
    expect(wrapper.text()).not.toContain('site_survey')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text())
      .toContain('1 份资料 · 1 个历史版本')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text())
      .toContain('资料数量不代表审批完成或项目进度')

    await wrapper.get('[data-testid="document-edit-open-101"]').trigger('click')
    await wrapper.get('[data-testid="document-edit-title"]').setValue('现场测绘与接口复核')
    await wrapper.get('[data-testid="document-edit-notes"]').setValue('已完成客户复核')
    await wrapper.get('[data-testid="document-edit-save"]').trigger('click')
    expect(wrapper.text()).toContain('现场测绘与接口复核')

    await wrapper.get('[data-testid="document-create-open"]').trigger('click')
    await wrapper.get('[data-testid="document-create-title"]').setValue('施工交底记录')
    const createFile = wrapper.get('[data-testid="document-create-file"]')
    Object.defineProperty(createFile.element, 'files', {
      configurable: true,
      value: [new File(['demo'], 'brief.pdf', { type: 'application/pdf' })],
    })
    await createFile.trigger('change')
    await wrapper.get('[data-testid="document-create-save"]').trigger('click')
    expect(wrapper.text()).toContain('施工交底记录')

    await wrapper.get('[data-testid="document-version-open-101"]').trigger('click')
    const versionFile = wrapper.get('[data-testid="document-version-file"]')
    Object.defineProperty(versionFile.element, 'files', {
      configurable: true,
      value: [new File(['demo-v2'], 'survey-v2.pdf', { type: 'application/pdf' })],
    })
    await versionFile.trigger('change')
    await wrapper.get('[data-testid="document-version-save"]').trigger('click')
    expect(wrapper.get('[data-testid="document-row-101"]').text()).toContain('V2')
    expect(wrapper.get('[data-testid="document-ledger-summary"]').text())
      .toContain('2 份资料 · 3 个历史版本')

    await wrapper.get('[data-testid="document-download-101"]').trigger('click')
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="document-demo-notice"]').text()).toContain('已下载本次会话中的演示文件')

    await wrapper.get('[data-testid="document-archive-open-101"]').trigger('click')
    await wrapper.get('[data-testid="document-archive-reason"]').setValue('资料已由新版本替代')
    await wrapper.get('[data-testid="document-archive-save"]').trigger('click')
    expect(wrapper.get('[data-testid="document-row-101"]').text()).toContain('已归档')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('商务二级视图以独立事实展示报价、合同、三段收款和到账流水', async () => {
    const snapshot = (await new MockProjectRepository().getOperatingSnapshot('SY-2026-001')).data
    const wrapper = mountComponent(ProjectCommercialPanel, {
      operating: snapshot,
      projectCode: 'SY-2026-001',
      customerCompany: { id: 1, name: '演示客户单位' },
    })

    expect(wrapper.text()).toContain('报价不是项目收入')
    expect(wrapper.text()).toContain('发票不是收款')
    expect(wrapper.text()).toContain('演示数据')
    expect(wrapper.findAll('.el-alert')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('状态操作')

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const quoteDate = wrapper.get('[aria-label="新建报价 · 演示"] .el-date-editor input')
    expect((quoteDate.element as HTMLInputElement).value).not.toBe('')
    await quoteDate.setValue('2026-09-01')
    await wrapper.get('[data-testid="quote-amount"]').setValue('3000000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="commercial-quotes"]').text()).toContain('¥3,000,000.00')
    await wrapper.get('[data-testid="quote-edit-open-12"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('3100000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="commercial-quotes"]').text()).toContain('¥3,100,000.00')
    expect(wrapper.get('[data-testid="quote-status-12"]').text()).toContain('草稿')
    expect(wrapper.get('[data-testid="quote-status-12"]').attributes()).toMatchObject({ role: 'button', tabindex: '0' })

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contract-no"]').setValue('SYHT-2026-019')
    await wrapper.get('[data-testid="contract-title"]').setValue('装配线二期合同')
    expect((wrapper.get('[data-testid="contract-company"]').element as HTMLInputElement).value)
      .toBe('演示客户单位')
    await wrapper.get('[data-testid="contract-total"]').setValue('800000.00')
    await wrapper.get('[data-testid="contract-allocation"]').setValue('800000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="commercial-contracts"]').text()).toContain('SYHT-2026-019')
    await wrapper.get('[data-testid="contract-edit-open-22"]').trigger('click')
    await wrapper.get('[data-testid="contract-title"]').setValue('装配线二期补充合同')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="commercial-contracts"]').text()).toContain('装配线二期补充合同')
    expect(wrapper.get('[data-testid="contract-status-22"]').attributes()).toMatchObject({ role: 'button', tabindex: '0' })

    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    expect(wrapper.get('[data-testid="commercial-receivables"]').text()).toContain('已收清')
    expect(wrapper.get('[data-testid="commercial-receivables"]').text()).toContain('部分到账')
    expect(wrapper.get('[data-testid="commercial-receivables"]').text()).toContain('待收款')
    await wrapper.get('[data-testid="receipt-create-open"]').trigger('click')
    const receiptDate = wrapper.get('[aria-label="登记到账 · 演示"] .el-date-editor input')
    expect((receiptDate.element as HTMLInputElement).value).not.toBe('')
    await receiptDate.setValue('2026-09-03')
    await wrapper.get('[data-testid="receipt-amount"]').setValue('120000.00')
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="receipt-ledger"]').text()).toContain('¥120,000.00')
    await wrapper.get('[data-testid="receipt-edit-open-1"]').trigger('click')
    await wrapper.get('[data-testid="receipt-reference"]').setValue('BANK-20260903')
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    expect(wrapper.get('[data-testid="receipt-ledger"]').text()).toContain('BANK-20260903')

    await wrapper.get('[data-testid="receipt-void-1"]').trigger('click')
    const voidDate = wrapper.get('[aria-label="作废到账 · 演示"] .el-date-editor input')
    expect((voidDate.element as HTMLInputElement).value).not.toBe('')
    await voidDate.setValue('2026-09-04')
    await wrapper.get('[data-testid="receipt-void-reason"]').setValue('客户付款信息录入错误')
    await wrapper.get('[data-testid="receipt-void-save"]').trigger('click')
    expect(wrapper.get('[data-testid="receipt-ledger"]').text()).toContain('已作废')
    expect(wrapper.get('[data-testid="receivable-total-received"]').text()).toContain('¥1,340,000.00')
    expect(wrapper.text()).not.toMatch(/金额（分）|公司 ID|分摊（分）/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
