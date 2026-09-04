import type {
  AcceptanceInput,
  AcceptanceCompletionInput,
  AfterSalesStatus,
  AfterSalesInput,
  CommissioningSessionInput,
  CrewAssignmentStatus,
  CrewAssignmentInput,
  DemoCrewAssignmentViewModel,
  DemoLaborEntryViewModel,
  DemoMaterialAdvanceViewModel,
  DemoSiteDailyReportViewModel,
  DemoWorkerViewModel,
  DeliveryDemoViewModel,
  DeliverySummaryViewModel,
  DrawingDiscipline,
  DrawingSignoffInput,
  EngineeringChangeInput,
  EngineeringChangeStatus,
  InvoiceInput,
  LaborEntryBatchInput,
  LaborEntryBatchItemInput,
  LaborEntryUpdateInput,
  MaterialAdvanceInput,
  MaterialAdvanceReimbursementInput,
  SiteDailyReportInput,
  WarrantyInput,
  WorkerInput,
  WorkerStatus,
  WorkforceDemoViewModel,
} from '../domain/workforce'
import type { DataSource, RepositoryResult } from './common'

export interface WorkforceRepository {
  readonly source: DataSource
  getWorkforcePreview(projectCode: string): Promise<RepositoryResult<WorkforceDemoViewModel>>
  saveLaborEntriesBatch(
    projectCode: string,
    input: LaborEntryBatchInput,
  ): Promise<RepositoryResult<DemoLaborEntryViewModel[]>>
  createWorker(input: WorkerInput): Promise<RepositoryResult<DemoWorkerViewModel>>
  updateWorker(workerId: number, input: WorkerInput): Promise<void>
  setWorkerStatus(workerId: number, status: WorkerStatus): Promise<void>
  assignWorker(projectCode: string, input: CrewAssignmentInput): Promise<RepositoryResult<DemoCrewAssignmentViewModel>>
  updateCrewAssignment(projectCode: string, assignmentId: number, input: CrewAssignmentInput): Promise<void>
  setCrewAssignmentStatus(projectCode: string, assignmentId: number, status: CrewAssignmentStatus): Promise<void>
  updateLaborEntry(projectCode: string, entryId: number, input: LaborEntryUpdateInput): Promise<void>
  voidLaborEntry(projectCode: string, entryId: number, reason: string): Promise<void>
  saveSiteDailyReport(projectCode: string, input: SiteDailyReportInput): Promise<RepositoryResult<DemoSiteDailyReportViewModel>>
  confirmSiteDailyReport(projectCode: string, workDate: string): Promise<void>
  reopenSiteDailyReport(projectCode: string, workDate: string, reason: string): Promise<void>
  saveMaterialAdvance(projectCode: string, input: MaterialAdvanceInput): Promise<RepositoryResult<DemoMaterialAdvanceViewModel>>
  updateMaterialAdvance(projectCode: string, advanceId: number, input: MaterialAdvanceInput): Promise<void>
  voidMaterialAdvance(projectCode: string, advanceId: number, reason: string): Promise<void>
  recordMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    input: MaterialAdvanceReimbursementInput,
  ): Promise<void>
  voidMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    reimbursementId: number,
    reason: string,
  ): Promise<void>
  getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>>
  getDeliverySummary(projectCode: string): Promise<RepositoryResult<DeliverySummaryViewModel>>
  saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput): Promise<void>
  saveCommissioningSession(projectCode: string, input: CommissioningSessionInput): Promise<void>
  discardSaveCommissioningSession(projectCode: string, input: CommissioningSessionInput, files?: readonly File[]): boolean
  updateCommissioningSession(projectCode: string, sessionId: number, input: CommissioningSessionInput): Promise<void>
  saveEngineeringChange(projectCode: string, input: EngineeringChangeInput): Promise<void>
  discardSaveEngineeringChange(projectCode: string, input: EngineeringChangeInput, files?: readonly File[]): boolean
  updateEngineeringChange(projectCode: string, changeId: number, input: EngineeringChangeInput): Promise<void>
  setEngineeringChangeStatus(projectCode: string, changeId: number, status: EngineeringChangeStatus): Promise<void>
  saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void>
  discardSaveAcceptance(projectCode: string, input: AcceptanceInput): boolean
  rescheduleAcceptance(projectCode: string, acceptanceId: number, input: AcceptanceInput, reason: string): Promise<void>
  cancelAcceptance(projectCode: string, acceptanceId: number, reason: string): Promise<void>
  completeAcceptance(projectCode: string, acceptanceId: number, input: AcceptanceCompletionInput): Promise<void>
  updateWarranty(projectCode: string, input: WarrantyInput): Promise<void>
  saveInvoice(projectCode: string, input: InvoiceInput, files?: readonly File[]): Promise<void>
  updateInvoice(projectCode: string, invoiceId: number, input: InvoiceInput): Promise<void>
  discardSaveInvoice(projectCode: string, input: InvoiceInput, files?: readonly File[]): boolean
  voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void>
  saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void>
  discardSaveAfterSalesCase(projectCode: string, input: AfterSalesInput): boolean
  updateAfterSalesCase(projectCode: string, caseId: number, input: AfterSalesInput): Promise<void>
  setAfterSalesStatus(projectCode: string, caseId: number, status: AfterSalesStatus, resolution: string | null): Promise<void>
}

export class MockWorkforceRepository implements WorkforceRepository {
  readonly source = 'demo' as const
  private readonly workforce = new Map<string, WorkforceDemoViewModel>()
  private readonly deliveries = new Map<string, DeliveryDemoViewModel>()
  private readonly createdWorkers: DemoWorkerViewModel[] = []
  private nextLaborEntryId = 1000
  private nextReportVersionId = 1000
  private nextReportEventId = 1000
  private nextWorkerId = 1000
  private nextAssignmentId = 2000
  private nextAdvanceId = 3000
  private nextReimbursementId = 3000
  private nextDeliveryId = 4000

