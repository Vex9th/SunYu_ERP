import {
  createRetriableMultipartPostSender,
  createRetriablePostSender,
  requestJson,
  withQuery,
} from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  AcceptanceCompletionInput,
  AcceptanceInput,
  AfterSalesInput,
  AfterSalesStatus,
  CommissioningSessionInput,
  DeliveryDemoViewModel,
  DeliverySummaryViewModel,
  DemoAcceptanceViewModel,
  DemoAfterSalesCaseViewModel,
  DemoCommissioningSessionViewModel,
  DemoDrawingSignoffViewModel,
  DemoEngineeringChangeViewModel,
  DemoInvoiceViewModel,
  DemoWarrantyViewModel,
  DrawingDiscipline,
  DrawingSignoffInput,
  EngineeringChangeInput,
  EngineeringChangeStatus,
  InvoiceInput,
  WarrantyInput,
} from '../domain/workforce'
import type { RepositoryResult } from './common'
import {
  createHttpProjectOperatingRepository,
  type DocumentVersionOption,
} from './project-operating.live'

export interface DeliveryWorkspaceRepository {
  readonly source: 'live' | 'demo'
  getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>>
  getDeliverySummary(projectCode: string): Promise<RepositoryResult<DeliverySummaryViewModel>>
  listDocumentVersionOptions?(projectCode: string): Promise<DocumentVersionOption[]>
  saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput, files?: readonly File[]): Promise<void>
  saveCommissioningSession(projectCode: string, input: CommissioningSessionInput, files?: readonly File[]): Promise<void>
  discardSaveCommissioningSession(projectCode: string, input: CommissioningSessionInput, files?: readonly File[]): boolean
  updateCommissioningSession(projectCode: string, sessionId: number, input: CommissioningSessionInput): Promise<void>
  saveEngineeringChange(projectCode: string, input: EngineeringChangeInput, files?: readonly File[]): Promise<void>
  discardSaveEngineeringChange(projectCode: string, input: EngineeringChangeInput, files?: readonly File[]): boolean
  updateEngineeringChange(projectCode: string, changeId: number, input: EngineeringChangeInput): Promise<void>
  setEngineeringChangeStatus(projectCode: string, changeId: number, status: EngineeringChangeStatus, reason?: string): Promise<void>
  saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void>
  discardSaveAcceptance(projectCode: string, input: AcceptanceInput): boolean
  rescheduleAcceptance(projectCode: string, acceptanceId: number, input: AcceptanceInput, reason: string): Promise<void>
  cancelAcceptance(projectCode: string, acceptanceId: number, reason: string): Promise<void>
  completeAcceptance(projectCode: string, acceptanceId: number, input: DeliveryAcceptanceCompletionInput, files?: readonly File[]): Promise<void>
  updateWarranty(projectCode: string, input: NullableWarrantyInput): Promise<void>
  saveInvoice(projectCode: string, input: InvoiceInput, files?: readonly File[]): Promise<void>
  updateInvoice(projectCode: string, invoiceId: number, input: InvoiceInput): Promise<void>
  discardSaveInvoice(projectCode: string, input: InvoiceInput, files?: readonly File[]): boolean
  voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void>
  saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void>
  discardSaveAfterSalesCase(projectCode: string, input: AfterSalesInput): boolean
  updateAfterSalesCase(projectCode: string, caseId: number, input: AfterSalesInput): Promise<void>
  setAfterSalesStatus(projectCode: string, caseId: number, status: AfterSalesStatus, resolution: string | null): Promise<void>
}

export type NullableWarrantyInput = Omit<WarrantyInput, 'renewal_price_cents'> & {
  renewal_price_cents: number | null
}

export type DeliveryAcceptanceCompletionInput = Omit<AcceptanceCompletionInput, 'warranty'> & {
  warranty?: NullableWarrantyInput | null
}

interface ResourceDto {
  id: number
  project_code: string
  revision: number
  created_at: string
  updated_at: string
}

interface DrawingSignoffDto extends Omit<DemoDrawingSignoffViewModel, never> {
  id: number | null
  project_code: string
  revision: number | null
  created_at: string | null
  updated_at: string | null
}

