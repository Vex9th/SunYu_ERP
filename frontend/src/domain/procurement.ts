import type { DecimalString, ISODate, MoneyCents, Revision } from './contracts'

export type ProcurementListStatus = 'draft' | 'confirmed' | 'superseded'
export type PurchaseOrderStatus =
  | 'draft'
  | 'confirmed'
  | 'partially_received'
  | 'received'
  | 'cancelled'

export type ProcurementOrderStatus = 'not_ordered' | 'partial' | 'ordered' | 'over_ordered'
export type ProcurementPaymentStatus = 'unpaid' | 'partial' | 'paid'
export type ProcurementReceiptStatus = 'not_received' | 'partial' | 'received'
export type ProcurementInvoiceStatus = 'not_invoiced' | 'partial' | 'invoiced'
export type ProcurementUsageStatus = 'unused' | 'partial' | 'used'

export interface ProcurementLineInput {
  sequence_no: number
  category: string
  name: string
  specification: string
  brand: string
  model: string
  quantity: DecimalString
  unit: string
  unit_cost_cents: MoneyCents
  quoted_unit_price_cents: MoneyCents
}

export interface ProcurementLine extends ProcurementLineInput {
  id: number
  revision: Revision
  order_status: ProcurementOrderStatus
  payment_status: ProcurementPaymentStatus
  receipt_status: ProcurementReceiptStatus
  invoice_status: ProcurementInvoiceStatus
  usage_status: ProcurementUsageStatus
}

export interface ProcurementListInput {
  name: string
  notes: string | null
}

export interface ProcurementList {
  id: number
  name: string
  notes: string | null
  status: ProcurementListStatus
  revision: Revision
  lines: ProcurementLine[]
}

export interface PurchaseOrderLineInput {
  procurement_line_id: number
  quantity: DecimalString
  unit_cost_cents: MoneyCents
  overage_reason: string | null
}

export interface PurchaseOrderLine extends PurchaseOrderLineInput {
  id: number
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

export interface PurchaseOrder extends Omit<PurchaseOrderInput, 'lines'> {
  id: number
  status: PurchaseOrderStatus
  revision: Revision
  lines: PurchaseOrderLine[]
}

export interface PurchaseOrderCancelInput {
  reason: string
  expected_revision: Revision
}

export interface SupplierPaymentInput {
  paid_on: ISODate
  amount_cents: MoneyCents
  payment_method: string
  reference_no: string | null
  allocations: Array<{
    purchase_order_line_id: number
    amount_cents: MoneyCents
  }>
  notes: string | null
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

export interface SupplierInvoiceInput {
  invoice_no: string
  invoiced_on: ISODate
  amount_cents: MoneyCents
  allocations: Array<{
    purchase_order_line_id: number
    amount_cents: MoneyCents
  }>
  document_version_ids: number[]
}

export interface ProjectProcurementWorkspace {
  project_code: string
  procurement_lists: ProcurementList[]
  purchase_orders: PurchaseOrder[]
}

export interface InventoryItem {
  id: number
  brand: string
  name: string
  model: string
  specification: string
  unit: string
  quantity: DecimalString
  average_unit_cost_cents: MoneyCents
  inventory_value_cents: MoneyCents
  revision: Revision
}

export interface InventoryItemCreateInput {
  brand: string
  name: string
  model: string
  specification: string
  unit: string
  opening_quantity: DecimalString
  opening_unit_cost_cents: MoneyCents | null
  notes: string | null
}

export interface InventoryItemUpdateInput {
  brand: string
  name: string
  model: string
  specification: string
  unit: string
}

export interface InventoryAdjustmentInput {
  item_id: number
  quantity_delta: DecimalString
  unit_cost_cents: MoneyCents | null
  reason: string
  occurred_on: ISODate
}

export interface InventoryIssueInput {
  issued_on: ISODate
  worker_id: number
  lines: Array<{
    inventory_item_id: number
    procurement_line_id: number | null
    quantity: DecimalString
  }>
  notes: string | null
}

export type InventoryMovementKind = 'opening' | 'receipt' | 'adjustment' | 'issue' | 'issue_reversal'

export interface InventoryMovement {
  id: number
  inventory_item_id: number
  kind: InventoryMovementKind
  quantity_delta: DecimalString
  value_delta_cents: number
  occurred_on: ISODate
  project_code: string | null
  worker_id: number | null
  reason: string | null
  notes: string | null
  reversal_of_movement_id: number | null
}

export interface InventoryIssueReversalInput {
  reversed_on: ISODate
  reason: string
}

export interface InventorySnapshot {
  items: InventoryItem[]
  movements: InventoryMovement[]
}