  async getWorkforcePreview(projectCode: string): Promise<RepositoryResult<WorkforceDemoViewModel>> {
    return { source: this.source, data: clone(this.workspace(projectCode)) }
  }

  async getDeliverySummary(projectCode: string): Promise<RepositoryResult<DeliverySummaryViewModel>> {
    return {
      source: this.source,
      data: {
        project_code: projectCode,
        final_payment: {
          due_on: '2026-10-20',
          planned_amount_cents: 20000000,
          received_amount_cents: 0,
          outstanding_amount_cents: 20000000,
        },
      },
    }
  }

  async saveLaborEntriesBatch(
    projectCode: string,
    input: LaborEntryBatchInput,
  ): Promise<RepositoryResult<DemoLaborEntryViewModel[]>> {
    if (!projectCode.trim()) throw new Error('项目编号不能为空')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.work_date)) throw new Error('上工日期格式不正确')
    if (input.entries.length === 0) throw new Error('至少选择一名施工员')

    const workspace = this.workspace(projectCode)
    const workerIds = new Set<number>()
    const validated = input.entries.map((entry) => {
      const assignment = workspace.crew_assignments.find(
        (candidate) => candidate.assignment_id === entry.assignment_id,
      )
      if (!assignment) throw new Error('项目排单不存在')
      if (workerIds.has(assignment.worker_id)) throw new Error('同一施工员不能重复提交')
      workerIds.add(assignment.worker_id)
      return {
        assignment,
        entry,
        costCents: laborCost(assignment, entry),
      }
    })

    const saved = validated.map(({ assignment, entry, costCents }) => {
      const existing = workspace.labor_entries.find(
        (candidate) => candidate.status === 'active' && candidate.work_date === input.work_date
          && workspace.crew_assignments.some(
            (candidateAssignment) => candidateAssignment.assignment_id === candidate.assignment_id
              && candidateAssignment.worker_id === assignment.worker_id,
          ),
      )
      const replaced = existing ? undefined : workspace.labor_entries.find(
        (candidate) => candidate.status === 'voided' && candidate.work_date === input.work_date
          && workspace.crew_assignments.some(
            (candidateAssignment) => candidateAssignment.assignment_id === candidate.assignment_id
              && candidateAssignment.worker_id === assignment.worker_id,
          ),
      )
      const value: DemoLaborEntryViewModel = {
        entry_id: existing?.entry_id ?? this.nextLaborEntryId++,
        assignment_id: entry.assignment_id,
        replaces_entry_id: existing?.replaces_entry_id ?? replaced?.entry_id ?? null,
        work_date: input.work_date,
        attendance_status: entry.attendance_status,
        day_fraction: entry.day_fraction,
        work_minutes: entry.work_minutes,
        work_summary: normalizedOptionalText(entry.work_summary),
        notes: normalizedOptionalText(entry.notes),
        cost_cents: costCents,
        status: 'active',
        void_reason: null,
      }
      if (existing) Object.assign(existing, value)
      else workspace.labor_entries.unshift(value)
      return clone(value)
    })

    return { source: this.source, data: saved }
  }

  async getDeliveryPreview(projectCode: string): Promise<RepositoryResult<DeliveryDemoViewModel>> {
    return { source: this.source, data: clone(this.deliveryWorkspace(projectCode)) }
  }

  async createWorker(input: WorkerInput): Promise<RepositoryResult<DemoWorkerViewModel>> {
    if (!input.name.trim()) throw new Error('施工员姓名不能为空')
    const worker: DemoWorkerViewModel = {
      worker_id: this.nextWorkerId++,
      name: input.name.trim(),
      phone: normalizedOptionalText(input.phone),
      notes: normalizedOptionalText(input.notes),
      status: 'active',
    }
    this.createdWorkers.push(worker)
    for (const workspace of this.workforce.values()) workspace.workers.push(worker)
    return { source: this.source, data: clone(worker) }
  }

  async updateWorker(workerId: number, input: WorkerInput): Promise<void> {
    if (!input.name.trim()) throw new Error('施工员姓名不能为空')
    const workers = this.allWorkers(workerId)
    if (workers.length === 0) throw new Error('施工员不存在')
    for (const worker of workers) {
      Object.assign(worker, {
        name: input.name.trim(),
        phone: normalizedOptionalText(input.phone),
        notes: normalizedOptionalText(input.notes),
      })
    }
  }

  async setWorkerStatus(workerId: number, status: WorkerStatus): Promise<void> {
    const workers = this.allWorkers(workerId)
    if (workers.length === 0) throw new Error('施工员不存在')
    for (const worker of workers) worker.status = status
  }

  async assignWorker(
    projectCode: string,
    input: CrewAssignmentInput,
  ): Promise<RepositoryResult<DemoCrewAssignmentViewModel>> {
    const workspace = this.workspace(projectCode)
    if (!workspace.workers.some((worker) => worker.worker_id === input.worker_id && worker.status === 'active')) {
      throw new Error('请选择有效施工员')
    }
    if (!input.role.trim() || !input.scheduled_start_on || !input.scheduled_end_on) {
      throw new Error('请填写岗位和排单日期')
    }
    if (input.scheduled_end_on < input.scheduled_start_on) throw new Error('结束日期不能早于开始日期')
    if (!Number.isSafeInteger(input.rate_cents) || input.rate_cents < 0) throw new Error('计薪金额不正确')
    const assignment: DemoCrewAssignmentViewModel = {
      assignment_id: this.nextAssignmentId++,
      worker_id: input.worker_id,
      role: input.role.trim(),
      scheduled_start_on: input.scheduled_start_on,
      scheduled_end_on: input.scheduled_end_on,
      pay_basis: input.pay_basis,
      rate_cents: input.rate_cents,
      notes: normalizedOptionalText(input.notes),
      status: 'planned',
    }
    workspace.crew_assignments.unshift(assignment)
    return { source: this.source, data: clone(assignment) }
  }

  async updateCrewAssignment(
    projectCode: string,
    assignmentId: number,
    input: CrewAssignmentInput,
  ): Promise<void> {
    const workspace = this.workspace(projectCode)
    const assignment = workspace.crew_assignments.find((item) => item.assignment_id === assignmentId)
    if (!assignment) throw new Error('项目排单不存在')
    if (assignment.status !== 'planned' && assignment.status !== 'active') {
      throw new Error('已结束的项目排单不能编辑')
    }
    if (!workspace.workers.some((worker) => worker.worker_id === input.worker_id && worker.status === 'active')) {
      throw new Error('请选择有效施工员')
    }
    if (!input.role.trim() || !input.scheduled_start_on || !input.scheduled_end_on) {
      throw new Error('请填写岗位和排单日期')
    }
    if (input.scheduled_end_on < input.scheduled_start_on) throw new Error('结束日期不能早于开始日期')
    if (!Number.isSafeInteger(input.rate_cents) || input.rate_cents < 0) throw new Error('计薪金额不正确')
    Object.assign(assignment, clone(input), {
      role: input.role.trim(),
      notes: normalizedOptionalText(input.notes),
    })
  }

  async setCrewAssignmentStatus(
    projectCode: string,
    assignmentId: number,
    status: CrewAssignmentStatus,
  ): Promise<void> {
    const assignment = this.workspace(projectCode).crew_assignments.find((item) => item.assignment_id === assignmentId)
    if (!assignment) throw new Error('项目排单不存在')
    assignment.status = status
  }

  async updateLaborEntry(projectCode: string, entryId: number, input: LaborEntryUpdateInput): Promise<void> {
    const workspace = this.workspace(projectCode)
    const entry = workspace.labor_entries.find((item) => item.entry_id === entryId)
    if (!entry) throw new Error('上工记录不存在')
    if (entry.status === 'voided') throw new Error('已作废上工记录不能编辑')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.work_date)) throw new Error('上工日期格式不正确')
    const assignment = workspace.crew_assignments.find((item) => item.assignment_id === input.assignment_id)
    if (!assignment) throw new Error('项目排单不存在')
    if (entry.replaces_entry_id !== null
      && (entry.assignment_id !== input.assignment_id || entry.work_date !== input.work_date)) {
      throw new Error('补录记录不能修改施工员或上工日期；身份错误请先作废，再重新登记')
    }
    const duplicate = workspace.labor_entries.find((candidate) => candidate.entry_id !== entryId
      && candidate.status === 'active'
      && candidate.work_date === input.work_date
      && workspace.crew_assignments.some((candidateAssignment) => candidateAssignment.assignment_id === candidate.assignment_id
        && candidateAssignment.worker_id === assignment.worker_id))
    if (duplicate) throw new Error('同一施工员当天已有上工记录')
    Object.assign(entry, {
      ...clone(input),
      work_summary: normalizedOptionalText(input.work_summary),
      notes: normalizedOptionalText(input.notes),
      cost_cents: laborCost(assignment, input),
      status: 'active' as const,
      void_reason: null,
    })
  }

  async voidLaborEntry(projectCode: string, entryId: number, reason: string): Promise<void> {
    const entry = this.workspace(projectCode).labor_entries.find((item) => item.entry_id === entryId)
    if (!entry) throw new Error('上工记录不存在')
    if (entry.status === 'voided') throw new Error('上工记录已作废')
    if (!reason.trim()) throw new Error('请填写作废原因')
    entry.status = 'voided'
    entry.void_reason = reason.trim()
  }

  async saveSiteDailyReport(
    projectCode: string,
    input: SiteDailyReportInput,
  ): Promise<RepositoryResult<DemoSiteDailyReportViewModel>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.work_date)) throw new Error('施工日报日期不正确')
    if (!input.work_summary?.trim()) throw new Error('请填写施工内容')
    const workspace = this.workspace(projectCode)
    const existing = workspace.site_daily_reports.find((item) => item.work_date === input.work_date)
    const report: DemoSiteDailyReportViewModel = {
      ...input,
      location: normalizedOptionalText(input.location),
      weather: normalizedOptionalText(input.weather),
      work_summary: input.work_summary.trim(),
      blockers: normalizedOptionalText(input.blockers),
      next_plan: normalizedOptionalText(input.next_plan),
      notes: normalizedOptionalText(input.notes),
      status: 'draft' as const,
      versions: existing?.versions ?? [],
      events: existing?.events ?? [],
    }
    const index = workspace.site_daily_reports.findIndex((item) => item.work_date === input.work_date)
    if (index >= 0 && workspace.site_daily_reports[index]?.status === 'confirmed') {
      throw new Error('已确认日报需要重新打开后才能编辑')
    }
    if (index >= 0) workspace.site_daily_reports[index] = report
    else workspace.site_daily_reports.unshift(report)
    return { source: this.source, data: clone(report) }
  }

  async confirmSiteDailyReport(projectCode: string, workDate: string): Promise<void> {
    const report = this.workspace(projectCode).site_daily_reports.find((item) => item.work_date === workDate)
    if (!report) throw new Error('施工日报不存在')
    if (report.status !== 'draft') throw new Error('施工日报已确认')
    const timestamp = new Date().toISOString()
    const version = {
      id: this.nextReportVersionId++,
      version_number: Math.max(0, ...report.versions.map((item) => item.version_number)) + 1,
      work_date: report.work_date,
      location: report.location,
      weather: report.weather,
      work_summary: report.work_summary,
      blockers: report.blockers,
      next_plan: report.next_plan,
      notes: report.notes,
      confirmed_at: timestamp,
      created_at: timestamp,
    }
    report.versions.unshift(version)
    report.events.push({
      id: this.nextReportEventId++,
      from_status: 'draft',
      to_status: 'confirmed',
      reason: null,
      occurred_at: timestamp,
      created_at: timestamp,
      report_version_id: version.id,
    })
    report.status = 'confirmed'
  }

  async reopenSiteDailyReport(projectCode: string, workDate: string, reason: string): Promise<void> {
    const report = this.workspace(projectCode).site_daily_reports.find((item) => item.work_date === workDate)
    if (!report) throw new Error('施工日报不存在')
    if (report.status !== 'confirmed') throw new Error('只有已确认日报可以重新打开')
    if (!reason.trim()) throw new Error('请填写重新打开原因')
    const version = report.versions[0]
    if (!version) throw new Error('已确认日报缺少确认版本')
    const timestamp = new Date().toISOString()
    report.events.push({
      id: this.nextReportEventId++,
      from_status: 'confirmed',
      to_status: 'draft',
      reason: reason.trim(),
      occurred_at: timestamp,
      created_at: timestamp,
      report_version_id: version.id,
    })
    report.status = 'draft'
  }

  async saveMaterialAdvance(
    projectCode: string,
    input: MaterialAdvanceInput,
  ): Promise<RepositoryResult<DemoMaterialAdvanceViewModel>> {
    const workspace = this.workspace(projectCode)
    const normalized = normalizeAdvanceInput(workspace, input)
    const advance: DemoMaterialAdvanceViewModel = {
      advance_id: this.nextAdvanceId++,
      ...normalized,
      status: 'unreimbursed',
      void_reason: null,
      voided_at: null,
      reimbursements: [],
    }
    workspace.material_advances.unshift(advance)
    return { source: this.source, data: clone(advance) }
  }

  async updateMaterialAdvance(
    projectCode: string,
    advanceId: number,
    input: MaterialAdvanceInput,
  ): Promise<void> {
    const workspace = this.workspace(projectCode)
    const advance = workspace.material_advances.find((item) => item.advance_id === advanceId)
    if (!advance) throw new Error('垫资记录不存在')
    if (advance.status === 'voided') throw new Error('已作废垫资不能编辑')
    if (activeReimbursedCents(advance) !== 0) throw new Error('已有有效报销的垫资不能编辑')
    const normalized = normalizeAdvanceInput(workspace, input)
    Object.assign(advance, normalized, { status: 'unreimbursed' as const })
  }

  async voidMaterialAdvance(projectCode: string, advanceId: number, reason: string): Promise<void> {
    const advance = this.workspace(projectCode).material_advances.find((item) => item.advance_id === advanceId)
    if (!advance) throw new Error('垫资记录不存在')
    if (!reason.trim()) throw new Error('请填写作废原因')
    if (advance.status === 'voided') throw new Error('垫资记录已作废')
    if (activeReimbursedCents(advance) !== 0) throw new Error('已有有效报销的垫资不能作废')
    advance.status = 'voided'
    advance.void_reason = reason.trim()
    advance.voided_at = new Date().toISOString()
  }

  async recordMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    input: MaterialAdvanceReimbursementInput,
  ): Promise<void> {
    const advance = this.workspace(projectCode).material_advances.find((item) => item.advance_id === advanceId)
    if (!advance) throw new Error('垫资记录不存在')
    if (advance.status === 'voided') throw new Error('已作废垫资不能报销')
    if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(input.reimbursed_on)) {
      throw new Error('请填写正确的报销金额和日期')
    }
    const totalAmount = advance.items.reduce((sum, item) => sum + item.line_amount_cents, 0)
    const reimbursed = activeReimbursedCents(advance)
    if (!Number.isSafeInteger(reimbursed + input.amount_cents) || reimbursed + input.amount_cents > totalAmount) {
      throw new Error('报销金额不能超过垫资总额')
    }
    advance.reimbursements.push({
      reimbursement_id: this.nextReimbursementId++,
      ...clone(input),
      notes: normalizedOptionalText(input.notes),
      status: 'active',
      void_reason: null,
      voided_at: null,
    })
    advance.status = reimbursed + input.amount_cents === totalAmount ? 'reimbursed' : 'partial'
  }

  async voidMaterialAdvanceReimbursement(
    projectCode: string,
    advanceId: number,
    reimbursementId: number,
    reason: string,
  ): Promise<void> {
    const advance = this.workspace(projectCode).material_advances.find((item) => item.advance_id === advanceId)
    if (!advance) throw new Error('垫资记录不存在')
    const reimbursement = advance.reimbursements.find((item) => item.reimbursement_id === reimbursementId)
    if (!reimbursement) throw new Error('报销记录不存在')
    if (reimbursement.status === 'voided') throw new Error('报销记录已冲销')
    if (!reason.trim()) throw new Error('请填写冲销原因')
    reimbursement.status = 'voided'
    reimbursement.void_reason = reason.trim()
    reimbursement.voided_at = new Date().toISOString()
    advance.status = materialAdvanceStatus(advance)
  }

  async saveDrawingSignoff(projectCode: string, discipline: DrawingDiscipline, input: DrawingSignoffInput): Promise<void> {
    const signoff = this.deliveryWorkspace(projectCode).drawing_signoffs.find((item) => item.discipline === discipline)
    if (!signoff) throw new Error('会签记录不存在')
    Object.assign(signoff, clone(input))
  }

  async saveCommissioningSession(projectCode: string, input: CommissioningSessionInput): Promise<void> {
    if (!input.started_at) throw new Error('请填写调试开始时间')
    this.deliveryWorkspace(projectCode).commissioning_sessions.unshift({ session_id: this.nextDeliveryId++, ...clone(input) })
  }

  discardSaveCommissioningSession(
    _projectCode: string,
    _input: CommissioningSessionInput,
    _files: readonly File[] = [],
  ): boolean {
    return false
  }

  async updateCommissioningSession(
    projectCode: string,
    sessionId: number,
    input: CommissioningSessionInput,
  ): Promise<void> {
    if (!input.started_at) throw new Error('请填写调试开始时间')
    if (input.ended_at && input.ended_at < input.started_at) throw new Error('调试结束时间不能早于开始时间')
    const session = this.deliveryWorkspace(projectCode).commissioning_sessions.find((item) => item.session_id === sessionId)
    if (!session) throw new Error('调试记录不存在')
    Object.assign(session, clone(input))
  }

  async saveEngineeringChange(projectCode: string, input: EngineeringChangeInput): Promise<void> {
    if (!input.title.trim() || !input.description.trim() || !input.reason.trim() || !input.proposed_on) {
      throw new Error('请完整填写工程变更')
    }
    this.deliveryWorkspace(projectCode).engineering_changes.unshift({ change_id: this.nextDeliveryId++, status: 'proposed', ...clone(input) })
  }

  discardSaveEngineeringChange(
    _projectCode: string,
    _input: EngineeringChangeInput,
    _files: readonly File[] = [],
  ): boolean {
    return false
  }

  async updateEngineeringChange(
    projectCode: string,
    changeId: number,
    input: EngineeringChangeInput,
  ): Promise<void> {
    const change = this.deliveryWorkspace(projectCode).engineering_changes.find((item) => item.change_id === changeId)
    if (!change) throw new Error('工程变更不存在')
    if (change.status !== 'proposed') throw new Error('只有待审批的工程变更可以编辑')
    if (!input.title.trim() || !input.description.trim() || !input.reason.trim() || !input.proposed_on) {
      throw new Error('请完整填写工程变更')
    }
    Object.assign(change, clone(input))
  }

  async setEngineeringChangeStatus(
    projectCode: string,
    changeId: number,
    status: EngineeringChangeStatus,
  ): Promise<void> {
    const change = this.deliveryWorkspace(projectCode).engineering_changes.find((item) => item.change_id === changeId)
    if (!change) throw new Error('工程变更不存在')
    change.status = status
  }

  async saveAcceptance(projectCode: string, input: AcceptanceInput): Promise<void> {
    if (!input.scheduled_on) throw new Error('请填写验收计划日期')
    this.deliveryWorkspace(projectCode).acceptances.unshift({
      acceptance_id: this.nextDeliveryId++, acceptance_type: input.acceptance_type, status: 'scheduled',
      scheduled_on: input.scheduled_on, performed_on: null, notes: normalizedOptionalText(input.notes), document_version_ids: [],
      cancel_reason: null, cancelled_at: null,
    })
  }

  discardSaveAcceptance(_projectCode: string, _input: AcceptanceInput): boolean {
    return false
  }

  async rescheduleAcceptance(
    projectCode: string,
    acceptanceId: number,
    input: AcceptanceInput,
    reason: string,
  ): Promise<void> {
    if (!input.scheduled_on) throw new Error('请填写验收计划日期')
    if (!reason.trim()) throw new Error('请填写改期原因')
    const acceptance = this.deliveryWorkspace(projectCode).acceptances.find((item) => item.acceptance_id === acceptanceId)
    if (!acceptance) throw new Error('验收记录不存在')
    if (acceptance.status !== 'scheduled') throw new Error('只有已安排的验收可以改期')
    Object.assign(acceptance, {
      acceptance_type: input.acceptance_type,
      scheduled_on: input.scheduled_on,
      notes: normalizedOptionalText(input.notes),
    })
  }

  async cancelAcceptance(projectCode: string, acceptanceId: number, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('请填写取消原因')
    const acceptance = this.deliveryWorkspace(projectCode).acceptances.find((item) => item.acceptance_id === acceptanceId)
    if (!acceptance) throw new Error('验收记录不存在')
    if (acceptance.status !== 'scheduled') throw new Error('只有已安排的验收可以取消')
    const cancelledOn = localBusinessDate()
    Object.assign(acceptance, {
      status: 'cancelled',
      performed_on: cancelledOn,
      cancel_reason: reason.trim(),
      cancelled_at: cancelledOn,
    })
  }

  async completeAcceptance(
    projectCode: string,
    acceptanceId: number,
    input: AcceptanceCompletionInput,
  ): Promise<void> {
    if (!input.performed_on || !/^\d{4}-\d{2}-\d{2}$/.test(input.performed_on)) throw new Error('请填写实际验收日期')
    const acceptance = this.deliveryWorkspace(projectCode).acceptances.find((item) => item.acceptance_id === acceptanceId)
    if (!acceptance) throw new Error('验收记录不存在')
    Object.assign(acceptance, {
      status: input.status,
      performed_on: input.performed_on,
      notes: normalizedOptionalText(input.notes),
    })
  }

  async updateWarranty(projectCode: string, input: WarrantyInput): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.starts_on) || !Number.isInteger(input.duration_months)
      || input.duration_months < 1 || input.duration_months > 120) {
      throw new Error('请填写正确的质保日期和月数')
    }
    if (!Number.isSafeInteger(input.renewal_price_cents) || input.renewal_price_cents < 0) {
      throw new Error('质保续费价格不正确')
    }
    this.deliveryWorkspace(projectCode).warranty = deriveWarranty(input)
  }

  async saveInvoice(projectCode: string, input: InvoiceInput): Promise<void> {
    validateInvoiceInput(input)
    this.deliveryWorkspace(projectCode).invoices.unshift({ invoice_id: this.nextDeliveryId++, ...clone(input), void_reason: null })
  }

  async updateInvoice(projectCode: string, invoiceId: number, input: InvoiceInput): Promise<void> {
    validateInvoiceInput(input)
    const invoice = this.deliveryWorkspace(projectCode).invoices.find((item) => item.invoice_id === invoiceId)
    if (!invoice) throw new Error('发票记录不存在')
    if (invoice.status === 'void') throw new Error('已作废发票不能编辑')
    if (invoice.status === 'recorded' && (
      input.status !== invoice.status
      || input.recorded_on !== invoice.recorded_on
      || input.invoice_number !== invoice.invoice_number
      || input.amount_cents !== invoice.amount_cents
    )) {
      throw new Error('已登记发票的正式信息需先作废再变更')
    }
    Object.assign(invoice, clone(input))
  }

  discardSaveInvoice(_projectCode: string, _input: InvoiceInput, _files: readonly File[] = []): boolean {
    return false
  }

  async voidInvoice(projectCode: string, invoiceId: number, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('请填写发票作废原因')
    const invoice = this.deliveryWorkspace(projectCode).invoices.find((item) => item.invoice_id === invoiceId)
    if (!invoice) throw new Error('发票记录不存在')
    invoice.status = 'void'
    invoice.void_reason = reason.trim()
  }

  async saveAfterSalesCase(projectCode: string, input: AfterSalesInput): Promise<void> {
    if (!input.reported_on || !input.reason.trim() || !input.contact_name.trim() || !input.contact_phone.trim()) {
      throw new Error('请完整填写售后报修信息')
    }
    const delivery = this.deliveryWorkspace(projectCode)
    const isUnderWarranty = Boolean(
      delivery.warranty
      && input.reported_on >= delivery.warranty.starts_on
      && input.reported_on <= delivery.warranty.ends_on,
    )
    delivery.after_sales.unshift({
      case_id: this.nextDeliveryId++, ...clone(input), is_under_warranty: isUnderWarranty,
      status: 'open', resolution: null, completed_at: null,
    })
  }

  discardSaveAfterSalesCase(_projectCode: string, _input: AfterSalesInput): boolean {
    return false
  }

  async updateAfterSalesCase(projectCode: string, caseId: number, input: AfterSalesInput): Promise<void> {
    if (!input.reported_on || !input.reason.trim() || !input.contact_name.trim() || !input.contact_phone.trim()) {
      throw new Error('请完整填写售后报修信息')
    }
    const delivery = this.deliveryWorkspace(projectCode)
    const item = delivery.after_sales.find((candidate) => candidate.case_id === caseId)
    if (!item) throw new Error('售后案件不存在')
    if (item.status === 'completed' || item.status === 'cancelled') throw new Error('已结案售后不能编辑')
    const isUnderWarranty = Boolean(
      delivery.warranty
      && input.reported_on >= delivery.warranty.starts_on
      && input.reported_on <= delivery.warranty.ends_on,
    )
    Object.assign(item, clone(input), { is_under_warranty: isUnderWarranty })
  }

  async setAfterSalesStatus(
    projectCode: string,
    caseId: number,
    status: AfterSalesStatus,
    resolution: string | null,
  ): Promise<void> {
    const item = this.deliveryWorkspace(projectCode).after_sales.find((candidate) => candidate.case_id === caseId)
    if (!item) throw new Error('售后案件不存在')
    const transitions: Record<AfterSalesStatus, AfterSalesStatus[]> = {
      open: ['in_progress', 'completed', 'cancelled'],
      in_progress: ['completed', 'cancelled'],
      completed: [],
      cancelled: [],
    }
    if (!transitions[item.status].includes(status)) throw new Error('售后状态不能这样变更')
    if (status === 'completed' && !resolution?.trim()) throw new Error('完成售后时请填写处理结果')
    if (status === 'cancelled' && !resolution?.trim()) throw new Error('取消售后时请填写原因')
    item.status = status
    item.resolution = normalizedOptionalText(resolution)
    item.completed_at = status === 'completed' ? new Date().toISOString() : null
  }

  private allWorkers(workerId: number): DemoWorkerViewModel[] {
    const matches = new Set<DemoWorkerViewModel>()
    for (const worker of this.createdWorkers) if (worker.worker_id === workerId) matches.add(worker)
    for (const workspace of this.workforce.values()) {
      for (const worker of workspace.workers) if (worker.worker_id === workerId) matches.add(worker)
    }
    return [...matches]
  }

  private workspace(projectCode: string): WorkforceDemoViewModel {
    let workspace = this.workforce.get(projectCode)
    if (!workspace) {
      workspace = createWorkforcePreview(projectCode)
      workspace.workers.push(...this.createdWorkers.map((worker) => clone(worker)))
      this.workforce.set(projectCode, workspace)
    }
    return workspace
  }

  private deliveryWorkspace(projectCode: string): DeliveryDemoViewModel {
    let workspace = this.deliveries.get(projectCode)
    if (!workspace) {
      workspace = createDeliveryPreview(projectCode)
      this.deliveries.set(projectCode, workspace)
    }
    return workspace
  }
}