interface CommissioningDto extends ResourceDto, Omit<DemoCommissioningSessionViewModel, 'session_id'> {}
interface ChangeDto extends ResourceDto, Omit<DemoEngineeringChangeViewModel, 'change_id'> { change_number: number }
interface AcceptanceDto extends ResourceDto, Omit<DemoAcceptanceViewModel, 'acceptance_id'> {}
interface InvoiceDto extends ResourceDto, Omit<DemoInvoiceViewModel, 'invoice_id'> {}
interface AfterSalesDto extends ResourceDto, Omit<DemoAfterSalesCaseViewModel, 'case_id' | 'contact_name' | 'contact_phone'> {
  contact_name: string | null
  contact_phone: string | null
  is_under_warranty: boolean
  completed_at: string | null
  document_version_ids: number[]
}
interface WarrantyDto extends Omit<DemoWarrantyViewModel, 'renewal_price_cents'> {
  id: number
  project_id: number
  acceptance_id: number
  renewal_price_cents: number | null
  revision: number
  created_at: string
  updated_at: string
}

async function requestAllPages<T>(path: string): Promise<PagedResult<T>> {
  const pageSize = 200
  const first = await requestJson<PagedResult<T>>(withQuery(path, { page: 1, page_size: pageSize }))
  const pageCount = Math.ceil(first.total / pageSize)
  if (pageCount <= 1) return first
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => (
      requestJson<PagedResult<T>>(withQuery(path, { page: index + 2, page_size: pageSize }))
    )),
  )
  return {
    items: [first, ...remaining].flatMap((page) => page.items),
    page: 1,
    page_size: pageSize,
    total: first.total,
  }
}

class HttpDeliveryRepository implements DeliveryWorkspaceRepository {
  readonly source = 'live' as const
  private readonly postSender = createRetriablePostSender()
  private readonly multipartPostSender = createRetriableMultipartPostSender()
  private readonly projectRepository = createHttpProjectOperatingRepository()
  private signoffs = new Map<DrawingDiscipline, DrawingSignoffDto>()
  private commissioning = new Map<number, CommissioningDto>()
  private changes = new Map<number, ChangeDto>()
  private acceptances = new Map<number, AcceptanceDto>()
  private warranty: WarrantyDto | null = null
  private invoices = new Map<number, InvoiceDto>()
  private afterSales = new Map<number, AfterSalesDto>()
  private activeProjectKey: string | null = null
  private previewLoadVersion = 0
  private contextGeneration = 0
  private activeContextGeneration = 0

