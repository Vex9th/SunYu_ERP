import {
  createRetriablePostSender,
  requestBlob,
  requestJson,
  requestVoid,
  withQuery,
} from '../api'
import type { CompanyRecord, PagedResult } from '../domain/contracts'
import type {
  ConfirmRevisionInput,
  GoodsReceiptDto,
  GoodsReceiptInput,
  PaginationQuery,
  ProcurementLineDto,
  ProcurementLineInput,
  ProcurementLineUpdateInput,
  ProcurementListDetailDto,
  ProcurementListInput,
  ProcurementListSummaryDto,
  ProcurementListUpdateInput,
  ProcurementOverviewDto,
  PurchaseOrderDto,
  PurchaseOrderInput,
} from '../domain/operations-api'
import type { PurchaseOrderStatus } from '../domain/procurement'
import type { RepositoryResult } from './common'

export interface PurchaseOrderListQuery extends PaginationQuery {
  status?: PurchaseOrderStatus
}

export interface ProcurementHttpRepository {
  listSupplierCompanies(): Promise<RepositoryResult<CompanyRecord[]>>
  downloadImportTemplate(): Promise<Blob>
  listProcurementLists(projectCode: string, query?: PaginationQuery): Promise<RepositoryResult<PagedResult<ProcurementListSummaryDto>>>
  createProcurementList(projectCode: string, input: ProcurementListInput): Promise<RepositoryResult<ProcurementListDetailDto>>
  getProcurementList(projectCode: string, listId: number): Promise<RepositoryResult<ProcurementListDetailDto>>
  updateProcurementList(projectCode: string, listId: number, input: ProcurementListUpdateInput): Promise<RepositoryResult<ProcurementListDetailDto>>
  createProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): Promise<RepositoryResult<ProcurementLineDto>>
  updateProcurementLine(projectCode: string, listId: number, lineId: number, input: ProcurementLineUpdateInput): Promise<RepositoryResult<ProcurementLineDto>>
  deleteProcurementLine(projectCode: string, listId: number, lineId: number): Promise<void>
  confirmProcurementList(projectCode: string, listId: number, input: ConfirmRevisionInput): Promise<RepositoryResult<ProcurementListDetailDto>>
  listPurchaseOrders(projectCode: string, query?: PurchaseOrderListQuery): Promise<RepositoryResult<PagedResult<PurchaseOrderDto>>>
  createPurchaseOrder(projectCode: string, input: PurchaseOrderInput): Promise<RepositoryResult<PurchaseOrderDto>>
  getPurchaseOrder(projectCode: string, orderId: number): Promise<RepositoryResult<PurchaseOrderDto>>
  confirmPurchaseOrder(projectCode: string, orderId: number, input: ConfirmRevisionInput): Promise<RepositoryResult<PurchaseOrderDto>>
  receiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<RepositoryResult<GoodsReceiptDto>>
  getProcurementOverview(projectCode: string): Promise<RepositoryResult<ProcurementOverviewDto>>
  discardCreateProcurementList(projectCode: string, input: ProcurementListInput): boolean
  discardCreateProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): boolean
  discardCreatePurchaseOrder(projectCode: string, input: PurchaseOrderInput): boolean
  discardReceiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): boolean
}

class HttpProcurementRepository implements ProcurementHttpRepository {
  private readonly postSender = createRetriablePostSender()

  async listSupplierCompanies(): Promise<RepositoryResult<CompanyRecord[]>> {
    return live(await requestJson('/api/companies'))
  }

  downloadImportTemplate(): Promise<Blob> {
    return requestBlob('/api/procurement/import-template.xlsx')
  }

  async listProcurementLists(projectCode: string, query: PaginationQuery = {}): Promise<RepositoryResult<PagedResult<ProcurementListSummaryDto>>> {
    return live(await requestJson(withQuery(procurementListsPath(projectCode), query)))
  }

  async createProcurementList(projectCode: string, input: ProcurementListInput): Promise<RepositoryResult<ProcurementListDetailDto>> {
    return live(await this.postSender.send(procurementListsPath(projectCode), input))
  }