function decimalToMilli(value: string): bigint {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(normalized)) throw new Error('数量最多保留三位小数')
  const [whole, fraction = ''] = normalized.split('.')
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))
}

function normalizeAdvanceInput(
  workspace: WorkforceDemoViewModel,
  input: MaterialAdvanceInput,
): Omit<
  DemoMaterialAdvanceViewModel,
  'advance_id' | 'status' | 'void_reason' | 'voided_at' | 'reimbursements'
> {
  if (!workspace.workers.some((worker) => worker.worker_id === input.worker_id)) throw new Error('施工员不存在')
  if (!input.spent_on || !input.vendor_name.trim() || input.items.length === 0) throw new Error('请完整填写垫资信息')
  const items = input.items.map((item) => {
    const quantityMilli = decimalToMilli(item.quantity)
    if (!item.name.trim() || !item.unit.trim() || quantityMilli <= 0n
      || !Number.isSafeInteger(item.unit_price_cents) || item.unit_price_cents < 0) {
      throw new Error('垫资物料名称、单位、数量或单价不正确')
    }
    const lineAmount = Number((quantityMilli * BigInt(item.unit_price_cents) + 500n) / 1000n)
    if (!Number.isSafeInteger(lineAmount)) throw new Error('垫资金额超出可保存范围')
    return {
      ...clone(item),
      name: item.name.trim(),
      specification: normalizedOptionalText(item.specification),
      brand: normalizedOptionalText(item.brand),
      unit: item.unit.trim(),
      line_amount_cents: lineAmount,
    }
  })
  return {
    worker_id: input.worker_id,
    spent_on: input.spent_on,
    vendor_name: input.vendor_name.trim(),
    items,
    notes: normalizedOptionalText(input.notes),
    document_version_ids: [...input.document_version_ids],
  }
}