  async getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>> {
    const loadVersion = ++this.previewLoadVersion
    const contextGeneration = ++this.contextGeneration
    const hasPreviousData = this.activeProjectKey === projectCacheKey(projectCode)
    const previousSignoffs = hasPreviousData ? [...this.signoffs.values()] : []
    const previousCommissioning = hasPreviousData ? [...this.commissioning.values()] : []
    const previousChanges = hasPreviousData ? [...this.changes.values()] : []
    const previousAcceptances = hasPreviousData ? [...this.acceptances.values()] : []
    const previousWarranty = hasPreviousData ? this.warranty : null
    const previousInvoices = hasPreviousData ? [...this.invoices.values()] : []
    const previousAfterSales = hasPreviousData ? [...this.afterSales.values()] : []
    this.activeProjectKey = null
    const project = projectPath(projectCode)
    const results = await Promise.allSettled([
      requestJson<DrawingSignoffDto[]>(`${project}/drawing-signoffs`),
      requestAllPages<CommissioningDto>(`${project}/commissioning-sessions`),
      requestAllPages<ChangeDto>(`${project}/engineering-changes`),
      requestAllPages<AcceptanceDto>(`${project}/acceptances`),
      requestJson<WarrantyDto | null>(`${project}/warranty`),
      requestAllPages<InvoiceDto>(`${project}/invoices`),
      requestAllPages<AfterSalesDto>(`${project}/after-sales`),
    ])
    if (results.every((result) => result.status === 'rejected')) {
      const firstFailure = results.find((result) => result.status === 'rejected')
      if (firstFailure?.status === 'rejected') throw firstFailure.reason
    }
    const warnings: string[] = []
    const readResult = <T>(index: number, fallback: T, label: string): T => {
      const result = results[index]
      if (result?.status === 'fulfilled') return result.value as T
      const message = result?.reason instanceof Error ? result.reason.message : '未知错误'
      warnings.push(`${label}读取失败${hasPreviousData ? '，当前显示上次结果' : ''}：${message}`)
      return fallback
    }
    const previousPage = <T>(items: T[]): PagedResult<T> => ({ items, page: 1, page_size: 200, total: items.length })
    const signoffs = readResult<DrawingSignoffDto[]>(0, previousSignoffs, '图纸会签')
    const commissioning = readResult<PagedResult<CommissioningDto>>(1, previousPage(previousCommissioning), '调试记录')
    const changes = readResult<PagedResult<ChangeDto>>(2, previousPage(previousChanges), '工程变更')
    const acceptances = readResult<PagedResult<AcceptanceDto>>(3, previousPage(previousAcceptances), '验收记录')
    const warranty = readResult<WarrantyDto | null>(4, previousWarranty, '质保信息')
    const invoices = readResult<PagedResult<InvoiceDto>>(5, previousPage(previousInvoices), '发票记录')
    const afterSales = readResult<PagedResult<AfterSalesDto>>(6, previousPage(previousAfterSales), '售后记录')
    if (loadVersion === this.previewLoadVersion) {
      this.activeProjectKey = projectCacheKey(projectCode)
      this.activeContextGeneration = contextGeneration
      this.signoffs = new Map(signoffs.map((item) => [item.discipline, item]))
      this.commissioning = new Map(commissioning.items.map((item) => [item.id, item]))
      this.changes = new Map(changes.items.map((item) => [item.id, item]))
      this.acceptances = new Map(acceptances.items.map((item) => [item.id, item]))
      this.warranty = warranty
      this.invoices = new Map(invoices.items.map((item) => [item.id, item]))
      this.afterSales = new Map(afterSales.items.map((item) => [item.id, item]))
    }

    return live({
      project_code: projectCode,
      ...(warnings.length > 0 ? { load_warnings: warnings } : {}),
      drawing_signoffs: signoffs.map(mapSignoff),
      commissioning_sessions: commissioning.items.map(mapCommissioning),
      engineering_changes: changes.items.map(mapChange),
      acceptances: acceptances.items.map(mapAcceptance),
      warranty: warranty === null ? null : mapWarranty(warranty),
      invoices: invoices.items.map(mapInvoice),
      after_sales: afterSales.items.map(mapAfterSales),
    })
  }

  async getDeliverySummary(projectCode: string): Promise<RepositoryResult<DeliverySummaryViewModel>> {
    return live(await requestJson<DeliverySummaryViewModel>(`${projectPath(projectCode)}/delivery-summary`))
  }

  listDocumentVersionOptions(projectCode: string): Promise<DocumentVersionOption[]> {
    return this.projectRepository.listDocumentVersionOptions(projectCode)
  }

