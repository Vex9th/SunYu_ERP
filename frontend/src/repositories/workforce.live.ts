import { createRetriablePostSender, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  CrewAssignmentDto,
  CrewAssignmentInput,
  CrewAssignmentUpdateInput,
  LaborBatchInput,
  LaborEntryDto,
  PaginationQuery,
  WorkerDeactivateInput,
  WorkerDto,
  WorkerInput,
  WorkerUpdateInput,
} from '../domain/operations-api'
import type {
  CrewAssignmentStatus,
  LaborEntryUpdateInput,
  WorkerStatus,
} from '../domain/workforce'
import type {
  DemoCrewAssignmentViewModel,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoSiteDailyReportViewModel,
  DemoWorkerViewModel,
  WorkforceDemoViewModel,
} from '../domain/workforce'
import type { RepositoryResult } from './common'
import type { WorkforceRepository } from './workforce'

export interface WorkerListQuery extends PaginationQuery {
  status?: WorkerStatus | 'all'
  query?: string
}

export interface CrewAssignmentListQuery extends PaginationQuery {
  status?: CrewAssignmentStatus | 'all'
}

export interface LaborEntryListQuery extends PaginationQuery {
  from?: string
  to?: string
  worker_id?: number
}

export interface WorkerReactivateInput {
  expected_revision: number
}

export interface CrewAssignmentTransitionInput {
  to_status: CrewAssignmentStatus
  effective_at: string
  reason: string | null
  expected_revision: number
}

export interface LaborEntryApiUpdateInput extends LaborEntryUpdateInput {
  expected_revision: number
}

export interface LaborEntryVoidInput {
  reason: string
  expected_revision: number
}

export interface LiveLaborEntryDto extends LaborEntryDto {
  void_reason: string | null
  voided_at: string | null
}

export interface LiveLaborBatchDto {
  work_date: string
  items: LiveLaborEntryDto[]
}

export interface WorkforceHttpRepository {
  listWorkers(query?: WorkerListQuery): Promise<RepositoryResult<PagedResult<WorkerDto>>>
  createWorker(input: WorkerInput): Promise<RepositoryResult<WorkerDto>>
  getWorker(workerId: number): Promise<RepositoryResult<WorkerDto>>
  updateWorker(workerId: number, input: WorkerUpdateInput): Promise<RepositoryResult<WorkerDto>>
  deactivateWorker(workerId: number, input: WorkerDeactivateInput): Promise<RepositoryResult<WorkerDto>>
  reactivateWorker(workerId: number, input: WorkerReactivateInput): Promise<RepositoryResult<WorkerDto>>
  listCrewAssignments(projectCode: string, query?: CrewAssignmentListQuery): Promise<RepositoryResult<PagedResult<CrewAssignmentDto>>>
  createCrewAssignment(projectCode: string, input: CrewAssignmentInput): Promise<RepositoryResult<CrewAssignmentDto>>
  updateCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentUpdateInput): Promise<RepositoryResult<CrewAssignmentDto>>
  transitionCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentTransitionInput): Promise<RepositoryResult<CrewAssignmentDto>>
  listLaborEntries(projectCode: string, query?: LaborEntryListQuery): Promise<RepositoryResult<PagedResult<LiveLaborEntryDto>>>
  createLaborEntry(projectCode: string, input: LaborEntryUpdateInput): Promise<RepositoryResult<LiveLaborEntryDto>>
  updateLaborEntry(projectCode: string, entryId: number, input: LaborEntryApiUpdateInput): Promise<RepositoryResult<LiveLaborEntryDto>>
  voidLaborEntry(projectCode: string, entryId: number, input: LaborEntryVoidInput): Promise<RepositoryResult<LiveLaborEntryDto>>
  saveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): Promise<RepositoryResult<LiveLaborBatchDto>>
  discardSaveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): boolean
}

class HttpWorkforceRepository implements WorkforceHttpRepository {
  private readonly postSender = createRetriablePostSender()

  async listWorkers(query: WorkerListQuery = {}): Promise<RepositoryResult<PagedResult<WorkerDto>>> {
    return live(await requestJson(withQuery('/api/workers', query)))
  }

