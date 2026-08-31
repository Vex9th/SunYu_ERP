import { createRetriablePostSender, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  AcceptanceCompletionInput,
  AcceptanceInput,
  AfterSalesInput,
  AfterSalesStatus,
  CommissioningSessionInput,
  DeliveryDemoViewModel,
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

export interface DeliveryWorkspaceRepository {
  readonly source: 'live' | 'demo'
  getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>>
  saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput): Promise<void>
  saveCommissioningSession(projectCode: string, input: CommissioningSessionInput): Promise<void>
  updateCommissioningSession(projectCode: string, sessionId: number, input: CommissioningSessionInput): Promise<void>
  saveEngineeringChange(projectCode: string, input: EngineeringChangeInput): Promise<void>
  setEngineeringChangeStatus(projectCode: string, changeId: number, status: EngineeringChangeStatus): Promise<void>
  saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void>
  completeAcceptance(projectCode: string, acceptanceId: number, input: DeliveryAcceptanceCompletionInput): Promise<void>
  updateWarranty(projectCode: string, input: NullableWarrantyInput): Promise<void>
  saveInvoice(projectCode: string, input: InvoiceInput): Promise<void>
  voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void>
  saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void>
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

class HttpDeliveryRepository implements DeliveryWorkspaceRepository {
  readonly source = 'live' as const
  private readonly postSender = createRetriablePostSender()
  private signoffs = new Map<DrawingDiscipline, DrawingSignoffDto>()
  private commissioning = new Map<number, CommissioningDto>()
  private changes = new Map<number, ChangeDto>()
  private acceptances = new Map<number, AcceptanceDto>()
  private warranty: WarrantyDto | null = null
  private invoices = new Map<number, InvoiceDto>()
  private afterSales = new Map<number, AfterSalesDto>()
  private activeProjectKey: string | null = null
  private previewLoadVersion = 0

  async getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>> {
    const loadVersion = ++this.previewLoadVersion
    const project = projectPath(projectCode)
    const [signoffs, commissioning, changes, acceptances, warranty, invoices, afterSales] = await Promise.all([
      requestJson<DrawingSignoffDto[]>(`${project}/drawing-signoffs`),
      requestJson<PagedResult<CommissioningDto>>(withQuery(`${project}/commissioning-sessions`, { page: 1, page_size: 200 })),
      requestJson<PagedResult<ChangeDto>>(withQuery(`${project}/engineering-changes`, { page: 1, page_size: 200 })),
      requestJson<PagedResult<AcceptanceDto>>(withQuery(`${project}/acceptances`, { page: 1, page_size: 200 })),
      requestJson<WarrantyDto | null>(`${project}/warranty`),
      requestJson<PagedResult<InvoiceDto>>(withQuery(`${project}/invoices`, { page: 1, page_size: 200 })),
      requestJson<PagedResult<AfterSalesDto>>(withQuery(`${project}/after-sales`, { page: 1, page_size: 200 })),
    ])
    if (loadVersion === this.previewLoadVersion) {
      this.activeProjectKey = projectCacheKey(projectCode)
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
      drawing_signoffs: signoffs.map(mapSignoff),
      commissioning_sessions: commissioning.items.map(mapCommissioning),
      engineering_changes: changes.items.map(mapChange),
      acceptances: acceptances.items.map(mapAcceptance),
      warranty: warranty === null ? null : mapWarranty(warranty),
      invoices: invoices.items.map(mapInvoice),
      after_sales: afterSales.items.map(mapAfterSales),
    })
  }

  async saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = this.signoffs.get(discipline)
    const data = await requestJson<DrawingSignoffDto>(`${projectPath(projectCode)}/drawing-signoffs/${discipline}`, {
      method: 'PUT', body: { ...input, expected_revision: current?.revision ?? null },
    })
    if (this.hasProjectContext(projectCode)) this.signoffs.set(discipline, data)
  }

  async saveCommissioningSession(projectCode: string, input: CommissioningSessionInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await this.postSender.send<CommissioningDto>(`${projectPath(projectCode)}/commissioning-sessions`, normalizeCommissioning(input))
    if (this.hasProjectContext(projectCode)) this.commissioning.set(data.id, data)
  }

  async updateCommissioningSession(projectCode: string, sessionId: number, input: CommissioningSessionInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = requireCached(this.commissioning, sessionId, '调试记录')
    const data = await requestJson<CommissioningDto>(`${projectPath(projectCode)}/commissioning-sessions/${sessionId}`, {
      method: 'PUT', body: { ...normalizeCommissioning(input), expected_revision: current.revision },
    })
    if (this.hasProjectContext(projectCode)) this.commissioning.set(data.id, data)
  }

  async saveEngineeringChange(projectCode: string, input: EngineeringChangeInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await this.postSender.send<ChangeDto>(`${projectPath(projectCode)}/engineering-changes`, input)
    if (this.hasProjectContext(projectCode)) this.changes.set(data.id, data)
  }

  async setEngineeringChangeStatus(projectCode: string, changeId: number, status: EngineeringChangeStatus): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = requireCached(this.changes, changeId, '工程变更')
    const data = await this.postSender.send<ChangeDto>(`${projectPath(projectCode)}/engineering-changes/${changeId}/transition`, {
      to_status: status,
      effective_on: localBusinessDate(),
      reason: '从项目交付页更新状态',
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.changes.set(data.id, data)
  }

  async saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await this.postSender.send<AcceptanceDto>(`${projectPath(projectCode)}/acceptances`, input)
    if (this.hasProjectContext(projectCode)) this.acceptances.set(data.id, data)
  }

  async completeAcceptance(projectCode: string, acceptanceId: number, input: DeliveryAcceptanceCompletionInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = requireCached(this.acceptances, acceptanceId, '验收记录')
    const passedFinal = current.acceptance_type === 'final'
      && (input.status === 'passed' || input.status === 'passed_with_punch')
    if (passedFinal && !input.warranty) throw new Error('最终验收通过时必须填写质保期限')
    const data = await this.postSender.send<{ acceptance: AcceptanceDto; warranty: WarrantyDto | null }>(
      `${projectPath(projectCode)}/acceptances/${acceptanceId}/complete`,
      {
        performed_on: input.performed_on,
        result: input.status,
        notes: input.notes,
        document_version_ids: input.document_version_ids ?? [],
        warranty: passedFinal ? input.warranty : null,
        expected_revision: current.revision,
      },
    )
    if (this.hasProjectContext(projectCode)) {
      this.acceptances.set(data.acceptance.id, data.acceptance)
      this.warranty = data.warranty
    }
  }

  async updateWarranty(projectCode: string, input: NullableWarrantyInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await requestJson<WarrantyDto>(`${projectPath(projectCode)}/warranty`, {
      method: 'PUT', body: { ...input, expected_revision: this.warranty?.revision ?? null },
    })
    if (this.hasProjectContext(projectCode)) this.warranty = data
  }

  async saveInvoice(projectCode: string, input: InvoiceInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await this.postSender.send<InvoiceDto>(`${projectPath(projectCode)}/invoices`, input)
    if (this.hasProjectContext(projectCode)) this.invoices.set(data.id, data)
  }

  async voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = requireCached(this.invoices, invoiceId, '发票记录')
    const data = await this.postSender.send<InvoiceDto>(`${projectPath(projectCode)}/invoices/${invoiceId}/void`, {
      reason: reason.trim(), expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.invoices.set(data.id, data)
  }

  async saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const data = await this.postSender.send<AfterSalesDto>(`${projectPath(projectCode)}/after-sales`, input)
    if (this.hasProjectContext(projectCode)) this.afterSales.set(data.id, data)
  }

  async setAfterSalesStatus(projectCode: string, caseId: number, status: AfterSalesStatus, resolution: string | null): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = requireCached(this.afterSales, caseId, '售后记录')
    const data = await this.postSender.send<AfterSalesDto>(`${projectPath(projectCode)}/after-sales/${caseId}/transition`, {
      to_status: status,
      effective_at: new Date().toISOString(),
      resolution,
      reason: status === 'cancelled' ? (resolution?.trim() || '从项目交付页取消') : null,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.afterSales.set(data.id, data)
  }

  private hasProjectContext(projectCode: string): boolean {
    return this.activeProjectKey === projectCacheKey(projectCode)
  }

  private requireProjectContext(projectCode: string): void {
    if (!this.hasProjectContext(projectCode)) {
      throw new Error('项目交付数据已切换，请刷新后重试')
    }
  }
}

export function createHttpDeliveryRepository(): DeliveryWorkspaceRepository {
  return new HttpDeliveryRepository()
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
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
    coverage_type: item.coverage_type, notes: item.notes, status: item.status,
    resolution: item.resolution,
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