  async saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput, files: readonly File[] = []): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = this.signoffs.get(discipline)
    const path = `${projectPath(projectCode)}/drawing-signoffs/${discipline}`
    const payload = { ...input, expected_revision: current?.revision ?? null }
    const data = files.length > 0
      ? await requestJson<DrawingSignoffDto>(path, {
        method: 'PUT',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: businessAttachmentForm(payload, files),
      })
      : await requestJson<DrawingSignoffDto>(path, { method: 'PUT', body: payload })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.signoffs.set(discipline, data)
  }

  async saveCommissioningSession(projectCode: string, input: CommissioningSessionInput, files: readonly File[] = []): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const path = `${projectPath(projectCode)}/commissioning-sessions`
    const payload = normalizeCommissioning(input)
    const data = files.length > 0
      ? await this.multipartPostSender.send<CommissioningDto>(path, payload, files)
      : await this.postSender.send<CommissioningDto>(path, payload)
    if (this.hasProjectContext(projectCode, contextGeneration)) this.commissioning.set(data.id, data)
  }

  discardSaveCommissioningSession(
    projectCode: string,
    input: CommissioningSessionInput,
    files: readonly File[] = [],
  ): boolean {
    const path = `${projectPath(projectCode)}/commissioning-sessions`
    const payload = normalizeCommissioning(input)
    return files.length > 0
      ? this.multipartPostSender.discard(path, payload, files)
      : this.postSender.discard(path, payload)
  }

  async updateCommissioningSession(projectCode: string, sessionId: number, input: CommissioningSessionInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.commissioning, sessionId, '调试记录')
    const data = await requestJson<CommissioningDto>(`${projectPath(projectCode)}/commissioning-sessions/${sessionId}`, {
      method: 'PUT', body: { ...normalizeCommissioning(input), expected_revision: current.revision },
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.commissioning.set(data.id, data)
  }

  async saveEngineeringChange(projectCode: string, input: EngineeringChangeInput, files: readonly File[] = []): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const path = `${projectPath(projectCode)}/engineering-changes`
    const data = files.length > 0
      ? await this.multipartPostSender.send<ChangeDto>(path, input, files)
      : await this.postSender.send<ChangeDto>(path, input)
    if (this.hasProjectContext(projectCode, contextGeneration)) this.changes.set(data.id, data)
  }

  discardSaveEngineeringChange(
    projectCode: string,
    input: EngineeringChangeInput,
    files: readonly File[] = [],
  ): boolean {
    const path = `${projectPath(projectCode)}/engineering-changes`
    return files.length > 0
      ? this.multipartPostSender.discard(path, input, files)
      : this.postSender.discard(path, input)
  }

  async updateEngineeringChange(projectCode: string, changeId: number, input: EngineeringChangeInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.changes, changeId, '工程变更')
    const data = await requestJson<ChangeDto>(`${projectPath(projectCode)}/engineering-changes/${changeId}`, {
      method: 'PUT', body: { ...input, expected_revision: current.revision },
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.changes.set(data.id, data)
  }

  async setEngineeringChangeStatus(projectCode: string, changeId: number, status: EngineeringChangeStatus, reason = ''): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.changes, changeId, '工程变更')
    const data = await this.postSender.send<ChangeDto>(`${projectPath(projectCode)}/engineering-changes/${changeId}/transition`, {
      to_status: status,
      effective_on: localBusinessDate(),
      reason: reason.trim() || '从项目交付页更新状态',
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.changes.set(data.id, data)
  }

  async saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const data = await this.postSender.send<AcceptanceDto>(`${projectPath(projectCode)}/acceptances`, input)
    if (this.hasProjectContext(projectCode, contextGeneration)) this.acceptances.set(data.id, data)
  }

  discardSaveAcceptance(projectCode: string, input: AcceptanceInput): boolean {
    return this.postSender.discard(`${projectPath(projectCode)}/acceptances`, input)
  }

  async rescheduleAcceptance(projectCode: string, acceptanceId: number, input: AcceptanceInput, reason: string): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.acceptances, acceptanceId, '验收记录')
    const data = await this.postSender.send<AcceptanceDto>(`${projectPath(projectCode)}/acceptances/${acceptanceId}/reschedule`, {
      ...input, reason: reason.trim(), expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.acceptances.set(data.id, data)
  }

  async cancelAcceptance(projectCode: string, acceptanceId: number, reason: string): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.acceptances, acceptanceId, '验收记录')
    const data = await this.postSender.send<AcceptanceDto>(`${projectPath(projectCode)}/acceptances/${acceptanceId}/cancel`, {
      cancelled_on: localBusinessDate(),
      reason: reason.trim(),
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.acceptances.set(data.id, data)
  }

  async completeAcceptance(projectCode: string, acceptanceId: number, input: DeliveryAcceptanceCompletionInput, files: readonly File[] = []): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.acceptances, acceptanceId, '验收记录')
    const passedFinal = current.acceptance_type === 'final'
      && (input.status === 'passed' || input.status === 'passed_with_punch')
    if (passedFinal && !input.warranty) throw new Error('最终验收通过时必须填写质保期限')
    const path = `${projectPath(projectCode)}/acceptances/${acceptanceId}/complete`
    const payload = {
      performed_on: input.performed_on,
      result: input.status,
      notes: input.notes,
      document_version_ids: input.document_version_ids ?? [],
      warranty: passedFinal ? input.warranty : null,
      expected_revision: current.revision,
    }
    const data = files.length > 0
      ? await this.multipartPostSender.send<{ acceptance: AcceptanceDto; warranty: WarrantyDto | null }>(path, payload, files)
      : await this.postSender.send<{ acceptance: AcceptanceDto; warranty: WarrantyDto | null }>(path, payload)
    if (this.hasProjectContext(projectCode, contextGeneration)) {
      this.acceptances.set(data.acceptance.id, data.acceptance)
      this.warranty = data.warranty
    }
  }

  async updateWarranty(projectCode: string, input: NullableWarrantyInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const data = await requestJson<WarrantyDto>(`${projectPath(projectCode)}/warranty`, {
      method: 'PUT', body: { ...input, expected_revision: this.warranty?.revision ?? null },
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.warranty = data
  }

  async saveInvoice(projectCode: string, input: InvoiceInput, files: readonly File[] = []): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const path = `${projectPath(projectCode)}/invoices`
    const data = files.length > 0
      ? await this.multipartPostSender.send<InvoiceDto>(path, input, files)
      : await this.postSender.send<InvoiceDto>(path, input)
    if (this.hasProjectContext(projectCode, contextGeneration)) this.invoices.set(data.id, data)
  }

  async updateInvoice(projectCode: string, invoiceId: number, input: InvoiceInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.invoices, invoiceId, '发票记录')
    const data = await requestJson<InvoiceDto>(`${projectPath(projectCode)}/invoices/${invoiceId}`, {
      method: 'PUT', body: { ...input, expected_revision: current.revision },
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.invoices.set(data.id, data)
  }

  discardSaveInvoice(projectCode: string, input: InvoiceInput, files: readonly File[] = []): boolean {
    const path = `${projectPath(projectCode)}/invoices`
    return files.length > 0
      ? this.multipartPostSender.discard(path, input, files)
      : this.postSender.discard(path, input)
  }

  async voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.invoices, invoiceId, '发票记录')
    const data = await this.postSender.send<InvoiceDto>(`${projectPath(projectCode)}/invoices/${invoiceId}/void`, {
      reason: reason.trim(), expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.invoices.set(data.id, data)
  }

  async saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const data = await this.postSender.send<AfterSalesDto>(`${projectPath(projectCode)}/after-sales`, input)
    if (this.hasProjectContext(projectCode, contextGeneration)) this.afterSales.set(data.id, data)
  }

  discardSaveAfterSalesCase(projectCode: string, input: AfterSalesInput): boolean {
    return this.postSender.discard(`${projectPath(projectCode)}/after-sales`, input)
  }

  async updateAfterSalesCase(projectCode: string, caseId: number, input: AfterSalesInput): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.afterSales, caseId, '售后记录')
    const data = await requestJson<AfterSalesDto>(`${projectPath(projectCode)}/after-sales/${caseId}`, {
      method: 'PUT', body: { ...input, expected_revision: current.revision },
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.afterSales.set(data.id, data)
  }

  async setAfterSalesStatus(projectCode: string, caseId: number, status: AfterSalesStatus, resolution: string | null): Promise<void> {
    const contextGeneration = this.requireProjectContext(projectCode)
    const current = requireCached(this.afterSales, caseId, '售后记录')
    const data = await this.postSender.send<AfterSalesDto>(`${projectPath(projectCode)}/after-sales/${caseId}/transition`, {
      to_status: status,
      effective_at: new Date().toISOString(),
      resolution,
      reason: status === 'cancelled' ? resolution?.trim() : null,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextGeneration)) this.afterSales.set(data.id, data)
  }

  private hasProjectContext(projectCode: string, generation: number): boolean {
    return this.activeProjectKey === projectCacheKey(projectCode)
      && this.activeContextGeneration === generation
  }

  private requireProjectContext(projectCode: string): number {
    if (!this.hasProjectContext(projectCode, this.activeContextGeneration)) {
      throw new Error('项目交付数据已切换，请刷新后重试')
    }
    return this.activeContextGeneration
  }
}

