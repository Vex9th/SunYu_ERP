import { vi } from 'vitest'
import type { Contract, DocumentDetail, PaymentOverview, ProjectDashboard, ProjectStage, Quote, Receipt } from '../../domain/contracts'
import { createHttpProjectOperatingRepository } from '../../repositories/project-operating.live'

export function installProjectDom() {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true } }) })
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => original(element)
}
export const stage: ProjectStage = { stage_code: 'planning', status: 'pending', status_reason: null, planned_start_on: null, planned_end_on: null, started_at: null, blocked_at: null, completed_at: null, notes: null, revision: 4 }
export const documentFixture: DocumentDetail = { id: 6, project_code: 'SY-A', category: 'planning_minutes', title: '现场会议纪要', notes: null, latest_version_number: 2, archived_at: null, revision: 7, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', versions: [{ id: 22, version_number: 2, managed_filename: 'SY-A-会议-V2.txt', original_filename: 'minutes.txt', content_type: 'text/plain', size_bytes: 20, sha256: 'checksum', notes: '最新会议', created_at: '2026-10-06T00:00:00Z' }] }
export const quote: Quote = { id: 10, project_code: 'SY-A', version_number: 1, status: 'draft', quote_date: '2026-10-06', amount_cents: 12345, valid_until: null, notes: '原备注', document_version_ids: [22], revision: 3, created_at: '', updated_at: '' }
export const contract: Contract = { id: 1, contract_no: 'HT-001', title: '设备安装合同', customer_company_id: 1, customer_company_name: '测试客户', status: 'signed', signed_on: '2026-10-01', total_amount_cents: 100000, final_delivery_on: '2026-12-01', allocations: [{ id: 11, contract_id: 1, project_code: 'SY-A', amount_cents: 60000 }, { id: 12, contract_id: 1, project_code: 'SY-B', amount_cents: 40000 }], notes: null, document_version_ids: [], revision: 2, created_at: '', updated_at: '' }
export const receipt: Receipt = { id: 5, project_code: 'SY-A', contract_allocation_id: 11, milestone: 'advance', received_on: '2026-10-06', amount_cents: 10000, payment_method: 'bank_transfer', reference_no: 'BANK1', notes: null, status: 'active', voided_on: null, void_reason: null, revision: 6, created_at: '', updated_at: '' }
export const payments: PaymentOverview = { contracted_amount_cents: 60000, receivable_amount_cents: 60000, received_amount_cents: 10000, allocated_received_amount_cents: 10000, unallocated_received_amount_cents: 0, outstanding_receivable_cents: 50000, contract_collection_basis_points: 1667, receipts: [receipt], terms: (['advance', 'progress', 'final'] as const).map(milestone => ({ id: 1, milestone, due_on: null, planned_amount_cents: 20000, received_amount_cents: 0, outstanding_amount_cents: 20000, term_fulfillment_basis_points: 0, status: 'scheduled', is_overdue: false, notes: null, revision: 2 })) }
export const dashboard: ProjectDashboard = { project: { id: 1, project_code: 'SY-A', company_id: 1, company_name: '测试客户', name: '项目 A', description: null, status: 'active', closure_type: null, archive_reason: null, archived_at: null, revision: 1, created_at: '', updated_at: '' }, company: { id: 1, name: '测试客户', taxpayer_id: null, registered_address: null, registered_phone: null, bank_name: null, bank_account: null, notes: null, created_at: '', updated_at: '' }, contacts: [], documents: { document_count: 1, version_count: 2, categories: [] }, stages: [stage], commercial: { accepted_quote: null, contracts: [contract] }, costs: { material_consumed_cents: 0, labor_cents: 0, field_material_cents: 0, total_cents: 0, procurement_committed_cents: 0, procurement_received_cents: 0, procurement_paid_cents: 0, completeness: 'complete' }, profit: { contracted_amount_cents: 60000, actual_cost_cents: 0, actual_profit_cents: 60000, margin_basis_points: 10000 }, receivables: payments, todos: [], completion_check: { stages_ready: false, final_acceptance_ready: false, receivables_ready: false, ready: false, blockers: ['PROJECT_STAGES_INCOMPLETE'] } }
export const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, page_size: 20 })
export function projectRepository() {
  const repository = createHttpProjectOperatingRepository()
  vi.spyOn(repository, 'listProjectStages').mockResolvedValue({ source: 'live', data: [stage] })
  vi.spyOn(repository, 'updateStageSchedule').mockResolvedValue({ source: 'live', data: stage })
  vi.spyOn(repository, 'transitionStage').mockResolvedValue({ source: 'live', data: stage })
  vi.spyOn(repository, 'listDocuments').mockResolvedValue(page([documentFixture]))
  vi.spyOn(repository, 'getDocument').mockResolvedValue(documentFixture)
  vi.spyOn(repository, 'createDocument').mockResolvedValue(documentFixture)
  vi.spyOn(repository, 'addDocumentVersion').mockResolvedValue(documentFixture.versions[0])
  vi.spyOn(repository, 'archiveDocument').mockResolvedValue({ ...documentFixture, archived_at: '2026-10-06T00:00:00Z' })
  vi.spyOn(repository, 'downloadDocumentVersion').mockResolvedValue(new Blob(['会议记录：安装计划与验收计划。'], { type: 'text/plain' }))
  vi.spyOn(repository, 'listQuotes').mockResolvedValue(page([quote]))
  vi.spyOn(repository, 'createQuote').mockResolvedValue(quote)
  vi.spyOn(repository, 'updateQuote').mockResolvedValue(quote)
  vi.spyOn(repository, 'listContracts').mockResolvedValue(page([contract]))
  vi.spyOn(repository, 'updateContract').mockResolvedValue(contract)
  vi.spyOn(repository, 'createContract').mockResolvedValue(contract)
  vi.spyOn(repository, 'getPayments').mockResolvedValue(payments)
  vi.spyOn(repository, 'createReceipt').mockResolvedValue(receipt)
  vi.spyOn(repository, 'updateReceipt').mockResolvedValue(receipt)
  vi.spyOn(repository, 'voidReceipt').mockResolvedValue({ ...receipt, status: 'voided' })
  vi.spyOn(repository, 'getProjectDashboard').mockResolvedValue(dashboard)
  vi.spyOn(repository, 'listDocumentVersionOptions').mockResolvedValue([{ value: 22, label: '会议纪要 V2' }])
  vi.spyOn(repository, 'getGlobalDashboard').mockResolvedValue({ generated_at: '', summary: { active_project_count: 2, overdue_receivable_count: 0, upcoming_delivery_count: 0, contracted_amount_cents: 0, received_amount_cents: 0, outstanding_receivable_cents: 0 }, projects: [dashboard.project, { ...dashboard.project, project_code: 'SY-B', name: '项目 B' }].map(project => ({ project, current_stage: null, contracted_amount_cents: 0, received_amount_cents: 0, outstanding_receivable_cents: 0, final_delivery_on: null, actual_profit_cents: null })), todos: [], backup: { healthy: true, last_success_at: null, message: null } })
  return repository
}