  async createWorker(input: WorkerInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await this.postSender.send('/api/workers', input))
  }

  async getWorker(workerId: number): Promise<RepositoryResult<WorkerDto>> {
    return live(await requestJson(workerPath(workerId)))
  }

  async updateWorker(workerId: number, input: WorkerUpdateInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await requestJson(workerPath(workerId), { method: 'PUT', body: input }))
  }

  async deactivateWorker(workerId: number, input: WorkerDeactivateInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await this.postSender.send(`${workerPath(workerId)}/deactivate`, input))
  }

  async reactivateWorker(workerId: number, input: WorkerReactivateInput): Promise<RepositoryResult<WorkerDto>> {
    return live(await this.postSender.send(`${workerPath(workerId)}/reactivate`, input))
  }

  async listCrewAssignments(projectCode: string, query: CrewAssignmentListQuery = {}): Promise<RepositoryResult<PagedResult<CrewAssignmentDto>>> {
    return live(await requestJson(withQuery(assignmentCollectionPath(projectCode), query)))
  }

  async createCrewAssignment(projectCode: string, input: CrewAssignmentInput): Promise<RepositoryResult<CrewAssignmentDto>> {
    return live(await this.postSender.send(assignmentCollectionPath(projectCode), input))
  }

  async updateCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentUpdateInput): Promise<RepositoryResult<CrewAssignmentDto>> {
    return live(await requestJson(`${assignmentCollectionPath(projectCode)}/${assignmentId}`, {
      method: 'PUT',
      body: input,
    }))
  }

  async transitionCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentTransitionInput): Promise<RepositoryResult<CrewAssignmentDto>> {
    return live(await this.postSender.send(`${assignmentCollectionPath(projectCode)}/${assignmentId}/transition`, input))
  }

  async listLaborEntries(projectCode: string, query: LaborEntryListQuery = {}): Promise<RepositoryResult<PagedResult<LiveLaborEntryDto>>> {
    return live(await requestJson(withQuery(`${projectPath(projectCode)}/labor-entries`, query)))
  }

  async createLaborEntry(projectCode: string, input: LaborEntryUpdateInput): Promise<RepositoryResult<LiveLaborEntryDto>> {
    return live(await this.postSender.send(`${projectPath(projectCode)}/labor-entries`, input))
  }

  async updateLaborEntry(projectCode: string, entryId: number, input: LaborEntryApiUpdateInput): Promise<RepositoryResult<LiveLaborEntryDto>> {
    return live(await requestJson(`${projectPath(projectCode)}/labor-entries/${entryId}`, {
      method: 'PUT',
      body: input,
    }))
  }

  async voidLaborEntry(projectCode: string, entryId: number, input: LaborEntryVoidInput): Promise<RepositoryResult<LiveLaborEntryDto>> {
    return live(await this.postSender.send(`${projectPath(projectCode)}/labor-entries/${entryId}/void`, input))
  }

  async saveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): Promise<RepositoryResult<LiveLaborBatchDto>> {
    return live(await this.postSender.send(`${projectPath(projectCode)}/labor-entries/batch`, input))
  }

  discardSaveLaborEntriesBatch(projectCode: string, input: LaborBatchInput): boolean {
    return this.postSender.discard(`${projectPath(projectCode)}/labor-entries/batch`, input)
  }
}

export function createHttpWorkforceRepository(): WorkforceHttpRepository {
  return new HttpWorkforceRepository()
}

type WorkforceWorkspaceMethods = Pick<
  WorkforceRepository,
  | 'getWorkforcePreview'
  | 'saveLaborEntriesBatch'
  | 'createWorker'
  | 'updateWorker'
  | 'setWorkerStatus'
  | 'assignWorker'
  | 'updateLaborEntry'
  | 'voidLaborEntry'
  | 'saveSiteDailyReport'
  | 'confirmSiteDailyReport'
  | 'saveMaterialAdvance'
  | 'recordMaterialAdvanceReimbursement'
>

export interface WorkforceWorkspaceRepository extends WorkforceWorkspaceMethods {
  readonly source: 'live' | 'demo'
  setCrewAssignmentStatus(
    projectCode: string,
    assignmentId: number,
    status: CrewAssignmentStatus,
    reason: string | null,
  ): Promise<void>
}

interface SiteDailyReportDto extends DemoSiteDailyReportViewModel {
  id: number
  project_code: string
  confirmed_at: string | null
  revision: number
  created_at: string
  updated_at: string
}

interface MaterialAdvanceSummaryDto {
  id: number
  project_code: string
  worker_id: number
  worker_name: string
  spent_on: string
  vendor_name: string | null
  total_amount_cents: number
  reimbursed_amount_cents: number
  outstanding_amount_cents: number
  notes: string | null
  status: DemoMaterialAdvanceViewModel['status']
  void_reason: string | null
  voided_at: string | null
  document_version_ids: number[]
  revision: number
  created_at: string
  updated_at: string
}

