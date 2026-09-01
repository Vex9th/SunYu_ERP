import {
  ApiError,
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
import type {
  ProcurementImportConfirmDto,
  ProcurementImportConfirmInput,
  ProcurementImportPreviewDto,
  PurchaseOrderCancelInput,
  PurchaseOrderUpdateInput,
  QuoteExportDto,
  QuoteExportInput,
  SupplierInvoiceDto,
  SupplierInvoiceInput,
  SupplierPaymentDto,
  SupplierPaymentInput,
} from '../domain/procurement-extensions'
import type { RepositoryResult } from './common'

export interface PurchaseOrderListQuery extends PaginationQuery {
  status?: PurchaseOrderStatus
}

export interface ProcurementHttpRepository {
  listSupplierCompanies(): Promise<RepositoryResult<CompanyRecord[]>>
  downloadImportTemplate(): Promise<Blob>
  previewProcurementImport(projectCode: string, file: File): Promise<RepositoryResult<ProcurementImportPreviewDto>>
  confirmProcurementImport(projectCode: string, importId: number, input: ProcurementImportConfirmInput): Promise<RepositoryResult<ProcurementImportConfirmDto>>
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
  updatePurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderUpdateInput): Promise<RepositoryResult<PurchaseOrderDto>>
  cancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): Promise<RepositoryResult<PurchaseOrderDto>>
  receiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<RepositoryResult<GoodsReceiptDto>>
  createSupplierPayment(projectCode: string, orderId: number, input: SupplierPaymentInput): Promise<RepositoryResult<SupplierPaymentDto>>
  createSupplierInvoice(projectCode: string, orderId: number, input: SupplierInvoiceInput): Promise<RepositoryResult<SupplierInvoiceDto>>
  createQuoteExport(projectCode: string, listId: number, input: QuoteExportInput): Promise<RepositoryResult<QuoteExportDto>>
  downloadQuoteExport(projectCode: string, exportId: number): Promise<Blob>
  getProcurementOverview(projectCode: string): Promise<RepositoryResult<ProcurementOverviewDto>>
  discardCreateProcurementList(projectCode: string, input: ProcurementListInput): boolean
  discardCreateProcurementLine(projectCode: string, listId: number, input: ProcurementLineInput): boolean
  discardCreatePurchaseOrder(projectCode: string, input: PurchaseOrderInput): boolean
  discardReceiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): boolean
  discardPreviewProcurementImport(projectCode: string, file: File): boolean
  discardConfirmProcurementImport(projectCode: string, importId: number, input: ProcurementImportConfirmInput): boolean
  discardCancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): boolean
  discardCreateSupplierPayment(projectCode: string, orderId: number, input: SupplierPaymentInput): boolean
  discardCreateSupplierInvoice(projectCode: string, orderId: number, input: SupplierInvoiceInput): boolean
  discardCreateQuoteExport(projectCode: string, listId: number, input: QuoteExportInput): boolean
}

class HttpProcurementRepository implements ProcurementHttpRepository {
  private readonly postSender = createRetriablePostSender()
  private readonly uploadSender = new RetriableFileUploadSender()

  async listSupplierCompanies(): Promise<RepositoryResult<CompanyRecord[]>> {
    return live(await requestJson('/api/companies'))
  }

  downloadImportTemplate(): Promise<Blob> {
    return requestBlob('/api/procurement/import-template.xlsx')
  }

  async previewProcurementImport(projectCode: string, file: File): Promise<RepositoryResult<ProcurementImportPreviewDto>> {
    return live(await this.uploadSender.send(procurementImportPreviewPath(projectCode), file))
  }

  async confirmProcurementImport(projectCode: string, importId: number, input: ProcurementImportConfirmInput): Promise<RepositoryResult<ProcurementImportConfirmDto>> {
    return live(await this.postSender.send(`${procurementImportsPath(projectCode)}/${importId}/confirm`, input))
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

  async updatePurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderUpdateInput): Promise<RepositoryResult<PurchaseOrderDto>> {
    return live(await requestJson(purchaseOrderPath(projectCode, orderId), { method: 'PUT', body: input }))
  }

