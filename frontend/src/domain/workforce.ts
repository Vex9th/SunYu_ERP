import type { DecimalString, ISODate, ISODateTime, MoneyCents } from './contracts'

export type WorkerPayBasis = 'daily' | 'hourly'
export type WorkerStatus = 'active' | 'inactive'
export type CrewAssignmentStatus = 'planned' | 'active' | 'completed' | 'cancelled'
export type AttendanceStatus = 'present' | 'absent' | 'leave'
export type LaborEntryStatus = 'active' | 'voided'
export type SiteDailyReportStatus = 'draft' | 'confirmed'
export type MaterialAdvanceStatus = 'unreimbursed' | 'partial' | 'reimbursed' | 'voided'

export interface DemoWorkerViewModel {
  worker_id: number
  name: string
  phone: string | null
  notes: string | null
  status: WorkerStatus
}

export interface DemoCrewAssignmentViewModel {
  assignment_id: number
  worker_id: number
  role: string
  scheduled_start_on: ISODate
  scheduled_end_on: ISODate
  pay_basis: WorkerPayBasis
  rate_cents: MoneyCents
  notes: string | null
  status: CrewAssignmentStatus
}

export interface DemoLaborEntryViewModel {
  entry_id: number
  assignment_id: number
  work_date: ISODate
  attendance_status: AttendanceStatus
  day_fraction: DecimalString | null
  work_minutes: number | null
  work_summary: string | null
  notes: string | null
  cost_cents: MoneyCents
  status: LaborEntryStatus
  void_reason: string | null
}

export interface LaborEntryBatchItemInput {
  assignment_id: number
  attendance_status: AttendanceStatus
  day_fraction: DecimalString | null
  work_minutes: number | null
  work_summary: string | null
  notes: string | null
}

export interface LaborEntryBatchInput {
  work_date: ISODate
  entries: LaborEntryBatchItemInput[]
}

export interface DemoSiteDailyReportViewModel {
  work_date: ISODate
  location: string | null
  weather: string | null
  work_summary: string | null
  blockers: string | null
  next_plan: string | null
  notes: string | null
  status: SiteDailyReportStatus
}

export interface DemoMaterialAdvanceItemViewModel {
  name: string
  specification: string | null
  brand: string | null
  quantity: DecimalString
  unit: string
  unit_price_cents: MoneyCents
  line_amount_cents: MoneyCents
}

export interface DemoReimbursementViewModel {
  amount_cents: MoneyCents
  reimbursed_on: ISODate
  payment_method: 'bank_transfer' | 'cash' | 'other'
  notes: string | null
}

export interface DemoMaterialAdvanceViewModel {
  advance_id: number
  worker_id: number
  spent_on: ISODate
  vendor_name: string
  items: DemoMaterialAdvanceItemViewModel[]
  notes: string | null
  document_version_ids: number[]
  status: MaterialAdvanceStatus
  reimbursements: DemoReimbursementViewModel[]
}

export interface WorkforceDemoViewModel {
  project_code: string
  workers: DemoWorkerViewModel[]
  crew_assignments: DemoCrewAssignmentViewModel[]
  labor_entries: DemoLaborEntryViewModel[]
  site_daily_reports: DemoSiteDailyReportViewModel[]
  material_advances: DemoMaterialAdvanceViewModel[]
}

export interface WorkerInput {
  name: string
  phone: string | null
  notes: string | null
}

export interface CrewAssignmentInput {
  worker_id: number
  role: string
  scheduled_start_on: ISODate
  scheduled_end_on: ISODate
  pay_basis: WorkerPayBasis
  rate_cents: MoneyCents
  notes: string | null
}

export type LaborEntryUpdateInput = LaborEntryBatchItemInput & { work_date: ISODate }
export type SiteDailyReportInput = Omit<DemoSiteDailyReportViewModel, 'status'>

export interface MaterialAdvanceItemInput {
  name: string
  specification: string | null
  brand: string | null
  quantity: DecimalString
  unit: string
  unit_price_cents: MoneyCents
}

export interface MaterialAdvanceInput {
  worker_id: number
  spent_on: ISODate
  vendor_name: string
  items: MaterialAdvanceItemInput[]
  notes: string | null
  document_version_ids: number[]
}

export type DrawingDiscipline = 'mechanical' | 'electrical'
export type DrawingSignoffStatus = 'pending' | 'confirmed' | 'not_required'
export type CommissioningStatus = 'planned' | 'in_progress' | 'blocked' | 'completed' | 'cancelled'
export type EngineeringChangeStatus = 'proposed' | 'approved' | 'rejected' | 'implemented' | 'cancelled'
export type EngineeringChangeSource =
  | 'commissioning'
  | 'customer_request'
  | 'site_condition'
  | 'technical_agreement'
  | 'other'