interface MaterialAdvanceDetailDto extends MaterialAdvanceSummaryDto {
  items: Array<{
    id: number
    line_number: number
    name: string
    specification: string | null
    brand: string | null
    quantity: string
    unit: string
    unit_price_cents: number
    line_amount_cents: number
  }>
  reimbursements: Array<{
    id: number
    advance_id: number
    amount_cents: number
    reimbursed_on: string
    payment_method: 'bank_transfer' | 'cash' | 'other'
    notes: string | null
    status: 'active' | 'voided'
    revision: number
    created_at: string
    updated_at: string
  }>
}

class HttpWorkforceWorkspaceRepository implements WorkforceWorkspaceRepository {
  readonly source = 'live' as const
  private readonly api = createHttpWorkforceRepository()
  private readonly postSender = createRetriablePostSender()
  private workers = new Map<number, WorkerDto>()
  private assignments = new Map<number, CrewAssignmentDto>()
  private laborByWorkerDate = new Map<string, LiveLaborEntryDto>()
  private laborById = new Map<number, LiveLaborEntryDto>()
  private reports = new Map<string, SiteDailyReportDto>()
  private activeProjectKey: string | null = null
  private previewLoadVersion = 0

  async getWorkforcePreview(projectCode: string): Promise<RepositoryResult<WorkforceDemoViewModel>> {
    const loadVersion = ++this.previewLoadVersion
    const project = projectPath(projectCode)
    const [workers, assignments, labor, reports, advanceSummaries] = await Promise.all([
      this.api.listWorkers({ page: 1, page_size: 200, status: 'all' }),
      this.api.listCrewAssignments(projectCode, { page: 1, page_size: 200 }),
      this.listAllLaborEntries(projectCode),
      requestJson<PagedResult<SiteDailyReportDto>>(withQuery(`${project}/site-daily-reports`, { page: 1, page_size: 200 })),
      requestJson<PagedResult<MaterialAdvanceSummaryDto>>(withQuery(`${project}/material-advances`, { page: 1, page_size: 200 })),
    ])
    const advances = await Promise.all(advanceSummaries.items.map((item) => (
      requestJson<MaterialAdvanceDetailDto>(`${project}/material-advances/${item.id}`)
    )))

    if (loadVersion === this.previewLoadVersion) {
      this.activeProjectKey = projectCacheKey(projectCode)
      this.workers = new Map(workers.data.items.map((item) => [item.id, item]))
      this.assignments = new Map(assignments.data.items.map((item) => [item.id, item]))
      this.laborByWorkerDate = new Map(labor.data.items.map((item) => [laborKey(item.work_date, item.worker_id), item]))
      this.laborById = new Map(labor.data.items.map((item) => [item.id, item]))
      this.reports = new Map(reports.items.map((item) => [item.work_date, item]))
    }

    return live({
      project_code: projectCode,
      workers: workers.data.items.map(mapWorker),
      crew_assignments: assignments.data.items.map(mapAssignment),
      labor_entries: labor.data.items.map(mapLabor),
      site_daily_reports: reports.items.map(mapReport),
      material_advances: advances.map(mapAdvance),
    })
  }

  async saveLaborEntriesBatch(
    projectCode: string,
    input: Parameters<WorkforceRepository['saveLaborEntriesBatch']>[1],
  ): ReturnType<WorkforceRepository['saveLaborEntriesBatch']> {
    this.requireProjectContext(projectCode)
    const response = await this.api.saveLaborEntriesBatch(projectCode, {
      work_date: input.work_date,
      entries: input.entries.map((entry) => {
        const workerId = this.assignments.get(entry.assignment_id)?.worker_id
        return {
          ...entry,
          expected_revision: workerId === undefined
            ? null
            : this.laborByWorkerDate.get(laborKey(input.work_date, workerId))?.revision ?? null,
        }
      }),
    })
    if (this.hasProjectContext(projectCode)) {
      for (const item of response.data.items) {
        this.cacheLabor(item)
      }
    }
    return live(response.data.items.map(mapLabor))
  }

  async createWorker(input: Parameters<WorkforceRepository['createWorker']>[0]): ReturnType<WorkforceRepository['createWorker']> {
    const response = await this.api.createWorker(input)
    this.workers.set(response.data.id, response.data)
    return live(mapWorker(response.data))
  }

