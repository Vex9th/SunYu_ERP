import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectCommercialPanel from '../components/project/ProjectCommercialPanel.vue'
import ProjectDocumentsPanel from '../components/project/ProjectDocumentsPanel.vue'
import { localISODate } from '../domain/dates'
import type {
  Contract,
  DocumentDetail,
  DocumentSummary,
  PaymentOverview,
  ProjectOperatingSnapshot,
  Quote,
} from '../domain/contracts'
import type { ProjectOperatingRepository } from '../repositories/project-operating.live'

const quote = (id: number, status: Quote['status']): Quote => ({
  id,
  project_code: 'T01',
  version_number: id,
  status,
  quote_date: '2026-09-03',
  amount_cents: 100_000,
  valid_until: null,
  notes: null,
  document_version_ids: [],
  revision: 1,
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
})

const contract = (id: number, status: Contract['status']): Contract => ({
  id,
  contract_no: `HT-${id}`,
  title: `合同 ${id}`,
  customer_company_id: 1,
  customer_company_name: '测试客户',
  status,
  signed_on: status === 'draft' ? null : '2026-09-03',
  total_amount_cents: 100_000,
  final_delivery_on: status === 'draft' ? null : '2026-10-01',
  allocations: [{ id, contract_id: id, project_code: 'T01', amount_cents: 100_000 }],
  notes: null,
  document_version_ids: [],
  revision: 1,
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
})

const payments: PaymentOverview = {
  contracted_amount_cents: 0,
  receivable_amount_cents: 0,
  received_amount_cents: 0,
  allocated_received_amount_cents: 0,
  unallocated_received_amount_cents: 0,
  outstanding_receivable_cents: 0,
  contract_collection_basis_points: null,
  terms: [],
  receipts: [],
}

function operating(): ProjectOperatingSnapshot {
  return {
    stages: [],
    commercial: { accepted_quote: null, contracts: [] },
    receivables: payments,
    costs: {
      material_consumed_cents: 0,
      labor_cents: 0,
      field_material_cents: 0,
      total_cents: 0,
      procurement_committed_cents: 0,
      procurement_received_cents: 0,
      procurement_paid_cents: 0,
      completeness: 'complete',
    },
    profit: {
      contracted_amount_cents: 0,
      actual_cost_cents: 0,
      actual_profit_cents: 0,
      margin_basis_points: null,
    },
    todos: [],
  }
}