export type AcceptanceType = 'pre_acceptance' | 'final' | 'reinspection'
export type AcceptanceStatus = 'scheduled' | 'passed' | 'passed_with_punch' | 'failed' | 'cancelled'
export type WarrantyStatus = 'not_started' | 'active' | 'expiring' | 'expired'
export type InvoiceType = 'contract_payment' | 'additional_work' | 'warranty_service' | 'other'
export type InvoiceStatus = 'planned' | 'requested' | 'recorded' | 'void'
export type AfterSalesCoverageType = 'warranty' | 'paid' | 'goodwill'
export type AfterSalesStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'

export interface DemoDrawingSignoffViewModel {
  discipline: DrawingDiscipline
  status: DrawingSignoffStatus
  confirmed_on: ISODate | null
  not_required_reason: string | null
  notes: string | null
  document_version_ids: number[]
}

export interface DemoCommissioningSessionViewModel {
  session_id: number
  started_at: ISODateTime
  ended_at: ISODateTime | null
  status: CommissioningStatus
  summary: string | null
  issues: string | null
  next_action: string | null
  notes: string | null
  document_version_ids: number[]
}

export interface DemoEngineeringChangeViewModel {
  change_id: number
  source: EngineeringChangeSource
  title: string
  description: string
  reason: string
  contract_delta_cents: MoneyCents
  estimated_cost_delta_cents: MoneyCents
  schedule_delta_days: number
  proposed_on: ISODate
  notes: string | null
  document_version_ids: number[]
  status: EngineeringChangeStatus
}

export interface DemoAcceptanceViewModel {
  acceptance_id: number
  acceptance_type: AcceptanceType
  status: AcceptanceStatus
  scheduled_on: ISODate
  performed_on: ISODate | null
  notes: string | null
  document_version_ids: number[]
}

export interface DemoWarrantyViewModel {
  starts_on: ISODate
  duration_months: number
  renewal_price_cents: MoneyCents | null
  notes: string | null
  ends_on: ISODate
  days_remaining: number
  status: WarrantyStatus
}

export interface DemoInvoiceViewModel {
  invoice_id: number
  invoice_type: InvoiceType
  status: InvoiceStatus
  requested_on: ISODate | null
  recorded_on: ISODate | null
  invoice_number: string | null
  amount_cents: MoneyCents
  counterparty_name: string
  notes: string | null
  document_version_ids: number[]
  void_reason: string | null
}

export interface DemoAfterSalesCaseViewModel {
  case_id: number
  reported_on: ISODate
  service_on: ISODate | null
  reason: string
  contact_name: string
  contact_phone: string
  coverage_type: AfterSalesCoverageType
  notes: string | null
  status: AfterSalesStatus
  resolution: string | null
}

export interface DeliveryDemoViewModel {
  project_code: string
  drawing_signoffs: DemoDrawingSignoffViewModel[]
  commissioning_sessions: DemoCommissioningSessionViewModel[]
  engineering_changes: DemoEngineeringChangeViewModel[]
  acceptances: DemoAcceptanceViewModel[]
  warranty: DemoWarrantyViewModel | null
  invoices: DemoInvoiceViewModel[]
  after_sales: DemoAfterSalesCaseViewModel[]
}

export type DrawingSignoffInput = Omit<DemoDrawingSignoffViewModel, 'discipline'>
export type CommissioningSessionInput = Omit<DemoCommissioningSessionViewModel, 'session_id'>
export type EngineeringChangeInput = Omit<DemoEngineeringChangeViewModel, 'change_id' | 'status'>
export type AcceptanceInput = Pick<DemoAcceptanceViewModel, 'acceptance_type' | 'scheduled_on' | 'notes'>
export type AcceptanceCompletionInput = Pick<DemoAcceptanceViewModel, 'performed_on' | 'notes'> & {
  status: Extract<AcceptanceStatus, 'passed' | 'passed_with_punch' | 'failed'>
  document_version_ids?: number[]
  warranty?: WarrantyInput | null
}
export type WarrantyInput = Pick<DemoWarrantyViewModel, 'starts_on' | 'duration_months' | 'notes'> & {
  renewal_price_cents: MoneyCents
}
export type InvoiceInput = Omit<DemoInvoiceViewModel, 'invoice_id' | 'void_reason'>
export type AfterSalesInput = Omit<DemoAfterSalesCaseViewModel, 'case_id' | 'status' | 'resolution'>

export function optionalYuanToCents(value: string): MoneyCents | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('金额必须是最多两位小数的非负元金额')
  }
  return parsedYuanToCents(normalized)
}

export function signedYuanToCents(value: string): MoneyCents {
  const normalized = value.trim()
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('变更金额必须是最多两位小数的元金额')
  }
  const negative = normalized.startsWith('-')
  const result = parsedYuanToCents(negative ? normalized.slice(1) : normalized)
  return negative ? -result : result
}

function parsedYuanToCents(value: string): MoneyCents {
  const [yuan, fraction = ''] = value.split('.')
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(result)) throw new Error('金额超出可保存范围')
  return result
}