function activeReimbursedCents(advance: DemoMaterialAdvanceViewModel): number {
  return advance.reimbursements
    .filter((item) => item.status === 'active')
    .reduce((sum, item) => sum + item.amount_cents, 0)
}

function materialAdvanceStatus(advance: DemoMaterialAdvanceViewModel): DemoMaterialAdvanceViewModel['status'] {
  if (advance.status === 'voided') return 'voided'
  const reimbursed = activeReimbursedCents(advance)
  const total = advance.items.reduce((sum, item) => sum + item.line_amount_cents, 0)
  if (reimbursed === 0) return 'unreimbursed'
  return reimbursed === total ? 'reimbursed' : 'partial'
}

function laborCost(
  assignment: DemoCrewAssignmentViewModel,
  entry: LaborEntryBatchItemInput,
): number {
  if (entry.attendance_status !== 'present') {
    if (entry.day_fraction !== null || entry.work_minutes !== null) {
      throw new Error('缺勤或请假不能填写计薪量')
    }
    return 0
  }

  if (assignment.pay_basis === 'daily') {
    if (entry.day_fraction !== '1.000' && entry.day_fraction !== '0.500') {
      throw new Error('日薪上工只能选择全天或半天')
    }
    if (entry.work_minutes !== null) throw new Error('日薪上工不能填写分钟')
    return entry.day_fraction === '1.000' ? assignment.rate_cents : Math.round(assignment.rate_cents / 2)
  }

  if (entry.day_fraction !== null) throw new Error('时薪上工不能填写工作日')
  if (!Number.isInteger(entry.work_minutes) || entry.work_minutes === null
    || entry.work_minutes < 1 || entry.work_minutes > 1440) {
    throw new Error('时薪上工分钟必须在 1 到 1440 之间')
  }
  return Math.round(assignment.rate_cents * entry.work_minutes / 60)
}

