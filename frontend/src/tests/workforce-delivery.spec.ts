import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DeliveryWorkspace from '../components/delivery/DeliveryWorkspace.vue'
import WorkforceCenter from '../components/workforce/WorkforceCenter.vue'
import { localISODate } from '../domain/dates'
import { resetDemoBusinessContext, useDemoBusinessContext } from '../repositories/demo-context'
import { MockWorkforceRepository } from '../repositories/workforce'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountComponent(
  component: object,
  projectCode = 'SY-2026-001',
  repository: MockWorkforceRepository = useDemoBusinessContext().workforce,
): VueWrapper {
  return mount(component, {
    attachTo: document.body,
    props: { projectCode, repository },
    global: { plugins: [ElementPlus] },
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T09:00:00+08:00'))
})

afterEach(() => {
  resetDemoBusinessContext()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('P1 Workforce 演示边界', () => {
  it('施工与交付组件使用同一共享演示仓储实例', async () => {
    const context = useDemoBusinessContext()
    const workforceSpy = vi.spyOn(context.workforce, 'getWorkforcePreview')
    const deliverySpy = vi.spyOn(context.workforce, 'getDeliveryPreview')

    mountComponent(WorkforceCenter)
    mountComponent(DeliveryWorkspace)
    await settle()

    expect(workforceSpy).toHaveBeenCalledWith('SY-2026-001')
    expect(deliverySpy).toHaveBeenCalledWith('SY-2026-001')
  })

  it('施工演示数据加载失败时显示错误并停止骨架屏', async () => {
    vi.spyOn(useDemoBusinessContext().workforce, 'getWorkforcePreview')
      .mockRejectedValue(new Error('施工演示数据加载失败'))
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="workforce-load-error"]').text()).toContain('施工演示数据加载失败')
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
  })

  it('Mock 只返回明确的 Demo view model，不访问规划接口或携带未冻结字段', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new MockWorkforceRepository()

    const result = await repository.getWorkforcePreview('SY-2026-001')

    expect(result.source).toBe('demo')
    expect(result.data.project_code).toBe('SY-2026-001')
    expect(result.data.labor_entries[0]?.day_fraction).toBe('0.500')
    expect(typeof result.data.labor_entries[0]?.day_fraction).toBe('string')
    expect(result.data.material_advances[0]?.status).toBe('partial')
    expect(JSON.stringify(result.data)).not.toMatch(
      /default_(?:pay_basis|rate_cents)|contract_allocation_id|confirmed_by|is_under_warranty/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('同项目同日期可一次保存日薪与时薪上工，并按费率固化成本', async () => {
    const repository = new MockWorkforceRepository()

    const result = await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-10',
      entries: [
        {
          assignment_id: 201,
          attendance_status: 'present',
          day_fraction: '1.000',
          work_minutes: null,
          work_summary: '设备机械安装',
          notes: null,
        },
        {
          assignment_id: 202,
          attendance_status: 'present',
          day_fraction: null,
          work_minutes: 480,
          work_summary: '电气回路调试',
          notes: null,
        },
      ],
    })

    expect(result.source).toBe('demo')
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignment_id: 201, work_date: '2026-09-10', cost_cents: 68000 }),
      expect.objectContaining({ assignment_id: 202, work_date: '2026-09-10', cost_cents: 76000 }),
    ]))

    const preview = await repository.getWorkforcePreview('SY-2026-001')
    expect(preview.data.labor_entries.filter((entry) => entry.work_date === '2026-09-10')).toHaveLength(2)
  })

  it('同人同日再次保存会更新而不重复，批量任一非法时完全不写入', async () => {
    const repository = new MockWorkforceRepository()
    await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-10',
      entries: [{
        assignment_id: 201,
        attendance_status: 'present',
        day_fraction: '1.000',
        work_minutes: null,
        work_summary: '初次保存',
        notes: null,
      }],
    })

    await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-10',
      entries: [{
        assignment_id: 203,
        attendance_status: 'present',
        day_fraction: '0.500',
        work_minutes: null,
        work_summary: '改为半天',
        notes: null,
      }],
    })

    const afterUpdate = await repository.getWorkforcePreview('SY-2026-001')
    const updated = afterUpdate.data.labor_entries.filter(
      (entry) => entry.work_date === '2026-09-10'
        && [201, 203].includes(entry.assignment_id),
    )
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      assignment_id: 203,
      day_fraction: '0.500',
      cost_cents: 32500,
      work_summary: '改为半天',
    })

    await expect(repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-11',
      entries: [
        {
          assignment_id: 201,
          attendance_status: 'present',
          day_fraction: '1.000',
          work_minutes: null,
          work_summary: '本条本可保存',
          notes: null,
        },
        {
          assignment_id: 202,
          attendance_status: 'present',
          day_fraction: null,
          work_minutes: 0,
          work_summary: '非法工时',
          notes: null,
        },
      ],
    })).rejects.toThrow('时薪上工分钟必须在 1 到 1440 之间')

    const afterRejectedBatch = await repository.getWorkforcePreview('SY-2026-001')
    expect(afterRejectedBatch.data.labor_entries.some((entry) => entry.work_date === '2026-09-11')).toBe(false)
  })

  it('时薪分钟边界允许 1 到 1440 分钟', async () => {
    const repository = new MockWorkforceRepository()
    const oneMinute = await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-12',
      entries: [{
        assignment_id: 202,
        attendance_status: 'present',
        day_fraction: null,
        work_minutes: 1,
        work_summary: null,
        notes: null,
      }],
    })
    const fullDay = await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-13',
      entries: [{
        assignment_id: 202,
        attendance_status: 'present',
        day_fraction: null,
        work_minutes: 1440,
        work_summary: null,
        notes: null,
      }],
    })

    expect(oneMinute.data[0]?.cost_cents).toBe(158)
    expect(fullDay.data[0]?.cost_cents).toBe(228000)
  })

  it('默认直接进入今日上工，可一次勾选多人统一保存，其他现场功能降为次要入口', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="workforce-center"]').text()).toContain('实时数据')
    expect(wrapper.text()).toContain('SY-2026-001')
    expect(wrapper.get('[data-testid="workforce-labor-panel"]').text()).toContain('今日上工')
    expect(wrapper.get('[data-testid="workforce-labor-panel"]').text()).toContain('王建国')
    expect(wrapper.get('[data-testid="workforce-labor-panel"]').text()).toContain('陈志强')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('保存今日上工（0人）')
    expect(wrapper.text()).toContain('添加项目工人')
    expect(wrapper.text()).toContain('新建施工员')
    expect(wrapper.text()).toContain('施工日报')
    expect(wrapper.text()).toContain('现场垫资')
    expect(wrapper.find('.el-tabs').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('P1 ·')
    expect(wrapper.text()).not.toContain('独立 Mock Repository')
    expect(wrapper.text()).not.toContain('当前仅供页面预览')

    await wrapper.get('[data-testid="labor-select-201"]').trigger('click')
    await wrapper.get('[data-testid="labor-select-202"]').trigger('click')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('保存今日上工（2人）')

    const rows = wrapper.findAll('.labor-row')
    await rows[0]?.get('input[placeholder="今天完成了什么"]').setValue('设备安装')
    await rows[1]?.get('input[placeholder="今天完成了什么"]').setValue('电气接线')
    await wrapper.get('[data-testid="workforce-save-labor"]').trigger('click')
    await settle()

    expect(wrapper.text()).toContain('已保存')
    expect(wrapper.text()).toContain('2 人上工记录')
    expect(wrapper.text()).toContain('设备安装')
    expect(wrapper.text()).toContain('电气接线')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('当天已作废的施工员不再出现在今日上工可提交列表', async () => {
    const repository = new MockWorkforceRepository()
    const preview = await repository.getWorkforcePreview('SY-2026-001')
    preview.data.labor_entries.unshift({
      entry_id: 999,
      assignment_id: 201,
      work_date: localISODate(),
      attendance_status: 'present',
      day_fraction: '1.000',
      work_minutes: null,
      work_summary: '已作废记录',
      notes: null,
      cost_cents: 68000,
      status: 'voided',
      void_reason: '录入错误',
    })
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue(preview)

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    expect(wrapper.find('[data-testid="labor-select-201"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="labor-select-202"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已作废记录')
  })

  it('今日上工写入成功但刷新失败时，明确告知已保存且不重提', async () => {
    const repository = new MockWorkforceRepository()
    const saveSpy = vi.spyOn(repository, 'saveLaborEntriesBatch')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    vi.spyOn(repository, 'getWorkforcePreview').mockRejectedValueOnce(new Error('刷新断线'))
    await wrapper.get('[data-testid="labor-select-201"]').trigger('click')
    await wrapper.get('[data-testid="workforce-save-labor"]').trigger('click')
    await settle()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('已保存但刷新失败')
    expect(wrapper.text()).not.toContain('保存失败')
  })

  it('施工员、项目排单、施工日报和现场垫资入口都能写入共享演示状态', async () => {
    const repository = useDemoBusinessContext().workforce
    const worker = await repository.createWorker({
      name: '赵师傅', phone: '13800138008', notes: '临时增援',
    })
    await repository.assignWorker('SY-2026-001', {
      worker_id: worker.data.worker_id,
      role: '现场安装', scheduled_start_on: '2026-09-10', scheduled_end_on: '2026-09-12',
      pay_basis: 'daily', rate_cents: 72000, notes: null,
    })
    await repository.saveSiteDailyReport('SY-2026-001', {
      work_date: '2026-09-10', location: '二号车间', weather: '晴', work_summary: '完成设备就位',
      blockers: null, next_plan: '开始接线', notes: null,
    })
    await repository.saveMaterialAdvance('SY-2026-001', {
      worker_id: worker.data.worker_id, spent_on: '2026-09-10', vendor_name: '园区五金店',
      items: [{ name: '扎带', specification: '5×300', brand: null, quantity: '2.000', unit: '包', unit_price_cents: 3500 }],
      notes: '现场急用', document_version_ids: [],
    })

    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    expect(preview.workers).toContainEqual(expect.objectContaining({ name: '赵师傅' }))
    expect(preview.crew_assignments).toContainEqual(expect.objectContaining({ role: '现场安装' }))
    expect(preview.site_daily_reports[0]).toMatchObject({ location: '二号车间', work_summary: '完成设备就位' })
    expect(preview.material_advances[0]).toMatchObject({ vendor_name: '园区五金店', status: 'unreimbursed' })
  })

  it('施工页的四个次要入口均打开可操作表单而非提示占位', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    await wrapper.get('[data-testid="worker-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="worker-create-dialog"]').text()).toContain('新建施工员')
    await wrapper.get('[data-testid="worker-create-dialog"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="assignment-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="assignment-create-dialog"]').text()).toContain('添加项目工人')
    await wrapper.get('[data-testid="assignment-create-dialog"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="daily-report-open"]').trigger('click')
    expect(wrapper.get('[data-testid="daily-report-dialog"]').text()).toContain('施工日报')
    await wrapper.get('[data-testid="daily-report-dialog"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="material-advance-open"]').trigger('click')
    expect(wrapper.get('[data-testid="material-advance-dialog"]').text()).toContain('现场垫资')
    expect(wrapper.text()).not.toContain('暂为演示入口')
  })

  it('新增排单只能选择仍在职的施工员', async () => {
    const repository = new MockWorkforceRepository()
    await repository.getWorkforcePreview('SY-2026-001')
    await repository.setWorkerStatus(102, 'inactive')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="assignment-create-open"]').trigger('click')
    await settle()
    await wrapper
      .get('[data-testid="assignment-create-dialog"] .el-select__wrapper')
      .trigger('click')
    await settle()
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
      .map((option) => option.textContent?.trim())

    expect(options).toContain('王建国')
    expect(options).not.toContain('陈志强')
  })

  it('现场业务日期默认当天并统一使用 Element Plus 日期选择器', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()
    const today = new Date()
    const expectedToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    await wrapper.get('[data-testid="assignment-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="assignment-start-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    expect((wrapper.get('[data-testid="assignment-end-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    await wrapper.get('[data-testid="assignment-create-dialog"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="daily-report-open"]').trigger('click')
    expect((wrapper.get('[data-testid="daily-report-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    await wrapper.get('[data-testid="daily-report-dialog"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="material-advance-open"]').trigger('click')
    expect((wrapper.get('[data-testid="material-advance-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    expect(wrapper.find('input[type="date"]').exists()).toBe(false)
  })

  it('今日施工支持全选人员和批量填写相同工作内容', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="workforce-today-summary"]').text()).toContain('可上工 2 人')
    await wrapper.get('[data-testid="labor-select-all"]').trigger('click')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('2人')
    await wrapper.get('[data-testid="labor-batch-summary"]').setValue('设备安装与回路联调')
    await wrapper.get('[data-testid="labor-apply-summary"]').trigger('click')
    expect((wrapper.get('[data-testid="labor-summary-201"]').element as HTMLInputElement).value).toBe('设备安装与回路联调')
    expect((wrapper.get('[data-testid="labor-summary-202"]').element as HTMLInputElement).value).toBe('设备安装与回路联调')
  })

  it('项目人员概况直接展示排期、首次和最近上工、累计次数与人工成本', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    const projectCrew = wrapper.get('[data-testid="project-crew-summary"]')
    expect(projectCrew.text()).toContain('本项目人员与历史')
    const wang = wrapper.get('[data-testid="project-worker-summary-201"]')
    expect(wang.text()).toContain('王建国')
    expect(wang.text()).toContain('2026-08-01 至 2026-09-30')
    expect(wang.text()).toContain('2026-09-03')
    expect(wang.text()).toContain('1 次')
    expect(wang.text()).toContain('¥340.00')
  })

  it('切换日期后回填当天记录并自动选中，状态和工资计算可直接修改', async () => {
    const repository = useDemoBusinessContext().workforce
    const saveSpy = vi.spyOn(repository, 'saveLaborEntriesBatch')
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    await wrapper.get('[aria-label="上工日期"]').setValue('2026-09-09')
    await settle()

    const row = wrapper.get('[data-testid="labor-row-202"]')
    expect(row.text()).toContain('已登记')
    expect(row.text()).toContain('¥95.00 × 8 小时 = ¥760.00')
    expect((wrapper.get('[data-testid="labor-summary-202"]').element as HTMLInputElement).value)
      .toBe('控制柜接线检查')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('1人')

    await wrapper.getComponent('[data-testid="labor-attendance-202"]').setValue('leave')
    expect(row.text()).toContain('不计薪 = ¥0.00')
    await wrapper.get('[data-testid="workforce-save-labor"]').trigger('click')
    await settle()

    expect(saveSpy).toHaveBeenLastCalledWith('SY-2026-001', expect.objectContaining({
      work_date: '2026-09-09',
      entries: [expect.objectContaining({
        assignment_id: 202,
        attendance_status: 'leave',
        day_fraction: null,
        work_minutes: null,
      })],
    }))
  })

  it('今日上工逐人显示日薪或时薪的计算过程与预计金额', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="labor-row-201"]').text())
      .toContain('¥680.00 × 全天 = ¥680.00')
    expect(wrapper.get('[data-testid="labor-row-202"]').text())
      .toContain('¥95.00 × 8 小时 = ¥760.00')
  })

  it('可上工人员只包含在职且处于所选日期排期内的人员', async () => {
    await useDemoBusinessContext().workforce.getWorkforcePreview('SY-2026-001')
    await useDemoBusinessContext().workforce.setWorkerStatus(102, 'inactive')
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="workforce-today-summary"]').text()).toContain('可上工 1 人')
    await wrapper.get('[data-testid="labor-select-all"]').trigger('click')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('1人')

    await wrapper.get('[aria-label="上工日期"]').setValue('2026-10-01')
    await settle()
    expect(wrapper.get('[data-testid="workforce-today-summary"]').text()).toContain('可上工 0 人')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('0人')
  })

  it('支持人员、派工、工时、日报和报销的完整演示操作', async () => {
    const repository = new MockWorkforceRepository()
    await repository.getWorkforcePreview('SY-2026-001')

    await repository.updateWorker(101, { name: '王建国（班组长）', phone: '13800138001', notes: '负责机械组' })
    await repository.setWorkerStatus(102, 'inactive')
    await repository.setCrewAssignmentStatus('SY-2026-001', 202, 'active')
    await repository.updateLaborEntry('SY-2026-001', 301, {
      assignment_id: 201, work_date: '2026-09-03', attendance_status: 'present',
      day_fraction: '1.000', work_minutes: null, work_summary: '已核对为全天', notes: null,
    })
    await repository.voidLaborEntry('SY-2026-001', 302, '重复登记')
    await repository.confirmSiteDailyReport('SY-2026-001', '2026-09-09')
    await repository.recordMaterialAdvanceReimbursement('SY-2026-001', 401, {
      amount_cents: 74000, reimbursed_on: '2026-09-10', payment_method: 'bank_transfer', notes: '结清',
    })

    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    expect(preview.workers.find((item) => item.worker_id === 101)).toMatchObject({ name: '王建国（班组长）', notes: '负责机械组' })
    expect(preview.workers.find((item) => item.worker_id === 102)?.status).toBe('inactive')
    expect(preview.crew_assignments.find((item) => item.assignment_id === 202)?.status).toBe('active')
    expect(preview.labor_entries.find((item) => item.entry_id === 301)).toMatchObject({ day_fraction: '1.000', cost_cents: 68000, work_summary: '已核对为全天', status: 'active' })
    expect(preview.labor_entries.find((item) => item.entry_id === 302)).toMatchObject({ status: 'voided', void_reason: '重复登记', cost_cents: 0 })
    expect(preview.site_daily_reports[0]).toMatchObject({ status: 'confirmed' })
    expect(preview.material_advances[0]).toMatchObject({ status: 'reimbursed' })
    expect(preview.material_advances[0]?.reimbursements).toHaveLength(2)
  })

  it('施工管理展示排单流转与历史上工编辑作废入口', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="worker-edit-101"]').text()).toContain('编辑')
    expect(wrapper.get('[data-testid="worker-deactivate-101"]').text()).toContain('停用')
    expect(wrapper.get('[data-testid="assignment-start-202"]').text()).toContain('开始')
    expect(wrapper.get('[data-testid="assignment-complete-201"]').text()).toContain('完成')
    expect(wrapper.get('[data-testid="assignment-cancel-201"]').text()).toContain('取消')
    expect(wrapper.get('[data-testid="labor-edit-301"]').text()).toContain('编辑')
    expect(wrapper.get('[data-testid="labor-void-301"]').text()).toContain('作废')
    expect(wrapper.get('[data-testid="report-confirm-2026-09-09"]').text()).toContain('确认')
    expect(wrapper.get('[data-testid="reimbursement-open-401"]').text()).toContain('报销')
  })

  it('已停用施工员可重新启用，排单可开始并刷新页面状态', async () => {
    const repository = new MockWorkforceRepository()
    await repository.getWorkforcePreview('SY-2026-001')
    await repository.setWorkerStatus(102, 'inactive')
    const workerSpy = vi.spyOn(repository, 'setWorkerStatus')
    const assignmentSpy = vi.spyOn(repository, 'setCrewAssignmentStatus')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="worker-reactivate-102"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="assignment-start-202"]').trigger('click')
    await settle()

    expect(workerSpy).toHaveBeenCalledWith(102, 'active')
    expect(assignmentSpy).toHaveBeenCalledWith('SY-2026-001', 202, 'active', null)
  })

  it('完成排单必须在对话框确认，原因留空时提交 null', async () => {
    const repository = new MockWorkforceRepository()
    const assignmentSpy = vi.spyOn(repository, 'setCrewAssignmentStatus')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="assignment-complete-201"]').trigger('click')
    await settle()
    expect(assignmentSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="assignment-transition-dialog"]').text()).toContain('确认完成排单')

    await wrapper.get('[data-testid="assignment-transition-dialog"] form').trigger('submit')
    await settle()

    expect(assignmentSpy).toHaveBeenCalledWith(
      'SY-2026-001',
      201,
      'completed',
      null,
    )
  })

  it('取消排单必须二次确认且填写真实原因', async () => {
    const repository = new MockWorkforceRepository()
    const assignmentSpy = vi.spyOn(repository, 'setCrewAssignmentStatus')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="assignment-cancel-202"]').trigger('click')
    await settle()
    expect(assignmentSpy).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="assignment-transition-dialog"] form').trigger('submit')
    await settle()
    expect(assignmentSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="assignment-transition-error"]').text()).toContain('请填写取消原因')

    await wrapper.get('[data-testid="assignment-transition-reason"] textarea').setValue('客户要求暂停进场')
    await wrapper.get('[data-testid="assignment-transition-dialog"] form').trigger('submit')
    await settle()

    expect(assignmentSpy).toHaveBeenCalledWith(
      'SY-2026-001',
      202,
      'cancelled',
      '客户要求暂停进场',
    )
  })

  it('历史上工可编辑并作废，已作废记录不再显示操作', async () => {
    const repository = new MockWorkforceRepository()
    const updateSpy = vi.spyOn(repository, 'updateLaborEntry')
    const voidSpy = vi.spyOn(repository, 'voidLaborEntry')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="labor-edit-301"]').trigger('click')
    expect(wrapper.get('[data-testid="labor-edit-dialog"]').text()).toContain('编辑上工记录')
    await wrapper.get('[data-testid="labor-edit-summary"] textarea').setValue('已核对当日工作')
    await wrapper.get('[data-testid="labor-edit-dialog"] form').trigger('submit')
    await settle()
    expect(updateSpy).toHaveBeenCalledWith('SY-2026-001', 301, expect.objectContaining({
      work_summary: '已核对当日工作',
    }))

    await wrapper.get('[data-testid="labor-void-302"]').trigger('click')
    await wrapper.get('[data-testid="labor-void-reason"] textarea').setValue('重复登记')
    await wrapper.get('[data-testid="labor-void-dialog"] form').trigger('submit')
    await settle()
    expect(voidSpy).toHaveBeenCalledWith('SY-2026-001', 302, '重复登记')
    expect(wrapper.find('[data-testid="labor-edit-302"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="labor-void-302"]').exists()).toBe(false)
  })
})

