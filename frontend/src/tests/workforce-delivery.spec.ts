import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api'
import DeliveryWorkspace from '../components/delivery/DeliveryWorkspace.vue'
import WorkforceCenter from '../components/workforce/WorkforceCenter.vue'
import { localISODate } from '../domain/dates'
import { resetDemoBusinessContext, useDemoBusinessContext } from '../repositories/demo-context'
import type { DeliveryWorkspaceRepository } from '../repositories/delivery.live'
import { MockWorkforceRepository } from '../repositories/workforce'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function mountComponent(
  component: object,
  projectCode = 'SY-2026-001',
  repository: MockWorkforceRepository = useDemoBusinessContext().workforce,
  readonly = false,
): VueWrapper {
  return mount(component, {
    attachTo: document.body,
    props: { projectCode, repository, readonly },
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

    expect(wrapper.get('[data-testid="workforce-center"]').text()).not.toContain('实时数据')
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

  it('当天上工记录作废后仍可重新选择并录入', async () => {
    const repository = new MockWorkforceRepository()
    const preview = await repository.getWorkforcePreview('SY-2026-001')
    preview.data.labor_entries.unshift({
      entry_id: 999,
      assignment_id: 201,
      replaces_entry_id: null,
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

    expect(wrapper.find('[data-testid="labor-select-201"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="labor-select-202"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已作废记录')
  })

  it('作废后更正会新增有效记录并永久保留原作废证据', async () => {
    const repository = new MockWorkforceRepository()
    const created = await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-10',
      entries: [{
        assignment_id: 201, attendance_status: 'present', day_fraction: '1.000',
        work_minutes: null, work_summary: 'A：错误记录', notes: null,
      }],
    })
    const voidedId = created.data[0]!.entry_id
    await repository.voidLaborEntry('SY-2026-001', voidedId, '工时录错')

    const replacement = await repository.saveLaborEntriesBatch('SY-2026-001', {
      work_date: '2026-09-10',
      entries: [{
        assignment_id: 201, attendance_status: 'present', day_fraction: '0.500',
        work_minutes: null, work_summary: 'B：更正记录', notes: null,
      }],
    })
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data

    expect(replacement.data[0]).toMatchObject({
      status: 'active', replaces_entry_id: voidedId, work_summary: 'B：更正记录',
    })
    expect(replacement.data[0]!.entry_id).not.toBe(voidedId)
    expect(preview.labor_entries.find((entry) => entry.entry_id === voidedId)).toMatchObject({
      status: 'voided', void_reason: '工时录错', work_summary: 'A：错误记录',
    })
    await expect(repository.updateLaborEntry(
      'SY-2026-001',
      replacement.data[0]!.entry_id,
      {
        assignment_id: 201,
        work_date: '2026-09-11',
        attendance_status: 'present',
        day_fraction: '0.500',
        work_minutes: null,
        work_summary: '错误移动日期',
        notes: null,
      },
    )).rejects.toThrow('补录记录不能修改施工员或上工日期')

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()
    expect(wrapper.text()).toContain(`更正自记录 #${voidedId}`)
    await wrapper.get(`[data-testid="labor-edit-${replacement.data[0]!.entry_id}"]`).trigger('click')
    const editDialog = wrapper.get('[data-testid="labor-edit-dialog"]')
    expect(editDialog.get('[data-testid="labor-replacement-identity-notice"]').text())
      .toContain('身份错误请先作废，再重新登记')
    expect(editDialog.get('[data-testid="labor-edit-assignment"]').get('input').attributes('disabled')).toBeDefined()
    expect(editDialog.get('[data-testid="labor-edit-date"]').get('input').attributes('disabled')).toBeDefined()
  })

  it('日报重开修改后仍展示上次确认时的不可变正文', async () => {
    const repository = new MockWorkforceRepository()
    await repository.saveSiteDailyReport('SY-2026-001', {
      work_date: '2026-09-10', location: '一号车间', weather: '晴',
      work_summary: 'A：确认时正文', blockers: null, next_plan: '继续安装', notes: null,
    })
    await repository.confirmSiteDailyReport('SY-2026-001', '2026-09-10')
    await repository.reopenSiteDailyReport('SY-2026-001', '2026-09-10', '补充漏项')
    await repository.saveSiteDailyReport('SY-2026-001', {
      work_date: '2026-09-10', location: '二号车间', weather: '雨',
      work_summary: 'B：重开后正文', blockers: null, next_plan: '复查', notes: null,
    })

    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    expect(preview.site_daily_reports[0]?.work_summary).toBe('B：重开后正文')
    expect(preview.site_daily_reports[0]?.versions).toEqual([
      expect.objectContaining({ version_number: 1, work_summary: 'A：确认时正文' }),
    ])
    expect(preview.site_daily_reports[0]?.events.map((event) => event.report_version_id)).toEqual([
      preview.site_daily_reports[0]?.versions[0]?.id,
      preview.site_daily_reports[0]?.versions[0]?.id,
    ])

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()
    expect(wrapper.text()).toContain('确认版本 V1')
    expect(wrapper.text()).toContain('A：确认时正文')
    expect(wrapper.text()).toContain('B：重开后正文')
    expect(wrapper.text()).toContain('重新打开：补充漏项')
  })

  it('旧库多轮日报事件全部可见且明确标记迁移前无快照', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    preview.site_daily_reports = [{
      work_date: '2026-09-08',
      location: '一号车间',
      weather: '晴',
      work_summary: '第二轮确认后的正文',
      blockers: null,
      next_plan: null,
      notes: null,
      status: 'confirmed',
      versions: [{
        id: 902,
        version_number: 2,
        work_date: '2026-09-08',
        location: '一号车间',
        weather: '晴',
        work_summary: '第二轮确认后的正文',
        blockers: null,
        next_plan: null,
        notes: null,
        confirmed_at: '2026-09-08T10:00:00+08:00',
        created_at: '2026-09-08T10:00:00+08:00',
      }],
      events: [
        {
          id: 1,
          from_status: 'draft',
          to_status: 'confirmed',
          reason: null,
          occurred_at: '2026-09-08T08:00:00+08:00',
          created_at: '2026-09-08T08:00:00+08:00',
          report_version_id: null,
        },
        {
          id: 2,
          from_status: 'confirmed',
          to_status: 'draft',
          reason: '第一次补录',
          occurred_at: '2026-09-08T09:00:00+08:00',
          created_at: '2026-09-08T09:00:00+08:00',
          report_version_id: null,
        },
        {
          id: 3,
          from_status: 'draft',
          to_status: 'confirmed',
          reason: null,
          occurred_at: '2026-09-08T10:00:00+08:00',
          created_at: '2026-09-08T10:00:00+08:00',
          report_version_id: 902,
        },
      ],
    }, {
      work_date: '2026-09-09',
      location: '二号车间',
      weather: '雨',
      work_summary: '重开后的当前草稿',
      blockers: null,
      next_plan: null,
      notes: null,
      status: 'draft',
      versions: [],
      events: [
        {
          id: 4,
          from_status: 'draft',
          to_status: 'confirmed',
          reason: null,
          occurred_at: '2026-09-09T08:00:00+08:00',
          created_at: '2026-09-09T08:00:00+08:00',
          report_version_id: null,
        },
        {
          id: 5,
          from_status: 'confirmed',
          to_status: 'draft',
          reason: '迁移前最后一次重开',
          occurred_at: '2026-09-09T09:00:00+08:00',
          created_at: '2026-09-09T09:00:00+08:00',
          report_version_id: null,
        },
      ],
    }]
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    expect(wrapper.text()).toContain('确认版本 V2')
    expect(wrapper.findAll('[data-testid="report-legacy-event"]')).toHaveLength(4)
    expect(wrapper.text().match(/迁移前无快照/g)).toHaveLength(4)
    expect(wrapper.text()).toContain('第一次补录')
    expect(wrapper.text()).toContain('迁移前最后一次重开')
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

  it('没有有效排单时只提示先添加人员，不展示一排无法使用的上工按钮', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    preview.workers = []
    preview.crew_assignments = []
    preview.labor_entries = []
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    expect(wrapper.get('[data-testid="workforce-header-actions"]').findAll('button').map((button) => button.text()))
      .toEqual(['施工日报', '添加项目工人', '新建施工员'])
    expect(wrapper.get('[data-testid="workforce-empty-attendance"]').text()).toContain('先新建施工员')
    expect(wrapper.find('[data-testid="labor-select-all"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="labor-batch-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workforce-save-labor"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="material-advance-open"]').exists()).toBe(false)
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
    expect(wrapper.get('[data-testid="labor-attendance-201"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="labor-summary-201"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="labor-select-201"]').trigger('click')
    expect(wrapper.get('[data-testid="labor-attendance-201"] input').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="labor-summary-201"]').attributes('disabled')).toBeUndefined()
    await wrapper.getComponent('[data-testid="labor-attendance-201"]').setValue('leave')
    await wrapper.get('[data-testid="labor-select-all"]').trigger('click')
    expect(wrapper.get('[data-testid="workforce-save-labor"]').text()).toContain('2人')
    const attendance = wrapper.findAllComponents({ name: 'ElSelect' }).find(
      (item) => item.attributes('data-testid') === 'labor-attendance-201',
    )
    expect(attendance?.props('modelValue')).toBe('present')
    await wrapper.get('[data-testid="labor-batch-summary"]').setValue('设备安装与回路联调')
    await wrapper.get('[data-testid="labor-apply-summary"]').trigger('click')
    expect((wrapper.get('[data-testid="labor-summary-201"]').element as HTMLInputElement).value).toBe('设备安装与回路联调')
    expect((wrapper.get('[data-testid="labor-summary-202"]').element as HTMLInputElement).value).toBe('设备安装与回路联调')
  })

  it('未勾选的施工员不能误填后被静默丢弃，逐人字段带姓名', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    const attendance = wrapper.get('[data-testid="labor-attendance-202"]')
    const summary = wrapper.get('[data-testid="labor-summary-202"]')
    expect(attendance.get('input').attributes('disabled')).toBeDefined()
    expect(summary.attributes('disabled')).toBeDefined()
    expect(attendance.get('input').attributes('aria-label')).toBe('陈志强的到场状态')
    expect(summary.attributes('aria-label')).toBe('陈志强的工作内容')

    await wrapper.get('[data-testid="labor-select-202"]').trigger('click')
    expect(attendance.get('input').attributes('disabled')).toBeUndefined()
    expect(summary.attributes('disabled')).toBeUndefined()
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
    expect(wrapper.get('[data-testid="workforce-empty-attendance"]').text()).toContain('当前日期没有可上工的项目人员')
    expect(wrapper.find('[data-testid="workforce-save-labor"]').exists()).toBe(false)
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
    expect(preview.labor_entries.find((item) => item.entry_id === 302)).toMatchObject({ status: 'voided', void_reason: '重复登记', cost_cents: 76000 })
    expect(preview.site_daily_reports[0]).toMatchObject({ status: 'confirmed' })
    expect(preview.material_advances[0]).toMatchObject({ status: 'reimbursed' })
    expect(preview.material_advances[0]?.reimbursements).toHaveLength(2)
  })

  it('施工管理高频动作直接展示，不藏在通用操作下拉中', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="worker-edit-101"]').text()).toContain('编辑')
    expect(wrapper.get('[data-testid="worker-deactivate-101"]').text()).toContain('停用')
    expect(wrapper.get('[data-testid="assignment-edit-202"]').text()).toContain('编辑')
    expect(wrapper.get('[data-testid="assignment-start-202"]').text()).toContain('开始')
    expect(wrapper.get('[data-testid="labor-edit-301"]').text()).toContain('编辑')
    expect(wrapper.get('[data-testid="labor-void-301"]').text()).toContain('作废')
    expect(wrapper.find('[data-testid^="worker-actions-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="assignment-actions-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="labor-actions-"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="report-confirm-2026-09-09"]').text()).toContain('确认')
    expect(wrapper.get('[data-testid="reimbursement-open-401"]').text()).toContain('报销')
  })

  it('行级高频按钮的无障碍名称包含施工员或记录对象', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    expect(wrapper.get('[data-testid="worker-edit-101"]').attributes('aria-label')).toBe('编辑施工员 王建国')
    expect(wrapper.get('[data-testid="worker-deactivate-101"]').attributes('aria-label')).toBe('停用施工员 王建国')
    expect(wrapper.get('[data-testid="assignment-edit-202"]').attributes('aria-label')).toContain('陈志强')
    expect(wrapper.get('[data-testid="assignment-start-202"]').attributes('aria-label')).toContain('陈志强')
    expect(wrapper.get('[data-testid="assignment-complete-201"]').attributes('aria-label')).toContain('王建国')
    expect(wrapper.get('[data-testid="assignment-cancel-202"]').attributes('aria-label')).toContain('陈志强')
    expect(wrapper.get('[data-testid="labor-edit-301"]').attributes('aria-label')).toBe('编辑王建国 2026-09-03 上工记录')
    expect(wrapper.get('[data-testid="labor-void-301"]').attributes('aria-label')).toBe('作废王建国 2026-09-03 上工记录')
    expect(wrapper.get('[data-testid="report-confirm-2026-09-09"]').attributes('aria-label')).toBe('确认 2026-09-09 施工日报')
    expect(wrapper.get('[data-testid="reimbursement-open-401"]').attributes('aria-label')).toContain('园区五金机电商行')
    expect(wrapper.get('[data-testid="reimbursement-void-401-1"]').attributes('aria-label')).toContain('园区五金机电商行')
  })

  it('计划中和进行中的排单可从原数据进入编辑并保存', async () => {
    const repository = new MockWorkforceRepository()
    const updateSpy = vi.spyOn(repository, 'updateCrewAssignment')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="assignment-edit-202"]').trigger('click')
    const dialog = wrapper.get('[data-testid="assignment-edit-dialog"]')
    expect(dialog.text()).toContain('编辑项目排单')
    expect((dialog.get('[data-testid="assignment-role"] input').element as HTMLInputElement).value)
      .toBe('电气调试')
    await dialog.get('[data-testid="assignment-role"] input').setValue('电气安装')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(updateSpy).toHaveBeenCalledWith('SY-2026-001', 202, expect.objectContaining({
      role: '电气安装',
    }))
    expect(wrapper.get('[data-testid="project-worker-summary-202"]').text()).toContain('电气安装')
  })

  it('确认日报必须二次确认，确认后可填写原因重新打开', async () => {
    const repository = new MockWorkforceRepository()
    const confirmSpy = vi.spyOn(repository, 'confirmSiteDailyReport')
    const reopenSpy = vi.spyOn(repository, 'reopenSiteDailyReport')
    vi.spyOn(ElMessageBox, 'confirm')
      .mockImplementation(() => Promise.resolve('confirm') as ReturnType<typeof ElMessageBox.confirm>)
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="report-confirm-2026-09-09"]').trigger('click')
    await settle()
    expect(ElMessageBox.confirm).toHaveBeenCalledWith(
      expect.stringContaining('确认后将锁定'),
      '确认施工日报',
      expect.objectContaining({ type: 'warning' }),
    )
    expect(confirmSpy).toHaveBeenCalledWith('SY-2026-001', '2026-09-09')

    await wrapper.get('[data-testid="report-reopen-2026-09-09"]').trigger('click')
    const dialog = wrapper.get('[data-testid="report-reopen-dialog"]')
    await dialog.get('[data-testid="report-reopen-reason"] textarea').setValue('补充现场遗漏事项')
    await dialog.get('form').trigger('submit')
    await settle()
    expect(reopenSpy).toHaveBeenCalledWith('SY-2026-001', '2026-09-09', '补充现场遗漏事项')
    expect(wrapper.get('[data-testid="report-row-2026-09-09"]').text()).toContain('待确认')
  })

  it('垫资显示每笔报销明细，未报销垫资可编辑作废，有效报销可冲销', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    preview.material_advances.push({
      ...structuredClone(preview.material_advances[0]!),
      advance_id: 402,
      status: 'unreimbursed',
      reimbursements: [],
    })
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })
    const updateSpy = vi.spyOn(repository, 'updateMaterialAdvance')
    const voidAdvanceSpy = vi.spyOn(repository, 'voidMaterialAdvance')
    const voidReimbursementSpy = vi.spyOn(repository, 'voidMaterialAdvanceReimbursement')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    const reimbursed = wrapper.get('[data-testid="advance-row-401"]')
    expect(reimbursed.text()).toContain('¥1,000.00')
    expect(reimbursed.text()).toContain('2026-09-08')
    expect(reimbursed.text()).toContain('银行转账')
    expect(reimbursed.text()).toContain('首笔报销')
    expect(reimbursed.text()).toContain('有效')

    await wrapper.get('[data-testid="advance-edit-402"]').trigger('click')
    const editDialog = wrapper.get('[data-testid="material-advance-edit-dialog"]')
    await editDialog.get('[data-testid="advance-vendor"] input').setValue('更正后的五金店')
    await editDialog.get('form').trigger('submit')
    await settle()
    expect(updateSpy).toHaveBeenCalledWith('SY-2026-001', 402, expect.objectContaining({
      vendor_name: '更正后的五金店',
    }))

    await wrapper.get('[data-testid="advance-void-402"]').trigger('click')
    const voidAdvanceDialog = wrapper.get('[data-testid="advance-void-dialog"]')
    await voidAdvanceDialog.get('[data-testid="advance-void-reason"] textarea').setValue('重复登记')
    await voidAdvanceDialog.get('form').trigger('submit')
    await settle()
    expect(voidAdvanceSpy).toHaveBeenCalledWith('SY-2026-001', 402, '重复登记')

    await wrapper.get('[data-testid="reimbursement-void-401-1"]').trigger('click')
    const voidReimbursementDialog = wrapper.get('[data-testid="reimbursement-void-dialog"]')
    await voidReimbursementDialog.get('[data-testid="reimbursement-void-reason"] textarea')
      .setValue('支付方式填错')
    await voidReimbursementDialog.get('form').trigger('submit')
    await settle()
    expect(voidReimbursementSpy).toHaveBeenCalledWith('SY-2026-001', 401, 1, '支付方式填错')
  })

  it('切换项目或仓储会关闭施工弹窗与确认框，迟到确认不得串项目写入', async () => {
    const confirmation = deferred<unknown>()
    vi.spyOn(ElMessageBox, 'confirm')
      .mockReturnValue(confirmation.promise as ReturnType<typeof ElMessageBox.confirm>)
    const closeSpy = vi.spyOn(ElMessageBox, 'close')
    const repository = new MockWorkforceRepository()
    const nextRepository = new MockWorkforceRepository()
    const confirmSpy = vi.spyOn(repository, 'confirmSiteDailyReport')
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()
    closeSpy.mockClear()

    await wrapper.get('[data-testid="daily-report-open"]').trigger('click')
    await wrapper.get('[data-testid="report-confirm-2026-09-09"]').trigger('click')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-2026-002', repository: nextRepository })
    await settle()

    expect(wrapper.get('[data-testid="daily-report-dialog"]').isVisible()).toBe(false)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    confirmation.resolve('confirm')
    await settle()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('完整展示每条施工日报和现场垫资，空台账不出现报销操作', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    preview.site_daily_reports.push({
      ...preview.site_daily_reports[0]!,
      work_date: '2026-09-08',
      work_summary: '较早日报',
    })
    preview.material_advances.push({
      ...preview.material_advances[0]!,
      advance_id: 402,
      spent_on: '2026-09-04',
      vendor_name: '较早五金店',
      status: 'unreimbursed',
      reimbursements: [],
    })
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    expect(wrapper.find('[data-testid="report-row-2026-09-09"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="report-row-2026-09-08"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="advance-row-401"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="advance-row-402"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reimbursement-open-402"]').exists()).toBe(true)

    preview.material_advances = []
    const empty = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()
    expect(empty.findAll('[data-testid^="reimbursement-open-"]')).toHaveLength(0)
  })

  it('现场垫资只能选择所选日期在本项目有效排单的人员', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    preview.workers.push({ worker_id: 103, name: '未排单人员', phone: null, notes: null, status: 'active' })
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="material-advance-open"]').trigger('click')
    const dialog = wrapper.get('[data-testid="material-advance-dialog"]')
    await dialog.get('.el-select__wrapper').trigger('click')
    const optionText = [...document.body.querySelectorAll('.el-select-dropdown__item')]
      .map((item) => item.textContent)
      .join(' ')
    expect(optionText).toContain('王建国')
    expect(optionText).toContain('陈志强')
    expect(optionText).not.toContain('未排单人员')
  })

  it('弹窗保存失败时在当前弹窗内显示原因', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    await wrapper.get('[data-testid="worker-create-open"]').trigger('click')
    await wrapper.get('[data-testid="worker-create-dialog"] form').trigger('submit')
    await settle()

    expect(wrapper.get('[data-testid="worker-create-dialog"] .el-alert').text()).toContain('姓名')
    expect(wrapper.get('[data-testid="worker-create-dialog"]').isVisible()).toBe(true)
  })

  it('局部读取失败时不把缺失区块说成完整或空数据', async () => {
    const repository = new MockWorkforceRepository()
    const preview = (await repository.getWorkforcePreview('SY-2026-001')).data
    Object.assign(preview, {
      load_warnings: [{ section: 'site_daily_reports', message: '施工日报读取失败：无法连接本地服务；当前显示上次结果' }],
    })
    vi.spyOn(repository, 'getWorkforcePreview').mockResolvedValue({ source: 'demo', data: preview })

    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    expect(wrapper.get('[data-testid="workforce-load-warnings"]').text()).toContain('施工日报读取失败')
    expect(wrapper.get('[data-testid="workforce-load-warnings"]').text()).toContain('当前显示上次结果')
    expect(wrapper.get('[data-testid="site-daily-reports-card"]').text()).toContain('仅显示已载入')
    expect(wrapper.get('[data-testid="site-daily-reports-card"]').text()).not.toContain('暂无施工日报')
    expect(wrapper.text()).toContain('王建国')
  })

  it('数据录入弹窗统一右侧取消保存，脏表单关闭前明确确认', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as never)
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    await wrapper.get('[data-testid="worker-create-open"]').trigger('click')
    const dialog = wrapper.get('[data-testid="worker-create-dialog"]')
    expect(dialog.get('.dialog-actions').text()).toContain('取消')
    expect(dialog.get('.dialog-actions').text()).toContain('保存施工员')
    await dialog.get('input').setValue('还没保存的施工员')
    await dialog.get('[data-testid="worker-create-cancel"]').trigger('click')
    await settle()

    expect(confirmSpy).toHaveBeenCalledWith(
      '关闭后未保存的内容会丢失，确定关闭吗？',
      '放弃未保存内容',
      expect.objectContaining({ confirmButtonText: '放弃并关闭', cancelButtonText: '继续填写' }),
    )
    expect(dialog.isVisible()).toBe(true)

    await dialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(dialog.isVisible()).toBe(false)
  })

  it('上工编辑、日报、垫资、报销、施工员和排单仅在内容变更后确认放弃', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    const scenarios = [
      {
        open: '[data-testid="labor-edit-301"]',
        dialog: '[data-testid="labor-edit-dialog"]',
        title: '编辑上工记录',
        field: '[data-testid="labor-edit-summary"] textarea',
        value: '尚未保存的上工内容',
        cancel: '[data-testid="labor-edit-cancel"]',
      },
      {
        open: '[data-testid="daily-report-open"]',
        dialog: '[data-testid="daily-report-dialog"]',
        title: '施工日报',
        field: '[data-testid="daily-report-summary"]',
        value: '尚未保存的日报内容',
        cancel: '[data-testid="daily-report-cancel"]',
      },
      {
        open: '[data-testid="material-advance-open"]',
        dialog: '[data-testid="material-advance-dialog"]',
        title: '现场垫资',
        field: '[data-testid="advance-vendor"] input',
        value: '尚未保存的商户',
        cancel: '[data-testid="material-advance-cancel"]',
      },
      {
        open: '[data-testid="reimbursement-open-401"]',
        dialog: '[data-testid="reimbursement-dialog"]',
        title: '记录报销',
        field: '[data-testid="reimbursement-amount"]',
        value: '100',
        cancel: '[data-testid="reimbursement-cancel"]',
      },
      {
        open: '[data-testid="worker-create-open"]',
        dialog: '[data-testid="worker-create-dialog"]',
        title: '新建施工员',
        field: '[data-testid="worker-create-name"]',
        value: '尚未保存的施工员',
        cancel: '[data-testid="worker-create-cancel"]',
      },
      {
        open: '[data-testid="assignment-create-open"]',
        dialog: '[data-testid="assignment-create-dialog"]',
        title: '添加项目工人',
        field: '[data-testid="assignment-role"] input',
        value: '尚未保存的岗位',
        cancel: '[data-testid="assignment-cancel"]',
      },
    ] as const

    for (const scenario of scenarios) {
      await wrapper.get(scenario.open).trigger('click')
      const dialogComponent = wrapper.findAllComponents(ElDialog)
        .find((candidate) => candidate.props('title') === scenario.title)
      if (!dialogComponent) throw new Error(`未找到弹窗：${scenario.title}`)
      expect(typeof dialogComponent.props('beforeClose')).toBe('function')
      expect(dialogComponent.props('closeOnClickModal')).toBe(true)
      expect(dialogComponent.props('closeOnPressEscape')).toBe(true)
      expect(dialogComponent.props('showClose')).toBe(true)

      const cleanConfirmCount = confirmSpy.mock.calls.length
      await wrapper.get(scenario.cancel).trigger('click')
      await settle()
      expect(confirmSpy).toHaveBeenCalledTimes(cleanConfirmCount)
      expect(wrapper.get(scenario.dialog).isVisible()).toBe(false)

      await wrapper.get(scenario.open).trigger('click')
      await wrapper.get(scenario.field).setValue(scenario.value)
      await wrapper.get(scenario.cancel).trigger('click')
      await settle()
      expect(confirmSpy).toHaveBeenCalledTimes(cleanConfirmCount + 1)
      expect(wrapper.get(scenario.dialog).isVisible()).toBe(false)
    }
  })

  it('数据录入保存期间禁用所有关闭入口', async () => {
    const repository = new MockWorkforceRepository()
    const pending = deferred<never>()
    vi.spyOn(repository, 'createWorker').mockReturnValue(pending.promise)
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="worker-create-open"]').trigger('click')
    await wrapper.get('[data-testid="worker-create-name"]').setValue('保存中的施工员')
    await wrapper.get('[data-testid="worker-create-dialog"] form').trigger('submit')
    await Promise.resolve()

    const dialogComponent = wrapper.findAllComponents(ElDialog)
      .find((candidate) => candidate.props('title') === '新建施工员')
    if (!dialogComponent) throw new Error('未找到新建施工员弹窗')
    const beforeClose = dialogComponent.props('beforeClose')
    if (typeof beforeClose !== 'function') throw new Error('新建施工员弹窗缺少 beforeClose')
    const done = vi.fn()
    beforeClose(done)

    expect(done).not.toHaveBeenCalled()
    expect(dialogComponent.props('closeOnClickModal')).toBe(false)
    expect(dialogComponent.props('closeOnPressEscape')).toBe(false)
    expect(dialogComponent.props('showClose')).toBe(false)
    expect(wrapper.get('[data-testid="worker-create-cancel"]').attributes('disabled')).toBeDefined()

    pending.reject(new Error('结束保存中测试'))
    await settle()
  })

  it('成功保存上工后通知项目仪表台刷新', async () => {
    const wrapper = mountComponent(WorkforceCenter)
    await settle()

    await wrapper.get('[data-testid="labor-select-201"]').trigger('click')
    await wrapper.get('[data-testid="workforce-save-labor"]').trigger('click')
    await settle()

    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('归档项目施工页只展示历史数据，不显示任何写入入口', async () => {
    const wrapper = mountComponent(WorkforceCenter, 'SY-2026-001', useDemoBusinessContext().workforce, true)
    await settle()

    expect(wrapper.text()).toContain('项目已归档，本页仅供查看')
    expect(wrapper.find('[data-testid="assignment-create-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workforce-save-labor"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="worker-edit-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="labor-edit-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="reimbursement-open-"]').exists()).toBe(false)
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
    await wrapper.get('[data-testid="assignment-start-202"]').trigger('click')

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

describe('项目销项发票附件登记', () => {
  it('完全空白拒绝创建；只选择图片时保存为待补录而不伪造已登记事实', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockResolvedValue(undefined),
      discardSaveInvoice: vi.fn(() => false),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="invoice-attachments"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    expect(wrapper.text()).toContain('关联已有资料（可选）')
    await wrapper.get('[data-testid="invoice-save"]').trigger('click')
    await settle()
    expect(repository.saveInvoice).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请至少上传一个文件、关联一份已有资料，或填写一项发票信息')

    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const input = wrapper.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[data-testid="invoice-save"]').trigger('click')
    await settle()

    expect(repository.saveInvoice).toHaveBeenCalledWith('SY-2026-001', expect.objectContaining({
      status: 'planned',
      requested_on: null,
      recorded_on: null,
      invoice_number: null,
      amount_cents: null,
      counterparty_name: null,
      document_version_ids: [],
    }), [file])
  })

  it('保存失败后从底部取消发票弹窗会确认并放弃最近提交快照', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockRejectedValue(new Error('网络中断')),
      discardSaveInvoice: vi.fn(() => true),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const input = wrapper.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[data-testid="invoice-save"]').trigger('click')
    await settle()
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    await wrapper.get('[data-testid="invoice-cancel"]').trigger('click')
    await settle()

    expect(repository.discardSaveInvoice).toHaveBeenCalledWith('SY-2026-001', expect.objectContaining({
      status: 'planned', recorded_on: null, amount_cents: null, document_version_ids: [],
    }), [file])
  })

  it('销项发票结果未知后锁定原快照，放弃失败时继续保留安全重试入口', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      discardSaveInvoice: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    } as unknown as DeliveryWorkspaceRepository
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    const dialog = wrapper.get('[aria-label="登记发票"]')
    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const fileInput = dialog.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await dialog.get('[data-testid="invoice-number"]').setValue('INV-ORIGINAL')
    await dialog.get('[data-testid="invoice-save"]').trigger('click')
    await settle()

    expect(dialog.get('[data-testid="invoice-create-uncertain"]').text()).toContain('原样重试')
    expect(dialog.get('[data-testid="invoice-number"]').attributes('disabled')).toBeDefined()
    expect(fileInput.attributes('disabled')).toBeDefined()
    expect(dialog.get('[data-testid="invoice-save"]').text()).toContain('原样重试')
    const firstCall = vi.mocked(repository.saveInvoice).mock.calls[0]!

    await dialog.get('[data-testid="invoice-number"]').setValue('INV-CHANGED')
    await dialog.get('[data-testid="invoice-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]).toEqual(firstCall)
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]![1]).toBe(firstCall[1])
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]![2]).toBe(firstCall[2])

    await dialog.get('[data-testid="invoice-abandon-pending"]').trigger('click')
    await settle()
    expect(dialog.find('[data-testid="invoice-create-uncertain"]').exists()).toBe(true)
    expect(dialog.get('[data-testid="invoice-number"]').attributes('disabled')).toBeDefined()

    await dialog.get('[data-testid="invoice-abandon-pending"]').trigger('click')
    await settle()
    expect(dialog.find('[data-testid="invoice-create-uncertain"]').exists()).toBe(false)
    expect(dialog.get('[data-testid="invoice-number"]').attributes('disabled')).toBeUndefined()
  })

  it('A 项目销项发票迟到失败不污染 B 项目，返回 A 后恢复原请求', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const pending = deferred<void>()
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined),
      discardSaveInvoice: vi.fn(() => true),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const input = wrapper.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[aria-label="登记发票"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-2026-002' })
    await settle()
    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    pending.reject(new Error('网络中断'))
    await settle()

    expect(repository.discardSaveInvoice).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="登记发票"]').isVisible()).toBe(true)
    expect(wrapper.text()).not.toContain('网络中断')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(repository.getDeliveryPreview).toHaveBeenCalledTimes(2)

    await wrapper.setProps({ projectCode: 'SY-2026-001' })
    await settle()
    const restored = wrapper.get('[aria-label="登记发票"]')
    expect(restored.isVisible()).toBe(true)
    expect(restored.get('[data-testid="invoice-create-uncertain"]').text()).toContain('原样重试')
    const originalCall = vi.mocked(repository.saveInvoice).mock.calls[0]!
    await restored.get('[data-testid="invoice-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]![1]).toBe(originalCall[1])
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]![2]).toBe(originalCall[2])
    expect(vi.mocked(repository.saveInvoice).mock.calls[1]![2]![0]).toBe(file)
  })

  it('调试新增未知结果在卸载重挂后仍用原 repository、input 和 File 重试', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveCommissioningSession: vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(undefined),
      discardSaveCommissioningSession: vi.fn(() => true),
    } as unknown as DeliveryWorkspaceRepository
    const first = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await first.get('[data-testid="commissioning-create-open"]').trigger('click')
    const firstDialog = first.get('[aria-label="新增调试记录"]')
    const file = new File(['commissioning'], '调试记录.pdf', { type: 'application/pdf' })
    const upload = firstDialog.get('[data-testid="commissioning-attachments"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [file] })
    await upload.trigger('change')
    await firstDialog.get('form').trigger('submit')
    await settle()
    const originalCall = vi.mocked(repository.saveCommissioningSession).mock.calls[0]!
    first.unmount()

    expect(repository.discardSaveCommissioningSession).not.toHaveBeenCalled()
    const second = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    const restored = second.get('[aria-label="新增调试记录"]')
    expect(restored.isVisible()).toBe(true)
    expect(restored.get('[data-testid="commissioning-create-uncertain"]').text()).toContain('原样重试')
    await restored.get('[data-testid="commissioning-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.saveCommissioningSession).mock.calls[1]![1]).toBe(originalCall[1])
    expect(vi.mocked(repository.saveCommissioningSession).mock.calls[1]![2]).toBe(originalCall[2])
    expect(vi.mocked(repository.saveCommissioningSession).mock.calls[1]![2]![0]).toBe(file)
  })

  it('交付迟到成功遇到其他保存时，会在忙碌结束后自动消费且不允许重复登记', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const lateInvoice = deferred<void>()
    const lateCommissioning = deferred<void>()
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockReturnValue(lateInvoice.promise),
      saveCommissioningSession: vi.fn().mockReturnValue(lateCommissioning.promise),
      discardSaveInvoice: vi.fn(() => false),
      discardSaveCommissioningSession: vi.fn(() => false),
    } as unknown as DeliveryWorkspaceRepository
    const first = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await first.get('[data-testid="invoice-create-open"]').trigger('click')
    const file = new File(['image'], '迟到发票.jpg', { type: 'image/jpeg' })
    const upload = first.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(upload.element, 'files', { configurable: true, value: [file] })
    await upload.trigger('change')
    await first.get('[data-testid="invoice-save"]').trigger('click')
    await Promise.resolve()
    first.unmount()

    const second = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    expect(second.get('[aria-label="登记发票"]').isVisible()).toBe(true)
    await second.get('[data-testid="delivery-tab-commissioning"]').trigger('click')
    await second.get('[data-testid="commissioning-create-open"]').trigger('click')
    await second.get('[data-testid="commissioning-save"]').trigger('click')
    await Promise.resolve()

    lateInvoice.resolve()
    await settle()
    expect(second.get('[aria-label="登记发票"]').isVisible()).toBe(true)

    lateCommissioning.resolve()
    await settle()
    expect(second.get('[aria-label="登记发票"]').isVisible()).toBe(false)
    expect(repository.saveInvoice).toHaveBeenCalledTimes(1)
  })

  it('A 项目销项发票迟到成功不关闭 B 弹窗、不刷新或提示成功，也不发出事件', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const pending = deferred<void>()
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockReturnValue(pending.promise),
      discardSaveInvoice: vi.fn(() => false),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const input = wrapper.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[aria-label="登记发票"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-2026-002' })
    await settle()
    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    pending.resolve()
    await settle()

    expect(wrapper.get('[aria-label="登记发票"]').isVisible()).toBe(true)
    expect(wrapper.text()).not.toContain('发票记录已新增')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(repository.getDeliveryPreview).toHaveBeenCalledTimes(2)
  })

  it('销项发票保存期间整体禁用，首请求完成后恢复', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const pending = deferred<void>()
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveInvoice: vi.fn().mockReturnValue(pending.promise),
      discardSaveInvoice: vi.fn(() => false),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    const dialog = wrapper.get('[aria-label="登记发票"]')
    const file = new File(['image'], '销项发票.jpg', { type: 'image/jpeg' })
    const input = dialog.get('[data-testid="invoice-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await dialog.get('[data-testid="invoice-save"]').trigger('click')
    await Promise.resolve()

    expect(repository.saveInvoice).toHaveBeenCalledTimes(1)
    expect(dialog.findAll('input,textarea').every((field) => field.attributes('disabled') !== undefined)).toBe(true)
    await dialog.get('form').trigger('submit')
    expect(repository.saveInvoice).toHaveBeenCalledTimes(1)

    pending.resolve()
    await settle()

    expect(dialog.isVisible()).toBe(false)
    expect(dialog.get('[data-testid="invoice-save"]').attributes('disabled')).toBeUndefined()
  })

  it('只上传图片的计划中发票可以补录为已登记，并保留原附件关联', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.invoices = [{
      invoice_id: 902,
      invoice_type: 'contract_payment',
      status: 'planned',
      requested_on: null,
      recorded_on: null,
      invoice_number: null,
      amount_cents: null,
      counterparty_name: null,
      notes: '只上传了发票图片',
      document_version_ids: [77],
      void_reason: null,
    }]
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-edit-902"]').trigger('click')
    const dialog = wrapper.get('[aria-label="补录发票"]')
    await dialog.get('[data-testid="invoice-status"] .el-select__wrapper').trigger('click')
    await settle()
    const recordedOption = [...document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
      .find((item) => item.textContent?.includes('已登记'))
    expect(recordedOption).toBeDefined()
    recordedOption!.click()
    await settle()
    await dialog.get('[data-testid="invoice-number"]').setValue('INV-902')
    await dialog.get('[data-testid="invoice-amount"]').setValue('1234.56')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(repository.updateInvoice).toHaveBeenCalledWith('SY-2026-001', 902, expect.objectContaining({
      status: 'recorded',
      requested_on: '2026-09-10',
      recorded_on: '2026-09-10',
      invoice_number: 'INV-902',
      amount_cents: 123456,
      document_version_ids: [77],
    }))
  })

  it('只上传图片的计划中发票可先补录为已申请', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.invoices = [{
      invoice_id: 904, invoice_type: 'contract_payment', status: 'planned',
      requested_on: null, recorded_on: null, invoice_number: null, amount_cents: null,
      counterparty_name: null, notes: '只上传了发票图片', document_version_ids: [78], void_reason: null,
    }]
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-edit-904"]').trigger('click')
    const dialog = wrapper.get('[aria-label="补录发票"]')
    await dialog.get('[data-testid="invoice-status"] .el-select__wrapper').trigger('click')
    await settle()
    const requestedOption = [...document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
      .find((item) => item.textContent?.includes('已申请'))
    expect(requestedOption).toBeDefined()
    requestedOption!.click()
    await dialog.get('form').trigger('submit')
    await settle()

    expect(repository.updateInvoice).toHaveBeenCalledWith('SY-2026-001', 904, expect.objectContaining({
      status: 'requested', requested_on: '2026-09-10', recorded_on: null,
      document_version_ids: [78],
    }))
  })

  it('补录已登记发票时在前端拦截早于申请日期的登记日期', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.invoices = [{
      invoice_id: 905, invoice_type: 'contract_payment', status: 'planned',
      requested_on: null, recorded_on: null, invoice_number: null, amount_cents: null,
      counterparty_name: null, notes: '待补录', document_version_ids: [79], void_reason: null,
    }]
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-edit-905"]').trigger('click')
    const dialog = wrapper.get('[aria-label="补录发票"]')
    await dialog.get('[data-testid="invoice-status"] .el-select__wrapper').trigger('click')
    await settle()
    const recordedOption = [...document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
      .find((item) => item.textContent?.includes('已登记'))
    recordedOption!.click()
    await settle()
    await dialog.get('[data-testid="invoice-requested-date"] input').setValue('2026-09-11')
    await dialog.get('[data-testid="invoice-recorded-date"] input').setValue('2026-09-10')
    await dialog.get('[data-testid="invoice-number"]').setValue('INV-905')
    await dialog.get('[data-testid="invoice-amount"]').setValue('100.00')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(dialog.get('.el-alert').text()).toContain('登记日期不能早于申请日期')
    expect(repository.updateInvoice).not.toHaveBeenCalled()
  })

  it('已登记和已作废发票不提供补录入口', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.invoices.push({
      ...preview.data.invoices[0]!,
      invoice_id: 903,
      status: 'void',
      void_reason: '发票已作废',
    })
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')

    expect(wrapper.find('[data-testid="invoice-edit-901"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="invoice-edit-903"]').exists()).toBe(false)
  })
})