function validateInvoiceInput(input: InvoiceInput): void {
  if (input.status === 'void') throw new Error('新建或补录发票不能直接设为已作废')
  if (input.amount_cents !== null
    && (!Number.isSafeInteger(input.amount_cents) || input.amount_cents < 0)) {
    throw new Error('发票金额不正确')
  }
  if ((input.status === 'requested' || input.status === 'recorded') && !input.requested_on) {
    throw new Error('请填写发票申请日期')
  }
  if (input.status === 'recorded'
    && (!input.recorded_on || !input.invoice_number?.trim() || input.amount_cents === null)) {
    throw new Error('已登记发票必须填写登记日期、发票号码和金额')
  }
  if (input.requested_on && input.recorded_on && input.recorded_on < input.requested_on) {
    throw new Error('登记日期不能早于申请日期')
  }
}

function deriveWarranty(input: WarrantyInput): DeliveryDemoViewModel['warranty'] {
  const startsAt = new Date(`${input.starts_on}T00:00:00Z`)
  const endsAt = new Date(startsAt)
  endsAt.setUTCMonth(endsAt.getUTCMonth() + input.duration_months)
  const now = new Date()
  const todayAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysRemaining = Math.ceil((endsAt.getTime() - todayAt) / 86_400_000)
  const status = todayAt < startsAt.getTime()
    ? 'not_started'
    : daysRemaining < 0
      ? 'expired'
      : daysRemaining <= 30
        ? 'expiring'
        : 'active'
  return {
    ...clone(input),
    notes: normalizedOptionalText(input.notes),
    ends_on: endsAt.toISOString().slice(0, 10),
    days_remaining: Math.max(0, daysRemaining),
    status,
  }
}

