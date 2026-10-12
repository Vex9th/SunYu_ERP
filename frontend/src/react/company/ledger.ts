export interface SupplierAmounts {
  ordered_amount_cents: number
  paid_amount_cents: number
  unpaid_amount_cents: number
  invoiced_amount_cents: number
  uninvoiced_amount_cents: number
}

export interface SupplierOrder extends SupplierAmounts {
  order_id: number
  order_no: string
  project_id: number
  project_code: string
  project_name: string
  ordered_on: string
  status: 'confirmed' | 'partially_received' | 'received'
}

export interface CustomerAmounts {
  contracted_amount_cents: number
  allocated_received_amount_cents: number
  unreceived_amount_cents: number
  unallocated_received_amount_cents: number
  invoiced_amount_cents: number
}

export interface CustomerContract {
  allocation_id: number
  contract_id: number
  contract_no: string
  title: string
  status: 'signed' | 'completed' | 'terminated'
  signed_on: string | null
  allocated_amount_cents: number
  received_amount_cents: number
  unreceived_amount_cents: number
}

export interface CustomerProject extends CustomerAmounts {
  project_id: number
  project_code: string
  project_name: string
  contracts: CustomerContract[]
}

export interface CompanyLedgerData {
  company_id: number
  supplier: {
    summary: SupplierAmounts & { project_count: number; order_count: number }
    orders: SupplierOrder[]
  }
  customer: {
    summary: CustomerAmounts & { project_count: number; contract_count: number }
    projects: CustomerProject[]
  }
}

// 汇总使用筛选后的完整明细，分页只影响显示，不影响金额。
export function summarizeSupplier(orders: SupplierOrder[]) {
  return {
    project_count: new Set(orders.map(order => order.project_id)).size,
    order_count: orders.length,
    ordered_amount_cents: orders.reduce((sum, row) => sum + row.ordered_amount_cents, 0),
    paid_amount_cents: orders.reduce((sum, row) => sum + row.paid_amount_cents, 0),
    unpaid_amount_cents: orders.reduce((sum, row) => sum + row.unpaid_amount_cents, 0),
    invoiced_amount_cents: orders.reduce((sum, row) => sum + row.invoiced_amount_cents, 0),
    uninvoiced_amount_cents: orders.reduce((sum, row) => sum + row.uninvoiced_amount_cents, 0),
  }
}

export function summarizeCustomer(projects: CustomerProject[]) {
  return {
    project_count: projects.length,
    contract_count: new Set(projects.flatMap(project => project.contracts.map(contract => contract.contract_id))).size,
    contracted_amount_cents: projects.reduce((sum, row) => sum + row.contracted_amount_cents, 0),
    allocated_received_amount_cents: projects.reduce((sum, row) => sum + row.allocated_received_amount_cents, 0),
    unreceived_amount_cents: projects.reduce((sum, row) => sum + row.unreceived_amount_cents, 0),
    unallocated_received_amount_cents: projects.reduce((sum, row) => sum + row.unallocated_received_amount_cents, 0),
    invoiced_amount_cents: projects.reduce((sum, row) => sum + row.invoiced_amount_cents, 0),
  }
}
