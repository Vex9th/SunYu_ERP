import type {
  DecimalString,
  ISODate,
  ISODateTime,
  MoneyCents,
  Revision,
} from './contracts'
import type {
  ProcurementInvoiceStatus,
  ProcurementListStatus,
  ProcurementOrderStatus,
  ProcurementPaymentStatus,
  ProcurementReceiptStatus,
  ProcurementUsageStatus,
  PurchaseOrderStatus,
} from './procurement'
import type {
  AttendanceStatus,
  CrewAssignmentStatus,
  LaborEntryStatus,
  WorkerPayBasis,
  WorkerStatus,
} from './workforce'

export interface PaginationQuery {
  [key: string]: string | number | boolean | null | undefined
  page?: number
  page_size?: number
}

export interface ProcurementListInput {
  name: string
  notes: string | null
}

export interface ProcurementListUpdateInput extends ProcurementListInput {
  expected_revision: Revision
}

export interface ProcurementListSummaryDto {
  id: number
  project_code: string
  name: string
  notes: string | null
  status: ProcurementListStatus
  revision: Revision
  line_count: number
  confirmed_at: ISODateTime | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface ProcurementLineInput {
  sequence_no: number
  category: string
  name: string
  specification: string | null
  brand: string | null
  model: string | null
  quantity: DecimalString
  unit: string
  unit_cost_cents: MoneyCents
  quoted_unit_price_cents: MoneyCents
}

export interface ProcurementLineUpdateInput extends ProcurementLineInput {
  expected_revision: Revision
}

export interface ProcurementLineDto extends ProcurementLineInput {
  id: number
  procurement_list_id: number
  inventory_item_id: number | null
  cost_total_cents: MoneyCents
  quoted_total_cents: MoneyCents
  ordered_quantity: DecimalString
  ordered_amount_cents: MoneyCents
  paid_amount_cents: MoneyCents
  received_quantity: DecimalString
  invoiced_amount_cents: MoneyCents
  issued_quantity: DecimalString
  order_status: ProcurementOrderStatus
  payment_status: ProcurementPaymentStatus
  receipt_status: ProcurementReceiptStatus
  invoice_status: ProcurementInvoiceStatus
  usage_status: ProcurementUsageStatus
  revision: Revision
  list_revision?: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface ProcurementListDetailDto extends ProcurementListSummaryDto {
  cost_total_cents: MoneyCents
  quoted_total_cents: MoneyCents
  lines: ProcurementLineDto[]
}

export interface ConfirmRevisionInput {
  expected_revision: Revision
}

export interface PurchaseOrderLineInput {
  procurement_line_id: number
  quantity: DecimalString
  unit_cost_cents: MoneyCents
  overage_reason: string | null
}

export interface PurchaseOrderInput {
  order_no: string
  supplier_company_id: number
  ordered_on: ISODate
  expected_delivery_on: ISODate | null
  lines: PurchaseOrderLineInput[]
  notes: string | null
  document_version_ids: number[]
}

export interface PurchaseOrderLineDto extends PurchaseOrderLineInput {
  id: number
  purchase_order_id: number
  received_quantity: DecimalString
  line_amount_cents: MoneyCents
}

export interface PurchaseOrderDto extends Omit<PurchaseOrderInput, 'lines'> {
  id: number
  project_code: string
  supplier_company_name: string | null
  status: PurchaseOrderStatus
  ordered_amount_cents: MoneyCents
  revision: Revision
  lines: PurchaseOrderLineDto[]
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface GoodsReceiptInput {
  received_on: ISODate
  warehouse_name: string
  lines: Array<{
    purchase_order_line_id: number
    quantity: DecimalString
  }>
  notes: string | null
}

export interface GoodsReceiptDto {
  id: number
  purchase_order_id: number
  received_on: ISODate
  warehouse_name: string
  notes: string | null
  status: 'active'
  revision: Revision
  lines: Array<{
    id: number
    purchase_order_line_id: number
    inventory_item_id: number
    quantity: DecimalString
    value_cents: MoneyCents
    movement_id: number
  }>
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface ProcurementOverviewDto {
  project_code: string
  line_count: number
  line_status_counts: Record<ProcurementOrderStatus, number>
  procurement_committed_cents: MoneyCents
  procurement_received_cents: MoneyCents
  procurement_paid_cents: MoneyCents
  material_consumed_cents: MoneyCents
}

export interface InventoryItemInput {
  brand: string | null
  name: string
  model: string | null
  specification: string | null
  unit: string
  opening_quantity: DecimalString
  opening_unit_cost_cents: MoneyCents | null
  notes: string | null
}

export interface InventoryItemUpdateInput {
  brand: string | null
  name: string
  model: string | null
  specification: string | null
  unit: string
  notes: string | null
  expected_revision: Revision
}

export interface InventoryItemDto {
  id: number
  brand: string | null
  name: string
  model: string | null
  specification: string | null
  unit: string
  quantity: DecimalString
  average_unit_cost_cents: MoneyCents
  inventory_value_cents: MoneyCents
  notes: string | null
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type InventoryMovementType = 'opening' | 'goods_receipt' | 'adjustment' | 'project_issue'

export interface InventoryMovementDto {
  id: number
  inventory_item_id: number
  project_id: number | null
  procurement_line_id: number | null
  movement_type: InventoryMovementType
  quantity_delta: DecimalString
  value_delta_cents: MoneyCents
  quantity_after: DecimalString
  value_after_cents: MoneyCents
  source_type: string
  source_id: number
  occurred_on: ISODate
  reason: string | null
  created_at: ISODateTime
}

export interface InventoryItemDetailDto extends InventoryItemDto {
  movements: InventoryMovementDto[]
}

export interface InventoryAdjustmentInput {
  item_id: number
  quantity_delta: DecimalString
  unit_cost_cents: MoneyCents | null
  reason: string
  occurred_on: ISODate
}

export interface InventoryAdjustmentDto extends Omit<InventoryAdjustmentInput, 'item_id'> {
  id: number
  inventory_item_id: number
  value_delta_cents: MoneyCents
  movement: InventoryMovementDto
  created_at: ISODateTime
}

export interface InventoryIssueInput {
  issued_on: ISODate
  worker_id: number | null
  lines: Array<{
    inventory_item_id: number
    procurement_line_id: number | null
    quantity: DecimalString
  }>
  notes: string | null
}

export interface InventoryIssueDto {
  id: number
  project_id: number
  issued_on: ISODate
  worker_id: number | null
  notes: string | null
  status: 'active'
  total_cost_cents: MoneyCents
  revision: Revision
  lines: Array<{
    id: number
    inventory_item_id: number
    procurement_line_id: number | null
    quantity: DecimalString
    cost_cents: MoneyCents
    movement_id: number
  }>
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface WorkerInput {
  name: string
  phone: string | null
  notes: string | null
}

export interface WorkerUpdateInput extends WorkerInput {
  expected_revision: Revision
}

export interface WorkerDto extends WorkerInput {
  id: number
  status: WorkerStatus
  inactive_on: ISODate | null
  inactive_reason: string | null
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface WorkerDeactivateInput {
  effective_on: ISODate
  reason: string
  expected_revision: Revision
}

export interface CrewAssignmentInput {
  worker_id: number
  role: string
  scheduled_start_on: ISODate
  scheduled_end_on: ISODate | null
  pay_basis: WorkerPayBasis
  rate_cents: MoneyCents
  notes: string | null
}

export interface CrewAssignmentUpdateInput extends CrewAssignmentInput {
  expected_revision: Revision
}

export interface CrewAssignmentDto extends CrewAssignmentInput {
  id: number
  project_code: string
  worker_name: string
  worker_phone: string | null
  status: CrewAssignmentStatus
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface LaborEntryDto {
  id: number
  project_code: string
  assignment_id: number
  worker_id: number
  worker_name: string
  work_date: ISODate
  attendance_status: AttendanceStatus
  day_fraction: DecimalString | null
  work_minutes: number | null
  pay_basis: WorkerPayBasis
  rate_cents: MoneyCents
  cost_cents: MoneyCents
  work_summary: string | null
  notes: string | null
  status: LaborEntryStatus
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface LaborBatchInput {
  work_date: ISODate
  entries: Array<{
    assignment_id: number
    attendance_status: AttendanceStatus
    day_fraction: DecimalString | null
    work_minutes: number | null
    work_summary: string | null
    notes: string | null
    expected_revision: Revision | null
  }>
}

export interface LaborBatchDto {
  work_date: ISODate
  items: LaborEntryDto[]
}