  async cancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): Promise<RepositoryResult<PurchaseOrderDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/cancel`, input))
  }

  async receiveGoods(projectCode: string, orderId: number, input: GoodsReceiptInput): Promise<RepositoryResult<GoodsReceiptDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/goods-receipts`, input))
  }

  async createSupplierPayment(projectCode: string, orderId: number, input: SupplierPaymentInput): Promise<RepositoryResult<SupplierPaymentDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/supplier-payments`, input))
  }

  async createSupplierInvoice(projectCode: string, orderId: number, input: SupplierInvoiceInput): Promise<RepositoryResult<SupplierInvoiceDto>> {
    return live(await this.postSender.send(`${purchaseOrderPath(projectCode, orderId)}/supplier-invoices`, input))
  }

  async createQuoteExport(projectCode: string, listId: number, input: QuoteExportInput): Promise<RepositoryResult<QuoteExportDto>> {
    return live(await this.postSender.send(`${procurementListPath(projectCode, listId)}/quote-exports`, input))
  }

  downloadQuoteExport(projectCode: string, exportId: number): Promise<Blob> {
    return requestBlob(`${projectBasePath(projectCode)}/quote-exports/${exportId}/download`)
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

  discardPreviewProcurementImport(projectCode: string, file: File): boolean {
    return this.uploadSender.discard(procurementImportPreviewPath(projectCode), file)
  }

  discardConfirmProcurementImport(projectCode: string, importId: number, input: ProcurementImportConfirmInput): boolean {
    return this.postSender.discard(`${procurementImportsPath(projectCode)}/${importId}/confirm`, input)
  }

  discardCancelPurchaseOrder(projectCode: string, orderId: number, input: PurchaseOrderCancelInput): boolean {
    return this.postSender.discard(`${purchaseOrderPath(projectCode, orderId)}/cancel`, input)
  }

  discardCreateSupplierPayment(projectCode: string, orderId: number, input: SupplierPaymentInput): boolean {
    return this.postSender.discard(`${purchaseOrderPath(projectCode, orderId)}/supplier-payments`, input)
  }

  discardCreateSupplierInvoice(projectCode: string, orderId: number, input: SupplierInvoiceInput): boolean {
    return this.postSender.discard(`${purchaseOrderPath(projectCode, orderId)}/supplier-invoices`, input)
  }

  discardCreateQuoteExport(projectCode: string, listId: number, input: QuoteExportInput): boolean {
    return this.postSender.discard(`${procurementListPath(projectCode, listId)}/quote-exports`, input)
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

function procurementImportsPath(projectCode: string): string {
  return `${projectBasePath(projectCode)}/procurement-imports`
}

function procurementImportPreviewPath(projectCode: string): string {
  return `${procurementImportsPath(projectCode)}/preview`
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

interface PendingFileUpload {
  file: File
  idempotencyKey: string
  inFlight?: Promise<ProcurementImportPreviewDto>
}

class RetriableFileUploadSender {
  private readonly pendingByPath = new Map<string, PendingFileUpload>()

  send(path: string, file: File): Promise<ProcurementImportPreviewDto> {
    let pending = this.pendingByPath.get(path)
    if (pending?.inFlight) {
      if (pending.file === file) return pending.inFlight
      return Promise.reject(new Error('已有其他采购清单正在上传'))
    }
    if (!pending || pending.file !== file) {
      pending = { file, idempotencyKey: crypto.randomUUID() }
      this.pendingByPath.set(path, pending)
    }
    const form = new FormData()
    form.append('file', file, file.name)
    const active = pending
    const request = requestJson<ProcurementImportPreviewDto>(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': active.idempotencyKey },
      body: form,
    }).then(
      (result) => {
        if (this.pendingByPath.get(path) === active) this.pendingByPath.delete(path)
        return result
      },
      (error: unknown) => {
        if (this.pendingByPath.get(path) === active) {
          active.inFlight = undefined
          if (error instanceof ApiError && error.status >= 400 && error.status < 500
            && ![408, 425, 429].includes(error.status)) {
            this.pendingByPath.delete(path)
          }
        }
        throw error
      },
    )
    active.inFlight = request
    return request
  }

  discard(path: string, file: File): boolean {
    const pending = this.pendingByPath.get(path)
    if (!pending || pending.inFlight || pending.file !== file) return false
    return this.pendingByPath.delete(path)
  }
}
