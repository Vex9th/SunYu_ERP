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
  MaterialAdvanceInput,
  MaterialAdvanceReimbursementInput,
  WorkerStatus,
} from '../domain/workforce'
import type {
  DemoCrewAssignmentViewModel,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoSiteDailyReportViewModel,
  DemoWorkerViewModel,
  WorkforceLoadWarning,
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
  | 'updateCrewAssignment'
  | 'updateLaborEntry'
  | 'voidLaborEntry'
  | 'saveSiteDailyReport'
  | 'confirmSiteDailyReport'
  | 'reopenSiteDailyReport'
  | 'saveMaterialAdvance'
  | 'updateMaterialAdvance'
  | 'voidMaterialAdvance'
  | 'recordMaterialAdvanceReimbursement'
  | 'voidMaterialAdvanceReimbursement'
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

interface MaterialAdvanceReimbursementDto {
  id: number
  advance_id: number
  amount_cents: number
  reimbursed_on: string
  payment_method: 'bank_transfer' | 'cash' | 'other'
  notes: string | null
  status: 'active' | 'voided'
  void_reason: string | null
  voided_at: string | null
  revision: number
  created_at: string
  updated_at: string
}

interface MaterialAdvanceReimbursementResponseDto extends MaterialAdvanceReimbursementDto {
  advance_status: DemoMaterialAdvanceViewModel['status']
  advance_reimbursed_amount_cents: number
  advance_outstanding_amount_cents: number
  advance_revision: number
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
  reimbursements: MaterialAdvanceReimbursementDto[]
}

const PREVIEW_PAGE_SIZE = 200
const ADVANCE_DETAIL_CONCURRENCY = 8

async function requestAllPages<T>(
  requestPage: (page: number, pageSize: number) => Promise<PagedResult<T>>,
): Promise<PagedResult<T>> {
  const first = await requestPage(1, PREVIEW_PAGE_SIZE)
  const pageSize = first.page_size > 0 ? first.page_size : PREVIEW_PAGE_SIZE
  const pageCount = Math.ceil(first.total / pageSize)
  if (pageCount <= 1) return first
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => requestPage(index + 2, pageSize)),
  )
  return {
    ...first,
    items: [first, ...remaining].flatMap((page) => page.items),
  }
}

async function settledMapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index] as T) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}