  async updateWorker(workerId: number, input: Parameters<WorkforceRepository['updateWorker']>[1]): Promise<void> {
    const current = (await this.api.getWorker(workerId)).data
    const response = await this.api.updateWorker(workerId, { ...input, expected_revision: current.revision })
    this.workers.set(workerId, response.data)
  }

  async setWorkerStatus(workerId: number, status: WorkerStatus): Promise<void> {
    const current = (await this.api.getWorker(workerId)).data
    const response = status === 'active'
      ? await this.api.reactivateWorker(workerId, { expected_revision: current.revision })
      : await this.api.deactivateWorker(workerId, {
        effective_on: localBusinessDate(),
        reason: '从施工人员页停用',
        expected_revision: current.revision,
      })
    this.workers.set(workerId, response.data)
  }

  async assignWorker(projectCode: string, input: Parameters<WorkforceRepository['assignWorker']>[1]): ReturnType<WorkforceRepository['assignWorker']> {
    this.requireProjectContext(projectCode)
    const response = await this.api.createCrewAssignment(projectCode, input)
    if (this.hasProjectContext(projectCode)) this.assignments.set(response.data.id, response.data)
    return live(mapAssignment(response.data))
  }

  async setCrewAssignmentStatus(
    projectCode: string,
    assignmentId: number,
    status: CrewAssignmentStatus,
    reason: string | null,
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = this.assignments.get(assignmentId)
    if (!current) throw new Error('项目排单不存在，请刷新后重试')
    const response = await this.api.transitionCrewAssignment(projectCode, assignmentId, {
      to_status: status,
      effective_at: new Date().toISOString(),
      reason,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.assignments.set(assignmentId, response.data)
  }

  async updateLaborEntry(
    projectCode: string,
    entryId: number,
    input: LaborEntryUpdateInput,
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = this.laborById.get(entryId)
    if (!current) throw new Error('上工记录不存在，请刷新后重试')
    const response = await this.api.updateLaborEntry(projectCode, entryId, {
      ...input,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.cacheLabor(response.data)
  }

  async voidLaborEntry(projectCode: string, entryId: number, reason: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = this.laborById.get(entryId)
    if (!current) throw new Error('上工记录不存在，请刷新后重试')
    const response = await this.api.voidLaborEntry(projectCode, entryId, {
      reason,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode)) this.cacheLabor(response.data)
  }

  async saveSiteDailyReport(projectCode: string, input: Parameters<WorkforceRepository['saveSiteDailyReport']>[1]): ReturnType<WorkforceRepository['saveSiteDailyReport']> {
    this.requireProjectContext(projectCode)
    const data = await requestJson<SiteDailyReportDto>(
      `${projectPath(projectCode)}/site-daily-reports/${input.work_date}`,
      { method: 'PUT', body: { ...input, work_date: undefined, expected_revision: this.reports.get(input.work_date)?.revision ?? null } },
    )
    if (this.hasProjectContext(projectCode)) this.reports.set(data.work_date, data)
    return live(mapReport(data))
  }

  async confirmSiteDailyReport(projectCode: string, workDate: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const current = this.reports.get(workDate)
    if (!current) throw new Error('施工日报不存在，请刷新后重试')
    const data = await this.postSender.send<SiteDailyReportDto>(
      `${projectPath(projectCode)}/site-daily-reports/${workDate}/confirm`,
      { confirmed_at: new Date().toISOString(), expected_revision: current.revision },
    )
    if (this.hasProjectContext(projectCode)) this.reports.set(workDate, data)
  }

  async saveMaterialAdvance(projectCode: string, input: Parameters<WorkforceRepository['saveMaterialAdvance']>[1]): ReturnType<WorkforceRepository['saveMaterialAdvance']> {
    const data = await this.postSender.send<MaterialAdvanceDetailDto>(
      `${projectPath(projectCode)}/material-advances`,
      {
        ...input,
        items: input.items.map((item) => ({ ...item, line_amount_cents: lineAmount(item.quantity, item.unit_price_cents) })),
      },
    )
    return live(mapAdvance(data))
  }

  async recordMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    input: Parameters<WorkforceRepository['recordMaterialAdvanceReimbursement']>[2],
  ): Promise<void> {
    await this.postSender.send(
      `${projectPath(projectCode)}/material-advances/${advanceId}/reimbursements`,
      input,
    )
  }

  private async listAllLaborEntries(projectCode: string): Promise<RepositoryResult<PagedResult<LiveLaborEntryDto>>> {
    const first = await this.api.listLaborEntries(projectCode, { page: 1, page_size: 200 })
    const pageSize = first.data.page_size > 0 ? first.data.page_size : 200
    const pageCount = Math.ceil(first.data.total / pageSize)
    if (pageCount <= 1) return first
    const remaining = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, index) => (
        this.api.listLaborEntries(projectCode, { page: index + 2, page_size: pageSize })
      )),
    )
    return live({
      ...first.data,
      items: [first.data.items, ...remaining.map((page) => page.data.items)].flat(),
    })
  }