function normalizedOptionalText(value: string | null): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createWorkforcePreview(projectCode: string): WorkforceDemoViewModel {
  return {
    project_code: projectCode,
    workers: [
      { worker_id: 101, name: '王建国', phone: '13800138001', notes: '机械安装', status: 'active' },
      { worker_id: 102, name: '陈志强', phone: '13800138002', notes: '电气调试', status: 'active' },
    ],
    crew_assignments: [
      {
        assignment_id: 201,
        worker_id: 101,
        role: '机械安装',
        scheduled_start_on: '2026-08-01',
        scheduled_end_on: '2026-09-30',
        pay_basis: 'daily',
        rate_cents: 68000,
        notes: null,
        status: 'active',
      },
      {
        assignment_id: 202,
        worker_id: 102,
        role: '电气调试',
        scheduled_start_on: '2026-08-01',
        scheduled_end_on: '2026-09-30',
        pay_basis: 'hourly',
        rate_cents: 9500,
        notes: '按现场实际分钟结算',
        status: 'planned',
      },
      {
        assignment_id: 203,
        worker_id: 101,
        role: '机械安装（历史排单）',
        scheduled_start_on: '2026-08-01',
        scheduled_end_on: '2026-08-10',
        pay_basis: 'daily',
        rate_cents: 65000,
        notes: null,
        status: 'completed',
      },
    ],
    labor_entries: [
      {
        entry_id: 301,
        assignment_id: 201,
        replaces_entry_id: null,
        work_date: '2026-09-03',
        attendance_status: 'present',
        day_fraction: '0.500',
        work_minutes: null,
        work_summary: '设备底座找平',
        notes: null,
        cost_cents: 34000,
        status: 'active',
        void_reason: null,
      },
      {
        entry_id: 302,
        assignment_id: 202,
        replaces_entry_id: null,
        work_date: '2026-09-09',
        attendance_status: 'present',
        day_fraction: null,
        work_minutes: 480,
        work_summary: '控制柜接线检查',
        notes: null,
        cost_cents: 76000,
        status: 'active',
        void_reason: null,
      },
    ],
    site_daily_reports: [{
      work_date: '2026-09-09',
      location: '客户一号车间',
      weather: '晴',
      work_summary: '完成底座复测与控制柜通电前检查',
      blockers: '等待客户停线窗口',
      next_plan: '进入设备吊装与回路测试',
      notes: null,
      status: 'draft',
      versions: [],
      events: [],
    }],
    material_advances: [{
      advance_id: 401,
      worker_id: 101,
      spent_on: '2026-09-05',
      vendor_name: '园区五金机电商行',
      items: [
        {
          name: '不锈钢膨胀螺栓',
          specification: 'M12×100',
          brand: null,
          quantity: '20.000',
          unit: '套',
          unit_price_cents: 6400,
          line_amount_cents: 128000,
        },
        {
          name: '绝缘胶带',
          specification: null,
          brand: '3M',
          quantity: '10.000',
          unit: '卷',
          unit_price_cents: 4600,
          line_amount_cents: 46000,
        },
      ],
      notes: '现场缺料临时补买',
      document_version_ids: [],
      status: 'partial',
      void_reason: null,
      voided_at: null,
      reimbursements: [{
        reimbursement_id: 1,
        amount_cents: 100000,
        reimbursed_on: '2026-09-08',
        payment_method: 'bank_transfer',
        notes: '首笔报销',
        status: 'active',
        void_reason: null,
        voided_at: null,
      }],
    }],
  }
}