describe('P2 交付售后演示边界', () => {
  it('交付演示数据加载失败时显示错误并停止骨架屏', async () => {
    vi.spyOn(useDemoBusinessContext().workforce, 'getDeliveryPreview')
      .mockRejectedValue(new Error('交付演示数据加载失败'))
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    expect(wrapper.get('[data-testid="delivery-load-error"]').text()).toContain('交付演示数据加载失败')
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
  })

  it('Mock 保留契约枚举和只读派生状态，不访问规划接口', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const repository = new MockWorkforceRepository()

    const result = await repository.getDeliveryPreview('SY-2026-001')

    expect(result.source).toBe('demo')
    expect(result.data.drawing_signoffs.map((item) => item.discipline)).toEqual([
      'mechanical',
      'electrical',
    ])
    expect(result.data.warranty?.status).toBe('active')
    expect(result.data.engineering_changes[0]?.estimated_cost_delta_cents).toBeTypeOf('number')
    expect(JSON.stringify(result.data)).not.toMatch(
      /actual_cost_delta_cents|contract_allocation_id|confirmed_by|is_under_warranty/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按会签调试、变更、验收质保和发票售后分区，并明确禁止推导语义', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    expect(wrapper.get('[data-testid="delivery-workspace"]').text()).toContain('实时数据')
    expect(wrapper.find('.delivery-section-nav').exists()).toBe(true)
    expect(wrapper.find('.el-tabs').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('P2 ·')
    expect(wrapper.text()).not.toContain('当前仅供页面预览')
    expect(wrapper.text()).not.toContain('规划接口未调用')
    expect(wrapper.text()).toContain('SY-2026-001')
    expect(wrapper.get('[data-testid="delivery-commissioning-panel"]').text()).toContain('无需图纸')
    expect(wrapper.get('[data-testid="delivery-commissioning-panel"]').text()).toContain('附件不是前提')

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    const changes = wrapper.get('[data-testid="delivery-changes-panel"]').text()
    expect(changes).toContain('预测成本变化')
    expect(changes).toContain('不计入实际成本')

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    const acceptance = wrapper.get('[data-testid="delivery-acceptance-panel"]')
    expect(acceptance.text()).toContain('质保状态由后端日期规则返回')
    expect(acceptance.text()).toContain('生效中')
    expect(acceptance.find('input').exists()).toBe(false)

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    const afterSales = wrapper.get('[data-testid="delivery-after-sales-panel"]').text()
    expect(afterSales).toContain('发票记录独立于收款')
    expect(afterSales).toContain('保内处理')
    expect(afterSales).not.toContain('是否在保')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('交付页每个分区都有新增或更新入口并写入共享演示状态', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    expect(wrapper.get('[data-testid="signoff-edit-mechanical"]').text()).toContain('更新')
    expect(wrapper.get('[data-testid="commissioning-create-open"]').text()).toContain('新增调试')

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    expect(wrapper.get('[data-testid="change-create-open"]').text()).toContain('新增变更')

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.get('[data-testid="acceptance-create-open"]').text()).toContain('新增验收')

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.get('[data-testid="invoice-create-open"]').text()).toContain('登记发票')
    expect(wrapper.get('[data-testid="after-sales-create-open"]').text()).toContain('新增售后')
  })

  it('调试、变更、验收、发票和售后表单按业务动作预填当天', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()
    const today = new Date()
    const expectedToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="commissioning-started-at"] input').element as HTMLInputElement).value).toMatch(new RegExp(`^${expectedToday}`))
    await wrapper.get('[aria-label="新增调试记录"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="engineering-change-date"] input').element as HTMLInputElement).value).toBe(expectedToday)

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    await wrapper.get('[data-testid="acceptance-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="acceptance-scheduled-date"] input').element as HTMLInputElement).value).toBe(expectedToday)

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="invoice-recorded-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="after-sales-reported-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    expect(wrapper.find('input[type="date"]').exists()).toBe(false)
    expect(wrapper.find('input[type="datetime-local"]').exists()).toBe(false)
  })

  it('新增调试使用当前时间和进行中状态，可直接保存为演示记录', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    await wrapper.get('[aria-label="新增调试记录"] form').trigger('submit')
    await settle()

    expect(wrapper.text()).toContain('调试记录已新增')
    expect(wrapper.get('[aria-label="新增调试记录"]').isVisible()).toBe(false)
  })

  it('交付写入成功但刷新失败时，先关闭表单并禁止误导重提', async () => {
    const repository = new MockWorkforceRepository()
    const saveSpy = vi.spyOn(repository, 'saveCommissioningSession')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    vi.spyOn(repository, 'getDeliveryPreview').mockRejectedValueOnce(new Error('刷新断线'))
    await wrapper.get('[aria-label="新增调试记录"] form').trigger('submit')
    await settle()

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[aria-label="新增调试记录"]').isVisible()).toBe(false)
    expect(wrapper.text()).toContain('已保存但刷新失败')
    expect(wrapper.text()).not.toContain('保存失败')
  })

  it('质保续费价格 null 显示未设置，编辑为空且提交仍为 null', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getDeliveryPreview('SY-2026-001')).data
    if (!preview.warranty) throw new Error('测试质保数据不存在')
    preview.warranty.renewal_price_cents = null
    vi.spyOn(repository, 'getDeliveryPreview').mockResolvedValue({ source: 'demo', data: preview })
    const updateSpy = vi.spyOn(repository, 'updateWarranty').mockResolvedValue()
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.get('[data-testid="delivery-acceptance-panel"]').text()).toContain('续费价格未设置')
    await wrapper.get('[data-testid="warranty-edit-open"]').trigger('click')
    expect((wrapper.get('[data-testid="warranty-renewal-price"]').element as HTMLInputElement).value).toBe('')
    await wrapper.get('[aria-label="编辑质保"] form').trigger('submit')
    await settle()

    expect(updateSpy).toHaveBeenCalledWith('SY-2026-001', expect.objectContaining({ renewal_price_cents: null }))
  })

  it('支持调试编辑、变更流转、验收完成、质保编辑、发票作废和售后流转', async () => {
    const repository = new MockWorkforceRepository()

    await repository.updateCommissioningSession('SY-2026-001', 601, {
      started_at: '2026-09-20T01:00:00+00:00', ended_at: '2026-09-20T06:00:00+00:00', status: 'completed',
      summary: '复测通过', issues: null, next_action: '转验收', notes: null, document_version_ids: [],
    })
    await repository.setEngineeringChangeStatus('SY-2026-001', 701, 'implemented')
    await repository.completeAcceptance('SY-2026-001', 801, {
      status: 'passed', performed_on: '2026-10-09', notes: '整改项已关闭',
    })
    await repository.updateWarranty('SY-2026-001', {
      starts_on: '2026-10-09', duration_months: 18, renewal_price_cents: 4200000, notes: '延长质保',
    })
    await repository.voidInvoice('SY-2026-001', 901, '开票信息有误')
    await repository.setAfterSalesStatus('SY-2026-001', 1001, 'completed', '已更换接近开关并复测')

    const preview = (await repository.getDeliveryPreview('SY-2026-001')).data
    expect(preview.commissioning_sessions[0]).toMatchObject({ status: 'completed', summary: '复测通过', ended_at: '2026-09-20T06:00:00+00:00' })
    expect(preview.engineering_changes[0]?.status).toBe('implemented')
    expect(preview.acceptances[0]).toMatchObject({ status: 'passed', performed_on: '2026-10-09', notes: '整改项已关闭' })
    expect(preview.warranty).toMatchObject({ starts_on: '2026-10-09', duration_months: 18, ends_on: '2028-04-09', renewal_price_cents: 4200000 })
    expect(preview.invoices[0]).toMatchObject({ status: 'void', void_reason: '开票信息有误' })
    expect(preview.after_sales[0]).toMatchObject({ status: 'completed', resolution: '已更换接近开关并复测' })
  })

  it('交付管理操作在各分区都有明确的演示入口', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    expect(wrapper.get('[data-testid="commissioning-edit-601"]').text()).toContain('编辑')
    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    expect(wrapper.find('[data-testid="change-status-701"]').exists()).toBe(true)
    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.get('[data-testid="acceptance-complete-801"]').text()).toContain('完成验收')
    expect(wrapper.get('[data-testid="warranty-edit-open"]').text()).toContain('编辑质保')
    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.get('[data-testid="invoice-void-901"]').text()).toContain('作废')
    expect(wrapper.find('[data-testid="after-sales-status-1001"]').exists()).toBe(true)
  })
})