  async getProcurementList(projectCode: string, listId: number): Promise<RepositoryResult<ProcurementListDetailDto>> {
    return live(await requestJson(procurementListPath(projectCode, listId)))
  }

  async updateProcurementList(projectCode: string, listId: number, input: ProcurementListUpdateInput): Promise<RepositoryResult<ProcurementListDetailDto>> {
    return live(await requestJson(procurementListPath(projectCode, listId), { method: 'PUT', body: input }))
  }

  async createProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): Promise<RepositoryResult<ProcurementLineDto>> {
    return live(await this.postSender.send(`${procurementListPath(projectCode, listId)}/lines`, input))
  }

  async updateProcurementLine(projectCode: string, listId: number, lineId: number, input: ProcurementLineUpdateInput): Promise<RepositoryResult<ProcurementLineDto>> {
    return live(await requestJson(procurementLinePath(projectCode, listId, lineId), { method: 'PUT', body: input }))
  }

  deleteProcurementLine(projectCode: string, listId: number, lineId: number): Promise<void> {
    return requestVoid(procurementLinePath(projectCode, listId, lineId), { method: 'DELETE' })
  }

  async confirmProcurementList(projectCode: string, listId: number, input: ConfirmRevisionInput): Promise<RepositoryResult<ProcurementListDetailDto>> {
    return live(await this.postSender.send(`${procurementListPath(projectCode, listId)}/confirm`, input))
  }

  async listPurchaseOrders(projectCode: string, query: PurchaseOrderListQuery = {}): Promise<RepositoryResult<PagedResult<PurchaseOrderDto>>> {
    return live(await requestJson(withQuery(purchaseOrdersPath(projectCode), query)))
  }

  async createPurchaseOrder(projectCode: string, input: PurchaseOrderInput): Promise<RepositoryResult<PurchaseOrderDto>> {
    return live(await this.postSender.send(purchaseOrdersPath(projectCode), input))
  }

  async getPurchaseOrder(projectCode: string, orderId: number): Promise<RepositoryResult<PurchaseOrderDto>> {
    return live(await requestJson(purchaseOrderPath(projectCode, orderId)))
  }

  async confirmPurchaseOrder(projectCode: string, orderId: number, input: ConfirmRevisionInput): Promise<RepositoryResult<PurchaseOrderDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/confirm`, input))
  }

  async receiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<RepositoryResult<GoodsReceiptDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/goods-receipts`, input))
  }

  async getProcurementOverview(projectCode: string): Promise<RepositoryResult<ProcurementOverviewDto>> {
    return live(await requestJson(`${projectBasePath(projectCode)}/procurement-overview`))
  }

  discardCreateProcurementList(projectCode: string, input: ProcurementListInput): boolean {
    return this.postSender.discard(procurementListsPath(projectCode), input)
  }

  discardCreateProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): boolean {
    return this.postSender.discard(`${procurementListPath(projectCode, listId)}/lines`, input)
  }

  discardCreatePurchaseOrder(projectCode: string, input: PurchaseOrderInput): boolean {
    return this.postSender.discard(purchaseOrdersPath(projectCode), input)
  }

  discardReceiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): boolean {
    return this.postSender.discard(`${purchaseOrderPath(projectCode, orderId)}/goods-receipts`, input)
  }
}

export function createHttpProcurementRepository(): ProcurementHttpRepository {
  return new HttpProcurementRepository()
}

function projectBasePath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function procurementListsPath(projectCode: string): string {
  return `${projectBasePath(projectCode)}/procurement-lists`
}

function procurementListPath(projectCode: string, listId: number): string {
  return `${procurementListsPath(projectCode)}/${listId}`
}

function procurementLinePath(projectCode: string, listId: number, lineId: number): string {
  return `${procurementListPath(projectCode, listId)}/lines/${lineId}`
}

function purchaseOrdersPath(projectCode: string): string {
  return `${projectBasePath(projectCode)}/purchase-orders`
}

function purchaseOrderPath(projectCode: string, orderId: number): string {
  return `${purchaseOrdersPath(projectCode)}/${orderId}`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