function createDeliveryPreview(projectCode: string): DeliveryDemoViewModel {
  return {
    project_code: projectCode,
    drawing_signoffs: [
      {
        discipline: 'mechanical',
        status: 'not_required',
        confirmed_on: '2026-09-12',
        not_required_reason: '本次改造沿用原机械图纸',
        notes: '无需图纸',
        document_version_ids: [],
      },
      {
        discipline: 'electrical',
        status: 'confirmed',
        confirmed_on: '2026-09-13',
        not_required_reason: null,
        notes: '电气原理图已确认',
        document_version_ids: [501],
      },
    ],
    commissioning_sessions: [{
      session_id: 601,
      started_at: '2026-09-20T01:00:00+00:00',
      ended_at: null,
      status: 'blocked',
      summary: '完成空载测试',
      issues: '安全门信号偶发抖动',
      next_action: '更换接近开关后复测',
      notes: null,
      document_version_ids: [],
    }],
    engineering_changes: [{
      change_id: 701,
      source: 'site_condition',
      title: '安全门传感器位置调整',
      description: '调整支架并增加屏蔽线槽',
      reason: '现场电磁干扰高于勘测值',
      contract_delta_cents: 180000,
      estimated_cost_delta_cents: 72000,
      schedule_delta_days: 2,
      proposed_on: '2026-09-21',
      notes: null,
      document_version_ids: [],
      status: 'approved',
    }],
    acceptances: [{
      acceptance_id: 801,
      acceptance_type: 'final',
      status: 'passed_with_punch',
      scheduled_on: '2026-10-08',
      performed_on: '2026-10-08',
      notes: '遗留铭牌补装项',
      document_version_ids: [502],
      cancel_reason: null,
      cancelled_at: null,
    }],
    warranty: {
      starts_on: '2026-10-08',
      duration_months: 12,
      renewal_price_cents: 3600000,
      notes: '按最终验收日期起算',
      ends_on: '2027-10-08',
      days_remaining: 220,
      status: 'active',
    },
    invoices: [{
      invoice_id: 901,
      invoice_type: 'contract_payment',
      status: 'recorded',
      requested_on: '2026-09-15',
      recorded_on: '2026-09-18',
      invoice_number: 'INV-2026-0918',
      amount_cents: 80400000,
      counterparty_name: '演示客户单位',
      notes: '进度款发票',
      document_version_ids: [],
      void_reason: null,
    }],
    after_sales: [{
      case_id: 1001,
      reported_on: '2026-11-03',
      service_on: '2026-11-04',
      reason: '安全门信号再次波动',
      contact_name: '张经理',
      contact_phone: '13900139000',
      coverage_type: 'warranty',
      is_under_warranty: true,
      notes: '客户提供了现场视频',
      status: 'in_progress',
      resolution: '已预约到场复检',
      completed_at: null,
    }],
  }
}

function localBusinessDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