export function createHttpDeliveryRepository(): DeliveryWorkspaceRepository {
  return new HttpDeliveryRepository()
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function businessAttachmentForm(payload: unknown, files: readonly File[]): FormData {
  const form = new FormData()
  form.set('payload', JSON.stringify(payload))
  for (const file of files) form.append('files', file, file.name)
  return form
}

function projectCacheKey(projectCode: string): string {
  return projectCode.trim()
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}

function requireCached<T>(items: Map<number, T>, id: number, name: string): T {
  const item = items.get(id)
  if (!item) throw new Error(`${name}不存在，请刷新后重试`)
  return item
}

function mapSignoff(item: DrawingSignoffDto): DemoDrawingSignoffViewModel {
  return {
    discipline: item.discipline, status: item.status, confirmed_on: item.confirmed_on,
    not_required_reason: item.not_required_reason, notes: item.notes,
    document_version_ids: item.document_version_ids,
  }
}

function mapCommissioning(item: CommissioningDto): DemoCommissioningSessionViewModel {
  return {
    session_id: item.id, started_at: item.started_at, ended_at: item.ended_at,
    status: item.status, summary: item.summary, issues: item.issues,
    next_action: item.next_action, notes: item.notes, document_version_ids: item.document_version_ids,
  }
}

function mapChange(item: ChangeDto): DemoEngineeringChangeViewModel {
  return {
    change_id: item.id, source: item.source, title: item.title, description: item.description,
    reason: item.reason, contract_delta_cents: item.contract_delta_cents,
    estimated_cost_delta_cents: item.estimated_cost_delta_cents,
    schedule_delta_days: item.schedule_delta_days, proposed_on: item.proposed_on,
    notes: item.notes, document_version_ids: item.document_version_ids, status: item.status,
  }
}

function mapAcceptance(item: AcceptanceDto): DemoAcceptanceViewModel {
  return {
    acceptance_id: item.id, acceptance_type: item.acceptance_type, status: item.status,
    scheduled_on: item.scheduled_on, performed_on: item.performed_on, notes: item.notes,
    document_version_ids: item.document_version_ids,
    cancel_reason: item.cancel_reason,
    cancelled_at: item.cancelled_at,
  }
}

function mapWarranty(item: WarrantyDto): DemoWarrantyViewModel {
  return {
    starts_on: item.starts_on, duration_months: item.duration_months,
    renewal_price_cents: item.renewal_price_cents, notes: item.notes,
    ends_on: item.ends_on, days_remaining: item.days_remaining, status: item.status,
  }
}

function mapInvoice(item: InvoiceDto): DemoInvoiceViewModel {
  return {
    invoice_id: item.id, invoice_type: item.invoice_type, status: item.status,
    requested_on: item.requested_on, recorded_on: item.recorded_on,
    invoice_number: item.invoice_number, amount_cents: item.amount_cents,
    counterparty_name: item.counterparty_name, notes: item.notes,
    document_version_ids: item.document_version_ids, void_reason: item.void_reason,
  }
}

function mapAfterSales(item: AfterSalesDto): DemoAfterSalesCaseViewModel {
  return {
    case_id: item.id, reported_on: item.reported_on, service_on: item.service_on,
    reason: item.reason, contact_name: item.contact_name ?? '', contact_phone: item.contact_phone ?? '',
    coverage_type: item.coverage_type, is_under_warranty: item.is_under_warranty,
    notes: item.notes, status: item.status,
    resolution: item.resolution, completed_at: item.completed_at,
  }
}

function localBusinessDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function normalizeCommissioning(input: CommissioningSessionInput): CommissioningSessionInput {
  return {
    ...input,
    started_at: awareDateTime(input.started_at),
    ended_at: input.ended_at === null ? null : awareDateTime(input.ended_at),
  }
}

function awareDateTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error('调试时间格式不正确')
  return parsed.toISOString()
}