describe('交付新增请求未知结果与放弃安全', () => {
  it('四类新增失败后原样重试，底部、右上角和遮罩确认关闭都会放弃原快照', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repositoryDoubles = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveCommissioningSession: vi.fn().mockRejectedValue(new Error('网络中断')),
      discardSaveCommissioningSession: vi.fn(() => true),
      saveEngineeringChange: vi.fn().mockRejectedValue(new Error('网络中断')),
      discardSaveEngineeringChange: vi.fn(() => true),
      saveAcceptance: vi.fn().mockRejectedValue(new Error('网络中断')),
      discardSaveAcceptance: vi.fn(() => true),
      saveAfterSalesCase: vi.fn().mockRejectedValue(new Error('网络中断')),
      discardSaveAfterSalesCase: vi.fn(() => true),
    }
    const repository = repositoryDoubles as unknown as DeliveryWorkspaceRepository
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    const commissioningDialog = wrapper.get('[aria-label="新增调试记录"]')
    const commissioningFile = new File(['commissioning'], '调试记录.pdf', {
      type: 'application/pdf',
    })
    const commissioningFileInput = commissioningDialog.get(
      '[data-testid="commissioning-attachments"] input[type="file"]',
    )
    Object.defineProperty(commissioningFileInput.element, 'files', {
      configurable: true,
      value: [commissioningFile],
    })
    await commissioningFileInput.trigger('change')
    await commissioningDialog.get('form').trigger('submit')
    await settle()
    expect(commissioningDialog.get('[data-testid="commissioning-create-uncertain"]').text())
      .toContain('原样重试')
    expect(commissioningDialog.get('[data-testid="commissioning-started-at"] input').attributes('disabled'))
      .toBeDefined()
    expect(commissioningDialog.get('[data-testid="commissioning-save"]').text()).toContain('原样重试')
    await commissioningDialog.get('[data-testid="commissioning-started-at"] input')
      .setValue('2026-09-11T10:00')
    await commissioningDialog.get('form').trigger('submit')
    await settle()
    expect(repositoryDoubles.saveCommissioningSession).toHaveBeenCalledTimes(2)
    expect(repositoryDoubles.saveCommissioningSession.mock.calls[1])
      .toEqual(repositoryDoubles.saveCommissioningSession.mock.calls[0])
    await commissioningDialog.get('.dialog-actions button').trigger('click')
    await settle()
    expect(repositoryDoubles.discardSaveCommissioningSession)
      .toHaveBeenCalledWith(...repositoryDoubles.saveCommissioningSession.mock.calls[0])

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-create-open"]').trigger('click')
    const changeDialog = wrapper.get('[aria-label="新增工程变更"]')
    const changeFile = new File(['change'], '工程变更.pdf', { type: 'application/pdf' })
    await changeDialog.get('[data-testid="engineering-change-title"]').setValue('原变更')
    const changeFileInput = changeDialog.get(
      '[data-testid="engineering-change-attachments"] input[type="file"]',
    )
    Object.defineProperty(changeFileInput.element, 'files', {
      configurable: true,
      value: [changeFile],
    })
    await changeFileInput.trigger('change')
    await changeDialog.get('form').trigger('submit')
    await settle()
    expect(changeDialog.get('[data-testid="change-create-uncertain"]').text()).toContain('原样重试')
    expect(changeDialog.get('[data-testid="engineering-change-title"]').attributes('disabled'))
      .toBeDefined()
    await changeDialog.get('[data-testid="engineering-change-title"]').setValue('误改后的变更')
    await changeDialog.get('form').trigger('submit')
    await settle()
    expect(repositoryDoubles.saveEngineeringChange).toHaveBeenCalledTimes(2)
    expect(repositoryDoubles.saveEngineeringChange.mock.calls[1])
      .toEqual(repositoryDoubles.saveEngineeringChange.mock.calls[0])
    await changeDialog.get('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(repositoryDoubles.discardSaveEngineeringChange)
      .toHaveBeenCalledWith(...repositoryDoubles.saveEngineeringChange.mock.calls[0])

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    await wrapper.get('[data-testid="acceptance-create-open"]').trigger('click')
    const acceptanceDialog = wrapper.get('[aria-label="新增验收计划"]')
    await acceptanceDialog.get('form').trigger('submit')
    await settle()
    await acceptanceDialog.get('[data-testid="acceptance-scheduled-date"] input')
      .setValue('2026-09-20')
    await acceptanceDialog.get('form').trigger('submit')
    await settle()
    expect(repositoryDoubles.saveAcceptance).toHaveBeenCalledTimes(2)
    expect(repositoryDoubles.saveAcceptance.mock.calls[1])
      .toEqual(repositoryDoubles.saveAcceptance.mock.calls[0])
    await acceptanceDialog.trigger('mousedown')
    await acceptanceDialog.trigger('mouseup')
    await acceptanceDialog.trigger('click')
    await settle()
    expect(repositoryDoubles.discardSaveAcceptance)
      .toHaveBeenCalledWith(...repositoryDoubles.saveAcceptance.mock.calls[0])

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')
    const afterSalesDialog = wrapper.get('[data-testid="after-sales-dialog"]')
    const coverage = wrapper.findAllComponents({ name: 'ElSelect' }).find(
      (item) => item.attributes('data-testid') === 'after-sales-coverage',
    )
    coverage?.vm.$emit('update:modelValue', 'paid')
    await afterSalesDialog.get('[data-testid="after-sales-reason"]')
      .setValue('原报修原因')
    await afterSalesDialog.get('form').trigger('submit')
    await settle()
    await afterSalesDialog.get('[data-testid="after-sales-reason"]')
      .setValue('误改后的原因')
    await afterSalesDialog.get('form').trigger('submit')
    await settle()
    expect(repositoryDoubles.saveAfterSalesCase).toHaveBeenCalledTimes(2)
    expect(repositoryDoubles.saveAfterSalesCase.mock.calls[1])
      .toEqual(repositoryDoubles.saveAfterSalesCase.mock.calls[0])
    await afterSalesDialog.get('.dialog-actions button').trigger('click')
    await settle()
    expect(repositoryDoubles.discardSaveAfterSalesCase)
      .toHaveBeenCalledWith(...repositoryDoubles.saveAfterSalesCase.mock.calls[0])
    expect(confirm).toHaveBeenCalledTimes(4)
  })

  it('明确的 4xx 拒绝不锁住旧快照，用户修正后提交新内容', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    const repositoryDoubles = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      saveCommissioningSession: vi.fn().mockRejectedValue(
        new ApiError('调试记录格式不正确', 422, 'VALIDATION_ERROR'),
      ),
      discardSaveCommissioningSession: vi.fn(() => false),
    }
    const repository = repositoryDoubles as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    const dialog = wrapper.get('[aria-label="新增调试记录"]')
    await dialog.get('form').trigger('submit')
    await settle()
    await dialog.get('[data-testid="commissioning-started-at"] input')
      .setValue('2026-09-11T10:00')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(repositoryDoubles.saveCommissioningSession).toHaveBeenCalledTimes(2)
    expect(repositoryDoubles.saveCommissioningSession.mock.calls[0]?.[1].started_at)
      .toBe('2026-09-10T09:00')
    expect(repositoryDoubles.saveCommissioningSession.mock.calls[1]?.[1].started_at)
      .toBe('2026-09-11T10:00')
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
    expect(result.data.after_sales[0]?.is_under_warranty).toBe(true)
    expect(JSON.stringify(result.data)).not.toMatch(
      /actual_cost_delta_cents|contract_allocation_id|confirmed_by/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按会签调试、变更、验收质保和发票售后分区，并明确禁止推导语义', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    expect(wrapper.get('[data-testid="delivery-workspace"]').text()).not.toContain('实时数据')
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
    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    wrapper.get('[data-testid="commissioning-attachments"]')
    await wrapper.get('[aria-label="新增调试记录"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    expect(wrapper.get('[data-testid="change-create-open"]').text()).toContain('新增变更')
    await wrapper.get('[data-testid="change-create-open"]').trigger('click')
    wrapper.get('[data-testid="engineering-change-attachments"]')
    await wrapper.get('[aria-label="新增工程变更"] .el-dialog__headerbtn').trigger('click')

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.get('[data-testid="acceptance-create-open"]').text()).toContain('新增验收')

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.get('[data-testid="invoice-create-open"]').text()).toContain('登记发票')
    expect(wrapper.get('[data-testid="after-sales-create-open"]').text()).toContain('新增售后')
  })

  it('调试、变更、验收和售后预填当天，发票图片快捷登记不伪造登记日期', async () => {
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
    expect(wrapper.find('[data-testid="invoice-recorded-date"]').exists()).toBe(false)
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')
    expect((wrapper.get('[data-testid="after-sales-reported-date"] input').element as HTMLInputElement).value).toBe(expectedToday)
    expect(wrapper.find('input[type="date"]').exists()).toBe(false)
    expect(wrapper.find('input[type="datetime-local"]').exists()).toBe(false)
  })

  it('新增售后不预选保障方式，并按报修日期明确展示系统质保判断', async () => {
    const repository = new MockWorkforceRepository()
    const saveSpy = vi.spyOn(repository, 'saveAfterSalesCase')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')

    const coverage = wrapper.findAllComponents({ name: 'ElSelect' }).find(
      (item) => item.attributes('data-testid') === 'after-sales-coverage',
    )
    expect(coverage?.props('modelValue')).toBe('')
    expect(wrapper.get('[data-testid="after-sales-warranty-judgment"]').text())
      .toContain('系统判断：过保')

    await wrapper.get('[aria-label="新增售后案件"] form').trigger('submit')
    await settle()

    expect(saveSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="新增售后案件"] .el-alert').text())
      .toContain('请选择保障方式')
  })

  it('切换项目时关闭全部交付弹窗，避免将 A 项目表单写入 B 项目', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')
    expect(wrapper.get('[aria-label="登记发票"]').isVisible()).toBe(true)
    expect(wrapper.get('[aria-label="新增售后案件"]').isVisible()).toBe(true)

    await wrapper.setProps({ projectCode: 'SY-2026-002' })
    await settle()

    expect(wrapper.get('[aria-label="登记发票"]').isVisible()).toBe(false)
    expect(wrapper.get('[aria-label="新增售后案件"]').isVisible()).toBe(false)
  })

  it('历史售后标记为保内但服务端判定过保时明确提示核对', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.after_sales[0]!.coverage_type = 'warranty'
    preview.data.after_sales[0]!.is_under_warranty = false
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')

    expect(wrapper.get('[data-testid="after-sales-warranty-conflict-1001"]').text())
      .toContain('历史记录待核对')
  })

  it('报修日不在质保期内时前端阻止误选保内处理', async () => {
    const repository = new MockWorkforceRepository()
    const saveSpy = vi.spyOn(repository, 'saveAfterSalesCase')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="after-sales-create-open"]').trigger('click')
    const coverage = wrapper.findAllComponents({ name: 'ElSelect' }).find(
      (item) => item.attributes('data-testid') === 'after-sales-coverage',
    )
    if (!coverage) throw new Error('售后保障方式选择器不存在')
    await coverage.setValue('warranty')
    await wrapper.get('[aria-label="新增售后案件"] form').trigger('submit')
    await settle()

    expect(saveSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="新增售后案件"] .el-alert').text())
      .toContain('报修日期不在质保期内，不能选择保内处理')
  })

  it('报修日位于质保期时展示保内，未建立质保时展示未建立质保', async () => {
    vi.setSystemTime(new Date('2026-11-03T09:00:00+08:00'))
    const inWarranty = mountComponent(DeliveryWorkspace)
    await settle()
    await inWarranty.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await inWarranty.get('[data-testid="after-sales-create-open"]').trigger('click')
    expect(inWarranty.get('[data-testid="after-sales-warranty-judgment"]').text())
      .toContain('系统判断：保内')
    inWarranty.unmount()

    const repository = new MockWorkforceRepository()
    const preview = await repository.getDeliveryPreview('SY-2026-001')
    vi.spyOn(repository, 'getDeliveryPreview').mockResolvedValue({
      source: 'demo',
      data: { ...preview.data, warranty: null },
    })
    const noWarranty = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()
    await noWarranty.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await noWarranty.get('[data-testid="after-sales-create-open"]').trigger('click')
    expect(noWarranty.get('[data-testid="after-sales-warranty-judgment"]').text())
      .toContain('系统判断：未建立质保')
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
    expect(wrapper.find('[data-testid="change-transition-open-701"]').exists()).toBe(true)
    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.find('[data-testid="acceptance-complete-801"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="warranty-edit-open"]').text()).toContain('编辑质保')
    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.get('[data-testid="invoice-void-901"]').text()).toContain('作废')
    expect(wrapper.find('[data-testid="after-sales-status-1001"]').exists()).toBe(true)
  })

  it('工程变更只提供合法下一状态，明确保存并二次确认终态', async () => {
    const repository = new MockWorkforceRepository()
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-open-701"]').trigger('click')
    const dialog = wrapper.get('[data-testid="change-transition-dialog"]')
    await dialog.get('.el-select__wrapper').trigger('click')
    expect(document.body.textContent).toContain('已实施')
    expect(document.body.textContent).toContain('已取消')
    expect(document.body.querySelectorAll('.el-select-dropdown__item')).toHaveLength(2)

    await dialog.get('form').trigger('submit')
    await settle()
    expect((await repository.getDeliveryPreview('SY-2026-001')).data.engineering_changes[0]?.status).toBe('approved')
    expect(document.body.querySelector('.el-message-box')).not.toBeNull()
    await document.body.querySelector<HTMLElement>('.el-message-box__btns .el-button--primary')?.click()
    await settle()
    expect((await repository.getDeliveryPreview('SY-2026-001')).data.engineering_changes[0]?.status).toBe('implemented')
  })

  it('工程变更终态确认期间切换项目会关闭确认框，且迟到确认不串项目提交', async () => {
    const confirmation = deferred<unknown>()
    vi.spyOn(ElMessageBox, 'confirm')
      .mockReturnValue(confirmation.promise as ReturnType<typeof ElMessageBox.confirm>)
    const closeSpy = vi.spyOn(ElMessageBox, 'close')
    const repository = new MockWorkforceRepository()
    const transitionSpy = vi.spyOn(repository, 'setEngineeringChangeStatus')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()
    closeSpy.mockClear()

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-open-701"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-dialog"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'SY-2026-002' })
    await settle()

    expect(closeSpy).toHaveBeenCalledTimes(1)
    confirmation.resolve('confirm')
    await settle()
    expect(transitionSpy).not.toHaveBeenCalled()
  })

  it('工程变更终态确认期间切换仓储会关闭确认框且不提交旧仓储', async () => {
    const confirmation = deferred<unknown>()
    vi.spyOn(ElMessageBox, 'confirm')
      .mockReturnValue(confirmation.promise as ReturnType<typeof ElMessageBox.confirm>)
    const closeSpy = vi.spyOn(ElMessageBox, 'close')
    const repository = new MockWorkforceRepository()
    const nextRepository = new MockWorkforceRepository()
    const transitionSpy = vi.spyOn(repository, 'setEngineeringChangeStatus')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()
    closeSpy.mockClear()

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-open-701"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-dialog"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ repository: nextRepository })
    await settle()

    expect(closeSpy).toHaveBeenCalledTimes(1)
    confirmation.resolve('confirm')
    await settle()
    expect(transitionSpy).not.toHaveBeenCalled()
  })

  it('工程变更终态确认期间卸载会关闭确认框且迟到确认不再提交', async () => {
    const confirmation = deferred<unknown>()
    vi.spyOn(ElMessageBox, 'confirm')
      .mockReturnValue(confirmation.promise as ReturnType<typeof ElMessageBox.confirm>)
    const closeSpy = vi.spyOn(ElMessageBox, 'close')
    const repository = new MockWorkforceRepository()
    const transitionSpy = vi.spyOn(repository, 'setEngineeringChangeStatus')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()
    closeSpy.mockClear()

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-open-701"]').trigger('click')
    await wrapper.get('[data-testid="change-transition-dialog"] form').trigger('submit')
    await Promise.resolve()
    wrapper.unmount()

    expect(closeSpy).toHaveBeenCalledTimes(1)
    confirmation.resolve('confirm')
    await settle()
    expect(transitionSpy).not.toHaveBeenCalled()
  })

  it('会签可直接拖入最终图纸，并可在折叠区关联现有项目文件版本', async () => {
    const repository = new MockWorkforceRepository() as MockWorkforceRepository & {
      listDocumentVersionOptions(projectCode: string): Promise<Array<{ value: number; label: string }>>
    }
    repository.listDocumentVersionOptions = vi.fn().mockResolvedValue([
      { value: 444, label: '机械会签图 V3 · mechanical-final.pdf' },
    ])
    const saveSpy = vi.spyOn(repository, 'saveDrawingSignoff')
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository)
    await settle()

    await wrapper.get('[data-testid="signoff-edit-mechanical"]').trigger('click')
    const dialog = wrapper.get('[aria-label="更新图纸会签"]')
    expect(dialog.get('[data-testid="signoff-attachments"] .el-upload-dragger').classes())
      .toContain('el-upload-dragger')
    expect(dialog.text()).toContain('关联已有资料（可选）')
    const drawing = new File(['dwg'], '机械最终版.dwg', { type: 'application/acad' })
    const fileInput = dialog.get('[data-testid="signoff-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [drawing] })
    await fileInput.trigger('change')
    const selects = dialog.findAll('.el-select__wrapper')
    await selects[1]!.trigger('click')
    await settle()
    const option = [...document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
      .find((item) => item.textContent?.includes('mechanical-final.pdf'))
    expect(option).toBeDefined()
    option!.click()
    await dialog.get('form').trigger('submit')
    await settle()

    expect(saveSpy).toHaveBeenCalledWith(
      'SY-2026-001',
      'mechanical',
      expect.objectContaining({ document_version_ids: [444] }),
      [drawing],
    )
  })

  it('完成验收可直接拖入验收单或照片，保存中不能重复提交或关闭', async () => {
    const preview = await useDemoBusinessContext().workforce.getDeliveryPreview('SY-2026-001')
    preview.data.acceptances = [{
      acceptance_id: 888,
      acceptance_type: 'pre_acceptance',
      scheduled_on: '2026-09-10',
      performed_on: null,
        status: 'scheduled',
        notes: null,
        document_version_ids: [],
        cancel_reason: null,
        cancelled_at: null,
    }]
    const pending = deferred<void>()
    const repository = {
      getDeliveryPreview: vi.fn().mockResolvedValue(preview),
      listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
      completeAcceptance: vi.fn().mockReturnValue(pending.promise),
    } as unknown as DeliveryWorkspaceRepository
    const wrapper = mount(DeliveryWorkspace, {
      attachTo: document.body,
      props: { projectCode: 'SY-2026-001', repository },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    await wrapper.get('[data-testid="acceptance-complete-888"]').trigger('click')
    const dialog = wrapper.get('[aria-label="完成验收"]')
    await dialog.get('form').trigger('submit')
    expect(repository.completeAcceptance).not.toHaveBeenCalled()
    expect(dialog.get('.el-alert').text()).toContain('请选择本次真实验收结果')
    await dialog.getComponent('[data-testid="acceptance-complete-status"]').setValue('passed')
    expect(dialog.get('[data-testid="acceptance-attachments"] .el-upload-dragger').classes())
      .toContain('el-upload-dragger')
    expect(dialog.text()).toContain('关联已有资料（可选）')
    const proof = new File(['proof'], '验收单.pdf', { type: 'application/pdf' })
    const fileInput = dialog.get('[data-testid="acceptance-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [proof] })
    await fileInput.trigger('change')
    const status = dialog.findComponent({ name: 'ElSelect' })
    if (!status) throw new Error('验收结果选择器不存在')
    await status.setValue('passed')
    await dialog.get('form').trigger('submit')
    await Promise.resolve()
    await dialog.get('form').trigger('submit')

    expect(repository.completeAcceptance).toHaveBeenCalledTimes(1)
    expect(repository.completeAcceptance).toHaveBeenCalledWith(
      'SY-2026-001',
      888,
      expect.objectContaining({ document_version_ids: [] }),
      [proof],
    )
    expect(dialog.isVisible()).toBe(true)
    expect(dialog.find('.el-dialog__headerbtn').exists()).toBe(false)

    pending.resolve()
    await settle()
    expect(dialog.isVisible()).toBe(false)
  })

  it('交付弹窗保存失败时在当前弹窗内显示原因', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    await wrapper.get('[data-testid="invoice-create-open"]').trigger('click')
    await wrapper.get('[aria-label="登记发票"] form').trigger('submit')
    await settle()

    expect(wrapper.get('[aria-label="登记发票"] .el-alert').text())
      .toContain('请至少上传一个文件、关联一份已有资料，或填写一项发票信息')
    expect(wrapper.get('[aria-label="登记发票"]').isVisible()).toBe(true)
  })

  it('交付写入成功后通知项目仪表台刷新', async () => {
    const wrapper = mountComponent(DeliveryWorkspace)
    await settle()

    await wrapper.get('[data-testid="commissioning-create-open"]').trigger('click')
    await wrapper.get('[aria-label="新增调试记录"] form').trigger('submit')
    await settle()

    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('归档项目交付页只读，且终态记录不显示无效操作', async () => {
    const repository = new MockWorkforceRepository()
    const wrapper = mountComponent(DeliveryWorkspace, 'SY-2026-001', repository, true)
    await settle()

    expect(wrapper.text()).toContain('项目已归档，本页仅供查看')
    expect(wrapper.find('[data-testid="commissioning-create-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="signoff-edit-"]').exists()).toBe(false)
    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')
    expect(wrapper.find('[data-testid="acceptance-create-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="acceptance-complete-"]').exists()).toBe(false)
    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.find('[data-testid="invoice-create-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="invoice-void-"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="after-sales-status-"]').exists()).toBe(false)
  })
})