function emptyPage<T>(): PagedResult<T> {
  return { items: [], total: 0, page: 1, page_size: PREVIEW_PAGE_SIZE }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '未知错误'
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
  private advances = new Map<number, MaterialAdvanceDetailDto>()
  private activeProjectKey: string | null = null
  private previewLoadVersion = 0

  async getWorkforcePreview(projectCode: string): Promise<RepositoryResult<WorkforceDemoViewModel>> {
    const loadVersion = ++this.previewLoadVersion
    const requestedProjectKey = projectCacheKey(projectCode)
    const canReusePrevious = this.activeProjectKey === requestedProjectKey
    const previousWorkers = canReusePrevious ? [...this.workers.values()] : undefined
    const previousAssignments = canReusePrevious ? [...this.assignments.values()] : undefined
    const previousLabor = canReusePrevious ? [...this.laborById.values()] : undefined
    const previousReports = canReusePrevious ? [...this.reports.values()] : undefined
    const previousAdvances = canReusePrevious ? [...this.advances.values()] : undefined
    this.activeProjectKey = null
    const project = projectPath(projectCode)
    const results = await Promise.allSettled([
      requestAllPages((page, pageSize) => this.api.listWorkers({ page, page_size: pageSize, status: 'all' }).then((result) => result.data)),
      requestAllPages((page, pageSize) => this.api.listCrewAssignments(projectCode, { page, page_size: pageSize }).then((result) => result.data)),
      requestAllPages((page, pageSize) => this.api.listLaborEntries(projectCode, { page, page_size: pageSize }).then((result) => result.data)),
      requestAllPages((page, pageSize) => requestJson<PagedResult<SiteDailyReportDto>>(
        withQuery(`${project}/site-daily-reports`, { page, page_size: pageSize }),
      )),
      requestAllPages((page, pageSize) => requestJson<PagedResult<MaterialAdvanceSummaryDto>>(
        withQuery(`${project}/material-advances`, { page, page_size: pageSize }),
      )),
    ])
    if (results.every((result) => result.status === 'rejected')) {
      const firstFailure = results.find((result) => result.status === 'rejected')
      if (firstFailure?.status === 'rejected') throw firstFailure.reason
    }
    const warnings: WorkforceLoadWarning[] = []
    const readResult = <T>(
      index: number,
      section: WorkforceLoadWarning['section'],
      label: string,
      previousItems?: readonly T[],
    ): PagedResult<T> => {
      const result = results[index]
      if (result?.status === 'fulfilled') return result.value as PagedResult<T>
      const reason = result?.status === 'rejected' ? result.reason : undefined
      const usingPrevious = previousItems !== undefined
      warnings.push({
        section,
        message: `${label}读取失败：${errorMessage(reason)}${usingPrevious ? '；当前显示上次结果' : ''}`,
      })
      return usingPrevious
        ? { items: [...previousItems], total: previousItems.length, page: 1, page_size: PREVIEW_PAGE_SIZE }
        : emptyPage<T>()
    }
    const workers = readResult<WorkerDto>(0, 'workers', '施工员档案', previousWorkers)
    const assignments = readResult<CrewAssignmentDto>(1, 'crew_assignments', '项目排单', previousAssignments)
    const labor = readResult<LiveLaborEntryDto>(2, 'labor_entries', '上工记录', previousLabor)
    const reports = readResult<SiteDailyReportDto>(3, 'site_daily_reports', '施工日报', previousReports)
    const advanceSummaries = readResult<MaterialAdvanceSummaryDto>(
      4,
      'material_advances',
      '现场垫资',
      previousAdvances,
    )
    const advanceResults = results[4]?.status === 'rejected' && previousAdvances !== undefined
      ? previousAdvances.map((value): PromiseFulfilledResult<MaterialAdvanceDetailDto> => ({ status: 'fulfilled', value }))
      : await settledMapWithConcurrency(
        advanceSummaries.items,
        ADVANCE_DETAIL_CONCURRENCY,
        (item) => requestJson<MaterialAdvanceDetailDto>(`${project}/material-advances/${item.id}`),
      )
    let reusedAdvanceDetails = 0
    const previousAdvanceById = new Map(previousAdvances?.map((item) => [item.id, item]) ?? [])
    const advances = advanceResults.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value]
      const previous = previousAdvanceById.get(advanceSummaries.items[index]?.id ?? -1)
      if (!previous) return []
      reusedAdvanceDetails += 1
      return [previous]
    })
    const failedAdvanceDetails = advanceResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failedAdvanceDetails.length > 0) {
      warnings.push({
        section: 'material_advances',
        message: `现场垫资明细有 ${failedAdvanceDetails.length} 笔读取失败：${errorMessage(failedAdvanceDetails[0]?.reason)}${reusedAdvanceDetails > 0 ? '；失败记录当前显示上次结果' : ''}`,
      })
    }

    if (loadVersion === this.previewLoadVersion) {
      this.activeProjectKey = projectCacheKey(projectCode)
      this.workers = new Map(workers.items.map((item) => [item.id, item]))
      this.assignments = new Map(assignments.items.map((item) => [item.id, item]))
      this.laborByWorkerDate = new Map()
      for (const item of [...labor.items].reverse()) {
        this.laborByWorkerDate.set(laborKey(item.work_date, item.worker_id), item)
      }
      this.laborById = new Map(labor.items.map((item) => [item.id, item]))
      this.reports = new Map(reports.items.map((item) => [item.work_date, item]))
      this.advances = new Map(advances.map((item) => [item.id, item]))
    }

    return live({
      project_code: projectCode,
      ...(warnings.length > 0 ? { load_warnings: warnings } : {}),
      workers: workers.items.map(mapWorker),
      crew_assignments: assignments.items.map(mapAssignment),
      labor_entries: labor.items.map(mapLabor),
      site_daily_reports: reports.items.map(mapReport),
      material_advances: advances.map(mapAdvance),
    })
  }

  async saveLaborEntriesBatch(
    projectCode: string,
    input: Parameters<WorkforceRepository['saveLaborEntriesBatch']>[1],
  ): ReturnType<WorkforceRepository['saveLaborEntriesBatch']> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
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
    if (this.hasProjectContext(projectCode, contextVersion)) {
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
    const contextVersion = this.previewLoadVersion
    const response = await this.api.createCrewAssignment(projectCode, input)
    if (this.hasProjectContext(projectCode, contextVersion)) this.assignments.set(response.data.id, response.data)
    return live(mapAssignment(response.data))
  }

  async updateCrewAssignment(
    projectCode: string,
    assignmentId: number,
    input: Parameters<WorkforceRepository['updateCrewAssignment']>[2],
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.assignments.get(assignmentId)
    if (!current) throw new Error('项目排单不存在，请刷新后重试')
    if (current.status !== 'planned' && current.status !== 'active') {
      throw new Error('已结束的项目排单不能编辑')
    }
    const response = await this.api.updateCrewAssignment(projectCode, assignmentId, {
      ...input,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextVersion)) this.assignments.set(assignmentId, response.data)
  }

  async setCrewAssignmentStatus(
    projectCode: string,
    assignmentId: number,
    status: CrewAssignmentStatus,
    reason: string | null,
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.assignments.get(assignmentId)
    if (!current) throw new Error('项目排单不存在，请刷新后重试')
    const response = await this.api.transitionCrewAssignment(projectCode, assignmentId, {
      to_status: status,
      effective_at: new Date().toISOString(),
      reason,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextVersion)) this.assignments.set(assignmentId, response.data)
  }

  async updateLaborEntry(
    projectCode: string,
    entryId: number,
    input: LaborEntryUpdateInput,
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.laborById.get(entryId)
    if (!current) throw new Error('上工记录不存在，请刷新后重试')
    const response = await this.api.updateLaborEntry(projectCode, entryId, {
      ...input,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextVersion)) this.cacheLabor(response.data)
  }

  async voidLaborEntry(projectCode: string, entryId: number, reason: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.laborById.get(entryId)
    if (!current) throw new Error('上工记录不存在，请刷新后重试')
    const response = await this.api.voidLaborEntry(projectCode, entryId, {
      reason,
      expected_revision: current.revision,
    })
    if (this.hasProjectContext(projectCode, contextVersion)) this.cacheLabor(response.data)
  }

  async saveSiteDailyReport(projectCode: string, input: Parameters<WorkforceRepository['saveSiteDailyReport']>[1]): ReturnType<WorkforceRepository['saveSiteDailyReport']> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const data = await requestJson<SiteDailyReportDto>(
      `${projectPath(projectCode)}/site-daily-reports/${input.work_date}`,
      { method: 'PUT', body: { ...input, work_date: undefined, expected_revision: this.reports.get(input.work_date)?.revision ?? null } },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.reports.set(data.work_date, data)
    return live(mapReport(data))
  }

  async confirmSiteDailyReport(projectCode: string, workDate: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.reports.get(workDate)
    if (!current) throw new Error('施工日报不存在，请刷新后重试')
    const data = await this.postSender.send<SiteDailyReportDto>(
      `${projectPath(projectCode)}/site-daily-reports/${workDate}/confirm`,
      { confirmed_at: new Date().toISOString(), expected_revision: current.revision },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.reports.set(workDate, data)
  }

  async reopenSiteDailyReport(projectCode: string, workDate: string, reason: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.reports.get(workDate)
    if (!current) throw new Error('施工日报不存在，请刷新后重试')
    const data = await this.postSender.send<SiteDailyReportDto>(
      `${projectPath(projectCode)}/site-daily-reports/${workDate}/reopen`,
      { reason, expected_revision: current.revision },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.reports.set(workDate, data)
  }

  async saveMaterialAdvance(projectCode: string, input: Parameters<WorkforceRepository['saveMaterialAdvance']>[1]): ReturnType<WorkforceRepository['saveMaterialAdvance']> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const data = await this.postSender.send<MaterialAdvanceDetailDto>(
      `${projectPath(projectCode)}/material-advances`,
      materialAdvancePayload(input),
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.advances.set(data.id, data)
    return live(mapAdvance(data))
  }

  async updateMaterialAdvance(projectCode: string, advanceId: number, input: MaterialAdvanceInput): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.advances.get(advanceId)
    if (!current) throw new Error('垫资记录不存在，请刷新后重试')
    if (current.status === 'voided') throw new Error('已作废垫资不能编辑')
    if (current.reimbursed_amount_cents !== 0) throw new Error('已有有效报销的垫资不能编辑')
    const data = await requestJson<MaterialAdvanceDetailDto>(
      `${projectPath(projectCode)}/material-advances/${advanceId}`,
      { method: 'PUT', body: { ...materialAdvancePayload(input), expected_revision: current.revision } },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.advances.set(advanceId, data)
  }

  async voidMaterialAdvance(projectCode: string, advanceId: number, reason: string): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.advances.get(advanceId)
    if (!current) throw new Error('垫资记录不存在，请刷新后重试')
    const data = await this.postSender.send<MaterialAdvanceDetailDto>(
      `${projectPath(projectCode)}/material-advances/${advanceId}/void`,
      { reason, expected_revision: current.revision },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.advances.set(advanceId, data)
  }

  async recordMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    input: Parameters<WorkforceRepository['recordMaterialAdvanceReimbursement']>[2],
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.advances.get(advanceId)
    if (!current) throw new Error('垫资记录不存在，请刷新后重试')
    const reimbursement = await this.postSender.send<MaterialAdvanceReimbursementResponseDto>(
      `${projectPath(projectCode)}/material-advances/${advanceId}/reimbursements`,
      input,
    )
    if (this.hasProjectContext(projectCode, contextVersion)) {
      this.cacheReimbursement(current, reimbursement)
    }
  }

  async voidMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    reimbursementId: number,
    reason: string,
  ): Promise<void> {
    this.requireProjectContext(projectCode)
    const contextVersion = this.previewLoadVersion
    const current = this.advances.get(advanceId)
    const reimbursement = current?.reimbursements.find((item) => item.id === reimbursementId)
    if (!current || !reimbursement) throw new Error('报销记录不存在，请刷新后重试')
    const data = await this.postSender.send<MaterialAdvanceReimbursementResponseDto>(
      `${projectPath(projectCode)}/material-advances/${advanceId}/reimbursements/${reimbursementId}/void`,
      { reason, expected_revision: reimbursement.revision },
    )
    if (this.hasProjectContext(projectCode, contextVersion)) this.cacheReimbursement(current, data)
  }

  private hasProjectContext(projectCode: string, contextVersion?: number): boolean {
    return this.activeProjectKey === projectCacheKey(projectCode)
      && (contextVersion === undefined || contextVersion === this.previewLoadVersion)
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

  private cacheReimbursement(
    advance: MaterialAdvanceDetailDto,
    reimbursement: MaterialAdvanceReimbursementResponseDto,
  ): void {
    const next = advance.reimbursements.filter((item) => item.id !== reimbursement.id)
    next.push(reimbursement)
    advance.reimbursements = next.sort((left, right) => (
      left.reimbursed_on.localeCompare(right.reimbursed_on) || left.id - right.id
    ))
    advance.status = reimbursement.advance_status
    advance.reimbursed_amount_cents = reimbursement.advance_reimbursed_amount_cents
    advance.outstanding_amount_cents = reimbursement.advance_outstanding_amount_cents
    advance.revision = reimbursement.advance_revision
    advance.updated_at = reimbursement.updated_at
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
    replaces_entry_id: item.replaces_entry_id ?? null,
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
    versions: structuredClone(item.versions ?? []),
    events: structuredClone(item.events ?? []),
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
    void_reason: item.void_reason,
    voided_at: item.voided_at,
    reimbursements: item.reimbursements.map((entry) => ({
      reimbursement_id: entry.id,
      amount_cents: entry.amount_cents,
      reimbursed_on: entry.reimbursed_on,
      payment_method: entry.payment_method,
      notes: entry.notes,
      status: entry.status,
      void_reason: entry.void_reason,
      voided_at: entry.voided_at,
    })),
  }
}

function materialAdvancePayload(input: MaterialAdvanceInput): object {
  return {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      line_amount_cents: lineAmount(item.quantity, item.unit_price_cents),
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
