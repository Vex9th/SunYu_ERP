import type { ISODate, ISODateTime, MoneyCents, Revision } from './contracts'
import type {
  ProcurementLineInput,
  ProcurementListDetailDto,
  GoodsReceiptDto,
  PurchaseOrderDto,
  PurchaseOrderInput,
} from './operations-api'

export interface ProcurementImportError {
  row: number
  column: number
  field: string
  message: string
}

export interface ProcurementImportPreviewDto {
  id: number
  project_code: string
  filename: string
  sha256: string
  status: 'preview' | 'confirmed'
  revision: Revision
  expires_at: ISODateTime
  confirmed_list_id: number | null
  rows: ProcurementLineInput[]
  errors: ProcurementImportError[]
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface ProcurementImportConfirmInput {
  list_name: string
  expected_revision: Revision
}

export interface ProcurementImportConfirmDto {
  import: ProcurementImportPreviewDto
  procurement_list: ProcurementListDetailDto
}

export interface PurchaseOrderUpdateInput extends PurchaseOrderInput {
  expected_revision: Revision
}

export interface PurchaseOrderCancelInput {
  reason: string
  expected_revision: Revision
}

export interface SupplierAllocationInput {
  purchase_order_line_id: number
  amount_cents: MoneyCents
}

export interface SupplierPaymentInput {
  paid_on: ISODate
  amount_cents: MoneyCents
  payment_method: string
  reference_no: string | null
  allocations: SupplierAllocationInput[]
  notes: string | null
}

export interface SupplierPaymentDto extends SupplierPaymentInput {
  id: number
  purchase_order_id: number
  status: 'active' | 'reversed'
  reversal_reason: string | null
  reversed_at: ISODateTime | null
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface SupplierInvoiceInput {
  invoice_no: string
  invoiced_on: ISODate
  amount_cents: MoneyCents
  allocations: SupplierAllocationInput[]
  document_version_ids: number[]
}

export interface SupplierInvoiceDto extends SupplierInvoiceInput {
  id: number
  purchase_order_id: number
  status: 'active' | 'reversed'
  reversal_reason: string | null
  reversed_at: ISODateTime | null
  revision: Revision
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface SupplierRecordReversalInput {
  reason: string
  expected_revision: Revision
}

export interface PurchaseOrderFacts {
  cancelled_at: ISODateTime | null
  cancel_reason: string | null
  paid_amount_cents: MoneyCents
  invoiced_amount_cents: MoneyCents
  received_amount_cents: MoneyCents
  supplier_payments: SupplierPaymentDto[]
  supplier_invoices: SupplierInvoiceDto[]
  goods_receipts: GoodsReceiptDto[]
}

export type PurchaseOrderRecordDto = PurchaseOrderDto & Partial<PurchaseOrderFacts>

export interface QuoteExportInput {
  title: string
  customer_company_id: number
  notes: string | null
}

export interface QuoteExportDto extends QuoteExportInput {
  id: number
  project_code: string
  procurement_list_id: number
  customer_company_name: string
  created_at: ISODateTime
  download_url: string
}