function commercialRepository(): ProjectOperatingRepository {
  return {
    listQuotes: vi.fn().mockResolvedValue({
      items: [quote(1, 'draft'), quote(2, 'accepted')], total: 2, page: 1, page_size: 100,
    }),
    listContracts: vi.fn().mockResolvedValue({
      items: [contract(1, 'draft'), contract(2, 'completed')], total: 2, page: 1, page_size: 100,
    }),
    getPayments: vi.fn().mockResolvedValue(payments),
    listDocumentVersionOptions: vi.fn().mockResolvedValue([]),
    createQuote: vi.fn().mockResolvedValue(quote(3, 'draft')),
    discardCreateQuote: vi.fn(() => false),
    createContract: vi.fn().mockResolvedValue(contract(3, 'draft')),
    discardCreateContract: vi.fn(() => false),
    updateContract: vi.fn().mockResolvedValue(contract(1, 'draft')),
  } as unknown as ProjectOperatingRepository
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const documentSummary: DocumentSummary = {
  id: 12,
  project_code: 'T01',
  category: 'planning_minutes',
  title: '启动会纪要',
  notes: null,
  latest_version_number: 1,
  archived_at: null,
  revision: 1,
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
}

function documentRepository(): ProjectOperatingRepository {
  return {
    listDocuments: vi.fn().mockResolvedValue({ items: [documentSummary], total: 1, page: 1, page_size: 100 }),
    getDocument: vi.fn().mockResolvedValue({ ...documentSummary, versions: [] } as DocumentDetail),
  } as unknown as ProjectOperatingRepository
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('商务和资料的日常操作收敛', () => {
  it('报价和合同记录原地显示附件下载入口', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.listQuotes).mockResolvedValue({
      items: [{ ...quote(1, 'draft'), document_version_ids: [31] }], total: 1, page: 1, page_size: 100,
    })
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [{ ...contract(1, 'draft'), document_version_ids: [41] }], total: 1, page: 1, page_size: 100,
    })
    vi.mocked(repository.listDocumentVersionOptions).mockResolvedValue([
      { value: 31, label: '报价资料 V1 · 正式报价.pdf' },
      { value: 41, label: '合同资料 V1 · 已盖章合同.pdf' },
    ])
    const wrapper = mount(ProjectCommercialPanel, {
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    expect(wrapper.get('[data-testid="quote-files-1-31"]').attributes('href'))
      .toBe('/api/projects/T01/document-versions/31/download')
    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    expect(wrapper.get('[data-testid="contract-files-1-41"]').text()).toContain('已盖章合同.pdf')
  })

  it('已有资料选项读取失败时仍展示报价、合同和收款核心功能', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.listDocumentVersionOptions).mockRejectedValue(new Error('资料接口暂不可用'))
    const wrapper = mount(ProjectCommercialPanel, {
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    expect(wrapper.find('[data-testid="commercial-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="commercial-nav-quotes"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('已有资料暂时无法读取')
  })

  it('多合同项目登记到账必须明确选择合同归属', async () => {
    const repository = commercialRepository()
    const first = contract(11, 'signed')
    const second = contract(12, 'completed')
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [first, second], total: 2, page: 1, page_size: 100,
    })
    repository.createReceipt = vi.fn().mockResolvedValue({
      id: 99,
      project_code: 'T01',
      contract_allocation_id: second.allocations[0]!.id,
      milestone: 'advance',
      received_on: localISODate(),
      amount_cents: 100_000,
      payment_method: 'bank_transfer',
      reference_no: null,
      notes: null,
      status: 'active',
      voided_on: null,
      void_reason: null,
      revision: 1,
      created_at: '2026-09-03T00:00:00Z',
      updated_at: '2026-09-03T00:00:00Z',
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    await wrapper.get('[data-testid="receipt-create-open"]').trigger('click')
    const allocation = wrapper.getComponent('[data-testid="receipt-contract-allocation"]') as VueWrapper<any>
    expect(allocation.props('modelValue')).toBeNull()
    await wrapper.get('[data-testid="receipt-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    expect(repository.createReceipt).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请选择本次到账归属的合同')

    allocation.vm.$emit('update:modelValue', second.allocations[0]!.id)
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    await settle()
    expect(repository.createReceipt).toHaveBeenCalledWith('T01', expect.objectContaining({
      contract_allocation_id: second.allocations[0]!.id,
    }))
  })

  it('无生效合同时不能登记到账，只有一份时自动归属', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValueOnce({
      items: [], total: 0, page: 1, page_size: 100,
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')

    expect(wrapper.get('[data-testid="receipt-create-open"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('请先签订并确认合同')

    wrapper.unmount()
    const onlyContract = contract(21, 'signed')
    const singleRepository = commercialRepository()
    vi.mocked(singleRepository.listContracts).mockResolvedValueOnce({
      items: [onlyContract], total: 1, page: 1, page_size: 100,
    })
    const singleWrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: singleRepository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await singleWrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    await singleWrapper.get('[data-testid="receipt-create-open"]').trigger('click')
    const allocation = singleWrapper.getComponent('[data-testid="receipt-contract-allocation"]') as VueWrapper<any>
    expect(allocation.props('modelValue')).toBe(onlyContract.allocations[0]!.id)
  })

  it('历史未归属收款仍可编辑说明，不展示必填空选择框', async () => {
    const repository = commercialRepository()
    const legacyReceipt = {
      id: 66,
      project_code: 'T01',
      contract_allocation_id: null,
      milestone: 'advance' as const,
      received_on: '2026-09-01',
      amount_cents: 100_000,
      payment_method: 'bank_transfer' as const,
      reference_no: 'OLD-001',
      notes: '历史收款',
      status: 'active' as const,
      voided_on: null,
      void_reason: null,
      revision: 1,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
    }
    vi.mocked(repository.getPayments).mockResolvedValue({
      ...payments, receipts: [legacyReceipt], received_amount_cents: 100_000,
      unallocated_received_amount_cents: 100_000,
    })
    repository.updateReceipt = vi.fn().mockResolvedValue({
      ...legacyReceipt, reference_no: 'OLD-FIXED', notes: '已核对', revision: 2,
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    await wrapper.get('[data-testid="receipt-edit-open-66"]').trigger('click')

    expect(wrapper.find('[data-testid="receipt-contract-allocation"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="receipt-contract-allocation-readonly"]').text())
      .toContain('未归属（历史记录）')
    await wrapper.get('[data-testid="receipt-reference"]').setValue('OLD-FIXED')
    await wrapper.get('[data-testid="receipt-create-save"]').trigger('click')
    await settle()
    expect(repository.updateReceipt).toHaveBeenCalledWith('T01', 66, {
      reference_no: 'OLD-FIXED', notes: '历史收款', expected_revision: 1,
    })
  })

  it('报价和合同只提供当前合法动作，终态不显示编辑入口', async () => {
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01',
        operating: operating(),
        customerCompany: { id: 1, name: '测试客户' },
        repository: commercialRepository(),
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    expect(wrapper.find('[data-testid="quote-edit-open-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quote-edit-open-2"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="quote-status-2"]').attributes('role')).toBeUndefined()

    await wrapper.get('[data-testid="quote-transition-open-1"]').trigger('click')
    await settle()
    const transitionText = document.body.querySelector('[aria-label="切换状态"]')?.textContent ?? ''
    expect(transitionText).toContain('已发送')
    expect(transitionText).toContain('已撤回')
    expect(transitionText).not.toContain('已接受')
    expect(transitionText).not.toContain('已拒绝')

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    expect(wrapper.find('[data-testid="contract-edit-open-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="contract-edit-open-2"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="contract-status-2"]').attributes('role')).toBeUndefined()
  })

  it('新建报价可直接拖入文件，已有资料折叠为可选，编辑时不显示新文件区', async () => {
    const repository = commercialRepository()
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const formLabels = wrapper.findAll('[aria-label="新建报价"] .el-form-item__label')
      .map((item) => item.text())
    expect(formLabels.slice(0, 5)).toEqual([
      '报价日期', '报价金额（元）', '有效期至', '备注', '报价文件',
    ])
    expect(wrapper.get('[data-testid="quote-attachments"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    expect(wrapper.text()).toContain('关联已有资料（可选）')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const input = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()

    expect(repository.createQuote).toHaveBeenCalledWith('T01', expect.objectContaining({
      amount_cents: 100_000,
    }), [file])

    await wrapper.get('[data-testid="quote-edit-open-1"]').trigger('click')
    expect(wrapper.find('[data-testid="quote-attachments"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('关联已有资料（可选）')
  })

  it('新建报价的取消和创建按钮放在弹窗固定底部', async () => {
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: commercialRepository(),
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')

    expect(wrapper.find('[aria-label="新建报价"] .el-dialog__footer').exists()).toBe(true)
    expect(wrapper.find('[aria-label="新建报价"] .el-dialog__footer [data-testid="quote-cancel"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="新建报价"] .el-dialog__footer [data-testid="quote-create-save"]').exists()).toBe(true)
  })

  it('新建合同可在同一弹窗直接拖入文件，已有资料只作为可选入口', async () => {
    const repository = commercialRepository()
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    expect(wrapper.get('[data-testid="contract-attachments"] .el-upload-dragger').classes()).toContain('el-upload-dragger')
    expect(wrapper.text()).toContain('关联已有资料（可选）')
    expect(wrapper.find('[data-testid="contract-allocation"]').exists()).toBe(false)

    const file = new File(['contract'], '销售合同.pdf', { type: 'application/pdf' })
    const input = wrapper.get('[data-testid="contract-attachments"] input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-003')
    await wrapper.get('[data-testid="contract-title"]').setValue('自动化改造合同')
    await wrapper.get('[data-testid="contract-total"]').setValue('1000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(repository.createContract).toHaveBeenCalledWith('T01', expect.objectContaining({
      contract_no: 'HT-003',
      total_amount_cents: 100_000,
      allocations: [{ project_code: 'T01', amount_cents: 100_000 }],
    }), [file])

    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    expect(wrapper.find('[data-testid="contract-attachments"]').exists()).toBe(false)
  })

  it('新建合同的取消和保存按钮固定在弹窗底部', async () => {
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: commercialRepository(),
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')

    expect(wrapper.find('[aria-label="新建合同"] .el-dialog__footer').exists()).toBe(true)
    expect(wrapper.find('[aria-label="新建合同"] [data-testid="contract-cancel"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="新建合同"] [data-testid="contract-create-save"]').exists()).toBe(true)
  })

  it('合同金额为零时在前端直接拦截并给出明确提示', async () => {
    const repository = commercialRepository()
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-ZERO')
    await wrapper.get('[data-testid="contract-title"]').setValue('零元合同')
    await wrapper.get('[data-testid="contract-total"]').setValue('0')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')

    expect(repository.createContract).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="新建合同"] .el-alert').text()).toContain('大于零')
  })

  it('跨项目草稿合同只改备注时原样保留全部分摊', async () => {
    const sharedContract: Contract = {
      ...contract(1, 'draft'),
      total_amount_cents: 150_000,
      allocations: [
        { id: 11, contract_id: 1, project_code: 'T01', amount_cents: 100_000 },
        { id: 12, contract_id: 1, project_code: 'T02', amount_cents: 50_000 },
      ],
    }
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [sharedContract], total: 1, page: 1, page_size: 100,
    })
    vi.mocked(repository.updateContract).mockResolvedValue({ ...sharedContract, notes: '仅更新备注' })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    await wrapper.get('[aria-label="编辑合同"] textarea').setValue('仅更新备注')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(repository.updateContract).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.updateContract).mock.calls[0]?.[2].notes).toBe('仅更新备注')
    expect(vi.mocked(repository.updateContract).mock.calls[0]?.[2].allocations).toEqual([
      { project_code: 'T01', amount_cents: 100_000 },
      { project_code: 'T02', amount_cents: 50_000 },
    ])
  })

  it('跨项目草稿合同修改总额时拦截保存', async () => {
    const sharedContract: Contract = {
      ...contract(1, 'draft'),
      total_amount_cents: 150_000,
      allocations: [
        { id: 11, contract_id: 1, project_code: 'T01', amount_cents: 100_000 },
        { id: 12, contract_id: 1, project_code: 'T02', amount_cents: 50_000 },
      ],
    }
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [sharedContract], total: 1, page: 1, page_size: 100,
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    await wrapper.get('[data-testid="contract-total"]').setValue('2000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')

    expect(repository.updateContract).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="编辑合同"] .el-alert').text()).toContain(
      '跨项目合同修改总额需要同时调整全部项目分摊，当前页面不支持',
    )
  })

  it('单项目草稿合同未修改总额时保留原唯一分摊', async () => {
    const partiallyAllocatedContract: Contract = {
      ...contract(1, 'draft'),
      allocations: [{ id: 1, contract_id: 1, project_code: 'T01', amount_cents: 50_000 }],
    }
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [partiallyAllocatedContract], total: 1, page: 1, page_size: 100,
    })
    vi.mocked(repository.updateContract).mockResolvedValue({
      ...partiallyAllocatedContract,
      title: '仅修改合同名称',
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    await wrapper.get('[data-testid="contract-title"]').setValue('仅修改合同名称')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(repository.updateContract).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.updateContract).mock.calls[0]?.[2].allocations).toEqual([
      { project_code: 'T01', amount_cents: 50_000 },
    ])
  })

  it('草稿合同缺少分摊数据时拒绝保存', async () => {
    const unallocatedContract: Contract = { ...contract(1, 'draft'), allocations: [] }
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [unallocatedContract], total: 1, page: 1, page_size: 100,
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    await wrapper.get('[aria-label="编辑合同"] textarea').setValue('尝试更新')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')

    expect(repository.updateContract).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="编辑合同"] .el-alert').text()).toContain(
      '合同缺少项目分摊数据，当前页面无法安全保存',
    )
  })

  it('单项目草稿合同修改总额时同步唯一分摊', async () => {
    const singleProjectContract = contract(1, 'draft')
    const repository = commercialRepository()
    vi.mocked(repository.listContracts).mockResolvedValue({
      items: [singleProjectContract], total: 1, page: 1, page_size: 100,
    })
    vi.mocked(repository.updateContract).mockResolvedValue({
      ...singleProjectContract,
      total_amount_cents: 150_000,
      allocations: [{ id: 1, contract_id: 1, project_code: 'T01', amount_cents: 150_000 }],
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-edit-open-1"]').trigger('click')
    await wrapper.get('[data-testid="contract-total"]').setValue('1500.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(repository.updateContract).toHaveBeenCalledTimes(1)
    expect(vi.mocked(repository.updateContract).mock.calls[0]?.[2].allocations).toEqual([
      { project_code: 'T01', amount_cents: 150_000 },
    ])
  })

  it('合同保存期间锁定表单、附件和关闭入口，防止重复创建', async () => {
    const pending = deferred<Contract>()
    const repository = commercialRepository()
    vi.mocked(repository.createContract).mockReturnValue(pending.promise)
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    const file = new File(['contract'], '销售合同.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="contract-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-BUSY')
    await wrapper.get('[data-testid="contract-title"]').setValue('保存中的合同')
    await wrapper.get('[data-testid="contract-total"]').setValue('1000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await Promise.resolve()

    const dialog = wrapper.findAllComponents({ name: 'ElDialog' })
      .find((item) => item.props('title') === '新建合同')
    expect(repository.createContract).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="contract-no"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="contract-cancel"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="contract-attachments-remove-0"]').attributes('disabled')).toBeDefined()
    expect(dialog?.props('closeOnClickModal')).toBe(false)
    expect(dialog?.props('closeOnPressEscape')).toBe(false)
    expect(dialog?.props('showClose')).toBe(false)
    const close = vi.fn()
    dialog?.props('beforeClose')(close)
    expect(close).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await wrapper.get('[aria-label="新建合同"] form').trigger('submit')
    expect(repository.createContract).toHaveBeenCalledTimes(1)

    pending.resolve(contract(3, 'draft'))
    await settle()
    expect(dialog?.props('modelValue')).toBe(false)
  })

  it('合同创建失败后取消会放弃待重试请求和对应文件', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createContract).mockRejectedValue(new Error('网络中断'))
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    const file = new File(['contract'], '销售合同.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="contract-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-FAIL')
    await wrapper.get('[data-testid="contract-title"]').setValue('网络失败合同')
    await wrapper.get('[data-testid="contract-total"]').setValue('1000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce('confirm' as never)
    await wrapper.get('[data-testid="contract-cancel"]').trigger('click')
    await settle()

    expect(confirm).toHaveBeenCalledOnce()
    expect(repository.discardCreateContract).toHaveBeenCalledWith('T01', expect.objectContaining({
      contract_no: 'HT-FAIL', total_amount_cents: 100_000,
    }), [file])
  })

  it('合同结果未知后锁定原内容并只允许原样重试', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createContract)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(contract(3, 'draft'))
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-LOCK')
    await wrapper.get('[data-testid="contract-title"]').setValue('锁定测试合同')
    await wrapper.get('[data-testid="contract-total"]').setValue('1000.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="contract-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="contract-total"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="contract-create-save"]').text()).toContain('原样重试')
    await wrapper.get('[data-testid="contract-total"]').setValue('1200.00')
    await wrapper.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(repository.discardCreateContract).not.toHaveBeenCalled()
    expect(repository.createContract).toHaveBeenLastCalledWith('T01', expect.objectContaining({
      contract_no: 'HT-LOCK', total_amount_cents: 100_000,
    }), [])
  })

  it('报价保存期间锁定表单和关闭入口，并拒绝 Enter 二次提交', async () => {
    const pending = deferred<Quote>()
    const repository = commercialRepository()
    vi.mocked(repository.createQuote).mockReturnValue(pending.promise)
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await Promise.resolve()

    const quoteDialog = wrapper.findAllComponents({ name: 'ElDialog' })
      .find((item) => item.props('title') === '新建报价')
    expect(repository.createQuote).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="quote-create-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quote-amount"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quote-cancel"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quote-attachments-remove-0"]').attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'ElUpload' }).props('disabled')).toBe(true)
    expect(quoteDialog?.props('closeOnClickModal')).toBe(false)
    expect(quoteDialog?.props('closeOnPressEscape')).toBe(false)
    expect(quoteDialog?.props('showClose')).toBe(false)
    const close = vi.fn()
    quoteDialog?.props('beforeClose')(close)
    expect(close).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="quote-amount"]').setValue('2000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await wrapper.get('[aria-label="新建报价"] form').trigger('submit')
    await Promise.resolve()

    expect(repository.createQuote).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="quote-create-save"]').attributes('disabled')).toBeDefined()

    pending.resolve(quote(3, 'draft'))
    await settle()

    expect(quoteDialog?.props('modelValue')).toBe(false)
    expect(wrapper.get('[data-testid="quote-create-save"]').attributes('disabled')).toBeUndefined()
  })

  it('报价失败后关闭弹窗按最近提交的 input 与 File 快照放弃待重试语义', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createQuote).mockRejectedValue(new Error('网络中断'))
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValueOnce('confirm' as never)
    await wrapper.get('[data-testid="quote-cancel"]').trigger('click')
    await settle()

    expect(confirm).toHaveBeenCalledOnce()
    expect(repository.discardCreateQuote).toHaveBeenCalledWith('T01', {
      quote_date: localISODate(), amount_cents: 100_000, valid_until: null,
      notes: null, document_version_ids: [],
    }, [file])
  })

  it('报价结果未知后锁定表单并只允许原样重试', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createQuote)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(quote(3, 'draft'))
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="quote-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="quote-amount"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="quote-create-save"]').text()).toContain('原样重试')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1200.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()

    expect(repository.discardCreateQuote).not.toHaveBeenCalled()
    expect(repository.createQuote).toHaveBeenLastCalledWith('T01', {
      quote_date: localISODate(), amount_cents: 100_000, valid_until: null,
      notes: null, document_version_ids: [],
    }, [file])
  })

  it('报价结果未知后只有明确放弃才能修改并生成新请求', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createQuote)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(quote(3, 'draft'))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="quote-abandon-pending"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="quote-amount"]').setValue('1200.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()

    expect(confirm).toHaveBeenCalledOnce()
    expect(repository.discardCreateQuote).toHaveBeenCalledWith('T01', {
      quote_date: localISODate(), amount_cents: 100_000, valid_until: null,
      notes: null, document_version_ids: [],
    }, [])
    expect(repository.createQuote).toHaveBeenLastCalledWith('T01', expect.objectContaining({
      amount_cents: 120_000,
    }), [])
  })

  it('报价失败后原样重试时保留同一请求标识用于防重', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.createQuote)
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(quote(3, 'draft'))
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()

    expect(repository.createQuote).toHaveBeenCalledTimes(2)
    expect(repository.discardCreateQuote).not.toHaveBeenCalled()
  })

  it('A 项目报价迟到失败不污染 B 项目，返回 A 后恢复原请求', async () => {
    const pending = deferred<Quote>()
    const repository = commercialRepository()
    vi.mocked(repository.createQuote).mockReturnValue(pending.promise)
    const wrapper = mount(ProjectCommercialPanel, {
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    const file = new File(['quote'], '客户报价.pdf', { type: 'application/pdf' })
    const fileInput = wrapper.get('[data-testid="quote-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[aria-label="新建报价"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'T02' })
    await settle()
    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    pending.reject(new Error('网络中断'))
    await settle()

    expect(repository.discardCreateQuote).not.toHaveBeenCalled()
    expect(wrapper.get('[aria-label="新建报价"]').isVisible()).toBe(true)
    expect(wrapper.text()).not.toContain('网络中断')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(repository.listQuotes).toHaveBeenCalledTimes(2)

    await wrapper.setProps({ projectCode: 'T01' })
    await settle()

    expect(wrapper.get('[aria-label="新建报价"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="quote-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="quote-abandon-pending"]').text()).toContain('放弃原请求')
    vi.mocked(repository.createQuote).mockResolvedValueOnce(quote(99, 'draft'))
    await wrapper.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    expect(vi.mocked(repository.createQuote).mock.calls[1]?.[1])
      .toBe(vi.mocked(repository.createQuote).mock.calls[0]?.[1])
    expect(vi.mocked(repository.createQuote).mock.calls[1]?.[2])
      .toBe(vi.mocked(repository.createQuote).mock.calls[0]?.[2])
    expect(vi.mocked(repository.createQuote).mock.calls[1]?.[2]?.[0]).toBe(file)
  })

  it('合同提交期间卸载且迟到失败，重新进入仍用原仓储、输入、文件和请求标识重试', async () => {
    const pending = deferred<Contract>()
    const repository = commercialRepository()
    vi.mocked(repository.createContract).mockReturnValue(pending.promise)
    const first = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await first.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await first.get('[data-testid="contract-create-open"]').trigger('click')
    const file = new File(['contract'], '待确认合同.pdf', { type: 'application/pdf' })
    const fileInput = first.get('[data-testid="contract-attachments"] input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await first.get('[data-testid="contract-no"]').setValue('HT-LIFECYCLE')
    await first.get('[data-testid="contract-title"]').setValue('跨生命周期合同')
    await first.get('[data-testid="contract-total"]').setValue('1000.00')
    await first.get('[data-testid="contract-create-save"]').trigger('click')
    await Promise.resolve()
    first.unmount()
    pending.reject(new Error('网络中断'))
    await settle()

    expect(repository.discardCreateContract).not.toHaveBeenCalled()
    vi.mocked(repository.createContract).mockResolvedValueOnce(contract(99, 'draft'))
    const second = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    expect(second.get('[aria-label="新建合同"]').isVisible()).toBe(true)
    expect(second.get('[data-testid="contract-create-uncertain"]').text()).toContain('原样重试')
    expect(second.get('[data-testid="contract-abandon-pending"]').text()).toContain('放弃原请求')
    await second.get('[data-testid="contract-create-save"]').trigger('click')
    await settle()

    expect(vi.mocked(repository.createContract).mock.calls[1]?.[0]).toBe('T01')
    expect(vi.mocked(repository.createContract).mock.calls[1]?.[1])
      .toBe(vi.mocked(repository.createContract).mock.calls[0]?.[1])
    expect(vi.mocked(repository.createContract).mock.calls[1]?.[2])
      .toBe(vi.mocked(repository.createContract).mock.calls[0]?.[2])
    expect(vi.mocked(repository.createContract).mock.calls[1]?.[2]?.[0]).toBe(file)
  })

  it('pending 按 repository 对象隔离，同项目的其他仓储不会看到或放弃原请求', async () => {
    const repositoryA = commercialRepository()
    const repositoryB = commercialRepository()
    vi.mocked(repositoryA.createQuote).mockRejectedValueOnce(new Error('网络中断'))
    const first = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: repositoryA,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await first.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await first.get('[data-testid="quote-create-open"]').trigger('click')
    await first.get('[data-testid="quote-amount"]').setValue('1000.00')
    await first.get('[data-testid="quote-create-save"]').trigger('click')
    await settle()
    first.unmount()

    const isolated = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: repositoryB,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    expect(isolated.find('[data-testid="quote-create-uncertain"]').exists()).toBe(false)
    expect(repositoryA.discardCreateQuote).not.toHaveBeenCalled()
    expect(repositoryB.discardCreateQuote).not.toHaveBeenCalled()
    isolated.unmount()

    const restored = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository: repositoryA,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    expect(restored.get('[data-testid="quote-create-uncertain"]').text()).toContain('原样重试')
  })

  it('A 项目报价迟到成功不关闭或改写 B 项目，也不提示成功和发出事件', async () => {
    const pending = deferred<Quote>()
    const repository = commercialRepository()
    vi.mocked(repository.createQuote).mockReturnValue(pending.promise)
    const wrapper = mount(ProjectCommercialPanel, {
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await wrapper.get('[aria-label="新建报价"] form').trigger('submit')
    await Promise.resolve()
    await wrapper.setProps({ projectCode: 'T02' })
    await settle()
    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    pending.resolve({ ...quote(99, 'draft'), project_code: 'T01' })
    await settle()

    expect(wrapper.get('[aria-label="新建报价"]').isVisible()).toBe(true)
    expect(wrapper.text()).not.toContain('报价已创建')
    expect(wrapper.emitted('changed')).toBeUndefined()
    expect(repository.listQuotes).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="quote-edit-open-99"]').exists()).toBe(false)
  })

  it('归档项目的商务和资料页面只保留查看能力', async () => {
    const commercial = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(), readonly: true,
        customerCompany: { id: 1, name: '测试客户' }, repository: commercialRepository(),
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await commercial.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    expect(commercial.find('[data-testid="quote-create-open"]').exists()).toBe(false)
    expect(commercial.find('[data-testid="quote-edit-open-1"]').exists()).toBe(false)

    const documents = mount(ProjectDocumentsPanel, {
      attachTo: document.body,
      props: { projectCode: 'T01', readonly: true, repository: documentRepository() },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    expect(documents.find('[data-testid="document-create-open"]').exists()).toBe(false)
    expect(documents.find('[data-testid="document-minutes-create-open"]').exists()).toBe(false)
    expect(documents.find('[data-testid="document-preview-open-12"]').exists()).toBe(true)
    expect(documents.find('[data-testid="document-edit-open-12"]').exists()).toBe(false)
  })

  it('报价与普通商务弹窗用右上角关闭时先确认，避免误丢未保存内容', async () => {
    const repository = commercialRepository()
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')

    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
    await wrapper.get('[aria-label="新建报价"] .el-dialog__headerbtn').trigger('click')
    await settle()
    expect(confirm).toHaveBeenCalledOnce()
    expect(wrapper.get('[aria-label="新建报价"]').isVisible()).toBe(true)

    confirm.mockResolvedValueOnce('confirm' as never)
    await wrapper.get('[aria-label="新建报价"] .el-dialog__headerbtn').trigger('click')
    await settle()
    expect(wrapper.get('[aria-label="新建报价"]').isVisible()).toBe(false)
  })

  it('所有商务弹窗的底部取消与右上角关闭共用放弃确认', async () => {
    const repository = commercialRepository()
    vi.mocked(repository.getPayments).mockResolvedValue({
      ...payments,
      terms: [{
        id: 1,
        milestone: 'advance',
        due_on: '2026-09-30',
        planned_amount_cents: 100_000,
        received_amount_cents: 0,
        outstanding_amount_cents: 100_000,
        term_fulfillment_basis_points: 0,
        status: 'scheduled',
        is_overdue: false,
        notes: null,
        revision: 1,
      }],
      receipts: [{
        id: 9,
        project_code: 'T01',
        contract_allocation_id: 2,
        milestone: 'advance',
        received_on: '2026-09-03',
        amount_cents: 10_000,
        payment_method: 'bank_transfer',
        reference_no: null,
        notes: null,
        status: 'active',
        voided_on: null,
        void_reason: null,
        revision: 1,
        created_at: '2026-09-03T00:00:00Z',
        updated_at: '2026-09-03T00:00:00Z',
      }],
    })
    const wrapper = mount(ProjectCommercialPanel, {
      attachTo: document.body,
      props: {
        projectCode: 'T01', operating: operating(),
        customerCompany: { id: 1, name: '测试客户' }, repository,
      },
      global: { plugins: [ElementPlus] },
    })
    await settle()
    const confirm = vi.spyOn(ElMessageBox, 'confirm')

    async function expectGuardedCancel(
      dialogLabel: string,
      cancelSelector: string,
    ): Promise<void> {
      const callsBefore = confirm.mock.calls.length
      confirm.mockRejectedValueOnce('continue-editing')
      await wrapper.get(cancelSelector).trigger('click')
      await settle()
      expect(confirm).toHaveBeenCalledTimes(callsBefore + 1)
      expect(wrapper.get(`[aria-label="${dialogLabel}"]`).isVisible()).toBe(true)

      confirm.mockResolvedValueOnce('confirm' as never)
      await wrapper.get(cancelSelector).trigger('click')
      await settle()
      expect(confirm).toHaveBeenCalledTimes(callsBefore + 2)
      expect(wrapper.get(`[aria-label="${dialogLabel}"]`).isVisible()).toBe(false)
    }

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-create-open"]').trigger('click')
    await wrapper.get('[data-testid="quote-amount"]').setValue('1000.00')
    await expectGuardedCancel('新建报价', '[data-testid="quote-cancel"]')

    await wrapper.get('[data-testid="commercial-nav-contracts"]').trigger('click')
    await wrapper.get('[data-testid="contract-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contract-no"]').setValue('HT-CANCEL')
    await expectGuardedCancel('新建合同', '[data-testid="contract-cancel"]')

    await wrapper.get('[data-testid="commercial-nav-quotes"]').trigger('click')
    await wrapper.get('[data-testid="quote-transition-open-1"]').trigger('click')
    await wrapper.get('[aria-label="切换状态"] textarea').setValue('等待客户确认')
    await expectGuardedCancel('切换状态', '[data-testid="transition-cancel"]')

    await wrapper.get('[data-testid="commercial-nav-receivables"]').trigger('click')
    await wrapper.get('[data-testid="payment-term-edit-advance"]').trigger('click')
    await wrapper.get('[aria-label="编辑收款计划"] textarea').setValue('月底前到账')
    await expectGuardedCancel('编辑收款计划', '[data-testid="term-cancel"]')

    await wrapper.get('[data-testid="receipt-create-open"]').trigger('click')
    await wrapper.get('[data-testid="receipt-amount"]').setValue('100.00')
    await expectGuardedCancel('登记到账', '[data-testid="receipt-cancel"]')

    await wrapper.get('[data-testid="receipt-void-9"]').trigger('click')
    await wrapper.get('[data-testid="receipt-void-reason"]').setValue('录入错误')
    await expectGuardedCancel('作废到账', '[data-testid="receipt-void-cancel"]')
  })

  it('资料行只保留预览主按钮，其余操作收进含义明确的菜单', async () => {
    const wrapper = mount(ProjectDocumentsPanel, {
      attachTo: document.body,
      props: { projectCode: 'T01', repository: documentRepository() },
      global: { plugins: [ElementPlus] },
    })
    await settle()

    const row = wrapper.get('[data-testid="document-row-12"]')
    expect(row.findAll('button')).toHaveLength(2)
    expect(row.text()).toContain('预览')
    expect(row.text()).toContain('资料操作')
  })
})