  private hasProjectContext(projectCode: string): boolean {
    return this.activeProjectKey === projectCacheKey(projectCode)
  }

  private requireProjectContext(projectCode: string): void {
    if (!this.hasProjectContext(projectCode)) {
      throw new Error('项目施工数据已切换，请刷新后重试')
    }
  }

  private cacheLabor(item: LiveLaborEntryDto): void {
    const previous = this.laborById.get(item.id)
    if (previous) this.laborByWorkerDate.delete(laborKey(previous.work_date, previous.worker_id))
    this.laborById.set(item.id, item)
    this.laborByWorkerDate.set(laborKey(item.work_date, item.worker_id), item)
  }
}

export function createHttpWorkforceWorkspaceRepository(): WorkforceWorkspaceRepository {
  return new HttpWorkforceWorkspaceRepository()
}

function workerPath(workerId: number): string {
  return `/api/workers/${workerId}`
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function assignmentCollectionPath(projectCode: string): string {
  return `${projectPath(projectCode)}/crew-assignments`
}

function projectCacheKey(projectCode: string): string {
  return projectCode.trim()
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}

function mapWorker(item: WorkerDto): DemoWorkerViewModel {
  return { worker_id: item.id, name: item.name, phone: item.phone, notes: item.notes, status: item.status }
}

function mapAssignment(item: CrewAssignmentDto): DemoCrewAssignmentViewModel {
  return {
    assignment_id: item.id,
    worker_id: item.worker_id,
    role: item.role,
    scheduled_start_on: item.scheduled_start_on,
    scheduled_end_on: item.scheduled_end_on ?? '9999-12-31',
    pay_basis: item.pay_basis,
    rate_cents: item.rate_cents,
    notes: item.notes,
    status: item.status,
  }
}

function mapLabor(item: LiveLaborEntryDto): DemoLaborEntryViewModel {
  return {
    entry_id: item.id,
    assignment_id: item.assignment_id,
    work_date: item.work_date,
    attendance_status: item.attendance_status,
    day_fraction: item.day_fraction,
    work_minutes: item.work_minutes,
    work_summary: item.work_summary,
    notes: item.notes,
    cost_cents: item.cost_cents,
    status: item.status,
    void_reason: item.void_reason ?? null,
  }
}

function mapReport(item: SiteDailyReportDto): DemoSiteDailyReportViewModel {
  return {
    work_date: item.work_date,
    location: item.location,
    weather: item.weather,
    work_summary: item.work_summary,
    blockers: item.blockers,
    next_plan: item.next_plan,
    notes: item.notes,
    status: item.status,
  }
}

function mapAdvance(item: MaterialAdvanceDetailDto): DemoMaterialAdvanceViewModel {
  return {
    advance_id: item.id,
    worker_id: item.worker_id,
    spent_on: item.spent_on,
    vendor_name: item.vendor_name ?? '',
    items: item.items.map((line) => ({
      name: line.name,
      specification: line.specification,
      brand: line.brand,
      quantity: line.quantity,
      unit: line.unit,
      unit_price_cents: line.unit_price_cents,
      line_amount_cents: line.line_amount_cents,
    })),
    notes: item.notes,
    document_version_ids: item.document_version_ids,
    status: item.status,
    reimbursements: item.reimbursements
      .filter((entry) => entry.status === 'active')
      .map((entry) => ({
        amount_cents: entry.amount_cents,
        reimbursed_on: entry.reimbursed_on,
        payment_method: entry.payment_method,
        notes: entry.notes,
      })),
  }
}

function laborKey(workDate: string, workerId: number): string {
  return `${workDate}:${workerId}`
}

function lineAmount(quantity: string, unitPriceCents: number): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity)
  if (!match) throw new Error('垫资物料数量格式不正确')
  const milli = BigInt(match[1] ?? '0') * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'))
  const amount = (milli * BigInt(unitPriceCents) + 500n) / 1000n
  const result = Number(amount)
  if (!Number.isSafeInteger(result)) throw new Error('垫资金额超出可保存范围')
  return result
}

function localBusinessDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
