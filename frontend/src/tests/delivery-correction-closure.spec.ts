import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DeliveryWorkspace from '../components/delivery/DeliveryWorkspace.vue'
import type { AfterSalesInput, EngineeringChangeInput } from '../domain/workforce'
import type { DeliveryWorkspaceRepository } from '../repositories/delivery.live'
import { MockWorkforceRepository } from '../repositories/workforce'

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function repositoryWithCorrections(): DeliveryWorkspaceRepository {
  return Object.assign(new MockWorkforceRepository(), {
    updateEngineeringChange: vi.fn(async () => undefined),
    rescheduleAcceptance: vi.fn(async () => undefined),
    cancelAcceptance: vi.fn(async () => undefined),
    updateAfterSalesCase: vi.fn(async () => undefined),
  }) as unknown as DeliveryWorkspaceRepository
}

function mountWorkspace(repository: DeliveryWorkspaceRepository): VueWrapper {
  return mount(DeliveryWorkspace, {
    attachTo: document.body,
    props: { projectCode: 'SY-2026-001', repository },
    global: { plugins: [ElementPlus] },
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T09:00:00+08:00'))
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('交付纠错闭环', () => {
  it('待审批工程变更可编辑原始内容并走 revision 安全 PUT', async () => {
    const repository = repositoryWithCorrections()
    const preview = await repository.getDeliveryPreview('SY-2026-001')
    Object.assign(preview.data.engineering_changes[0]!, {
      status: 'proposed',
      title: '增加安全围栏',
    })
    vi.spyOn(repository, 'getDeliveryPreview').mockResolvedValue(preview)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-changes"]').trigger('click')
    await wrapper.get('[data-testid="change-edit-701"]').trigger('click')
    const dialog = wrapper.get('[data-testid="engineering-change-dialog"]')
    expect((dialog.get('[data-testid="engineering-change-title"]').element as HTMLInputElement).value)
      .toBe('增加安全围栏')
    await dialog.get('[data-testid="engineering-change-title"]').setValue('增加安全围栏与光栅')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(repository.updateEngineeringChange).toHaveBeenCalledWith(
      'SY-2026-001',
      701,
      expect.objectContaining<Partial<EngineeringChangeInput>>({ title: '增加安全围栏与光栅' }),
    )
  })

  it('已安排验收可改期或填原因取消，完成后不提供这些入口', async () => {
    const repository = repositoryWithCorrections()
    const preview = await repository.getDeliveryPreview('SY-2026-001')
    Object.assign(preview.data.acceptances[0]!, {
      status: 'scheduled',
      performed_on: null,
    })
    vi.spyOn(repository, 'getDeliveryPreview').mockResolvedValue(preview)
    const wrapper = mountWorkspace(repository)
    await settle()
    await wrapper.get('[data-testid="delivery-tab-acceptance"]').trigger('click')

    expect(wrapper.find('[data-testid="acceptance-correction-actions-801"]').exists()).toBe(false)
    await wrapper.get('[data-testid="acceptance-reschedule-801"]').trigger('click')
    const editDialog = wrapper.get('[data-testid="acceptance-plan-dialog"]')
    await editDialog.get('[data-testid="acceptance-scheduled-date"] input').setValue('2026-09-20')
    await editDialog.get('[data-testid="acceptance-reschedule-reason"]').setValue('客户要求延后验收')
    await editDialog.get('form').trigger('submit')
    await settle()
    expect(repository.rescheduleAcceptance).toHaveBeenCalledWith(
      'SY-2026-001', 801, expect.objectContaining({ scheduled_on: '2026-09-20' }),
      '客户要求延后验收',
    )

    await wrapper.get('[data-testid="acceptance-cancel-801"]').trigger('click')
    const cancelDialog = wrapper.get('[data-testid="acceptance-cancel-dialog"]')
    await cancelDialog.get('[data-testid="acceptance-cancel-reason"]').setValue('客户要求重新约期')
    await cancelDialog.get('form').trigger('submit')
    await settle()
    expect(repository.cancelAcceptance).toHaveBeenCalledWith(
      'SY-2026-001', 801, '客户要求重新约期',
    )
  })

  it('未结案售后可编辑原始记录，已完成售后显示实际完成时间', async () => {
    const repository = repositoryWithCorrections()
    vi.spyOn(repository, 'setAfterSalesStatus').mockResolvedValue(undefined)
    const preview = await repository.getDeliveryPreview('SY-2026-001')
    preview.data.after_sales.push({
      ...preview.data.after_sales[0]!,
      case_id: 1002,
      status: 'completed',
      resolution: '已更换光电开关',
      completed_at: '2026-09-09T16:30:00Z',
    })
    vi.spyOn(repository, 'getDeliveryPreview').mockResolvedValue(preview)
    const wrapper = mountWorkspace(repository)
    await settle()

    await wrapper.get('[data-testid="delivery-tab-after-sales"]').trigger('click')
    expect(wrapper.get('[data-testid="after-sales-row-1002"]').text()).toContain('2026年9月10日 00:30')
    await wrapper.get('[data-testid="after-sales-edit-1001"]').trigger('click')
    const dialog = wrapper.get('[data-testid="after-sales-dialog"]')
    await dialog.get('[data-testid="after-sales-reason"]').setValue('传感器无信号')
    await dialog.get('form').trigger('submit')
    await settle()

    expect(repository.updateAfterSalesCase).toHaveBeenCalledWith(
      'SY-2026-001', 1001,
      expect.objectContaining<Partial<AfterSalesInput>>({ reason: '传感器无信号' }),
    )

    await wrapper.get('[data-testid="after-sales-status-1001"]').trigger('click')
    const statusSelect = wrapper.get('[data-testid="after-sales-next-status"]')
    expect((wrapper.get('[data-testid="after-sales-status-resolution"]').element as HTMLTextAreaElement).value)
      .toBe('')
    expect(statusSelect.text()).toContain('已完成')
    await statusSelect.trigger('click')
    await settle()
    const choices = Array.from(document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'))
      .map((item) => item.textContent?.trim())
      .filter(Boolean)
    expect(choices).toEqual(expect.arrayContaining(['已完成', '已取消']))
    expect(choices).not.toContain('待处理')
    expect(choices).not.toContain('处理中')

    const cancelledChoice = Array.from(document.body.querySelectorAll<HTMLElement>('.el-select-dropdown__item'))
      .find((item) => item.textContent?.trim() === '已取消')
    expect(cancelledChoice).toBeDefined()
    cancelledChoice?.click()
    await settle()
    await wrapper.get('[data-testid="after-sales-status-resolution"]').setValue('')
    await wrapper.get('[data-testid="after-sales-status-save"]').trigger('click')
    expect(wrapper.get('[data-testid="after-sales-status-error"]').text()).toContain('请填写取消原因')
    expect(repository.setAfterSalesStatus).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="after-sales-status-resolution"]').setValue('客户不再需要处理')
    await wrapper.get('[data-testid="after-sales-status-save"]').trigger('click')
    await settle()
    expect(repository.setAfterSalesStatus).toHaveBeenCalledWith(
      'SY-2026-001', 1001, 'cancelled', '客户不再需要处理',
    )
  })

  it('演示仓储与真实后端一致拒绝售后同状态和倒退流转', async () => {
    const repository = new MockWorkforceRepository()

    await expect(repository.setAfterSalesStatus('SY-2026-001', 1001, 'in_progress', '未变化'))
      .rejects.toThrow('售后状态不能这样变更')
    await expect(repository.setAfterSalesStatus('SY-2026-001', 1001, 'open', '错误倒退'))
      .rejects.toThrow('售后状态不能这样变更')
    await expect(repository.setAfterSalesStatus('SY-2026-001', 1001, 'cancelled', null))
      .rejects.toThrow('取消售后时请填写原因')
  })
})
