import {
  ApiError,
  createRetriablePostSender,
  requestBlob,
  requestJson,
  withQuery,
} from '../api'
import type {
  ClosureType,
  Contract,
  ContractStatus,
  DocumentDetail,
  DocumentSummary,
  GlobalDashboard,
  PagedResult,
  PaymentMilestone,
  PaymentMethod,
  PaymentOverview,
  PaymentTerm,
  ProjectDashboard,
  ProjectDetail,
  Quote,
  QuoteStatus,
  Receipt,
} from '../domain/contracts'

export interface ProjectUpdateInput {
  company_id: number
  name: string
  description: string | null
  expected_revision: number
}

export interface ProjectCloseInput {
  closure_type: ClosureType
  reason: string
  expected_revision: number
}

export interface DocumentCreateInput {
  category: string
  title: string
  notes: string | null
  file: File
}

export interface DocumentUpdateInput {
  title: string
  notes: string | null
  expected_revision: number
}

export interface DocumentVersionInput {
  notes: string | null
  expected_revision: number
  file: File
}

export interface DocumentArchiveInput {
  reason: string
  expected_revision: number
}

export interface QuoteInput {
  quote_date: string
  amount_cents: number
  valid_until: string | null
  notes: string | null
  document_version_ids: number[]
}

export interface QuoteUpdateInput extends QuoteInput {
  expected_revision: number
}

export interface ContractAllocationInput {
  project_code: string
  amount_cents: number
}

export interface ContractInput {
  contract_no: string
  title: string
  customer_company_id: number
  signed_on: string | null
  total_amount_cents: number
  final_delivery_on: string | null
  allocations: ContractAllocationInput[]
  notes: string | null
  document_version_ids: number[]
}

export interface ContractUpdateInput extends ContractInput {
  expected_revision: number
}

export interface StatusTransitionInput<TStatus extends string> {
  to_status: TStatus
  occurred_at: string
  reason: string | null
  expected_revision: number
}

export interface PaymentTermInput {
  due_on: string | null
  planned_amount_cents: number
  notes: string | null
  expected_revision: number | null
}

export interface ReceiptCreateInput {
  contract_allocation_id: number | null
  milestone: PaymentMilestone
  received_on: string
  amount_cents: number
  payment_method: PaymentMethod
  reference_no: string | null
  notes: string | null
}

export interface ReceiptUpdateInput {
  reference_no: string | null
  notes: string | null
  expected_revision: number
}

export interface ReceiptVoidInput {
  voided_on: string
  reason: string
  expected_revision: number
}

export interface DocumentVersionOption {
  value: number
  label: string
}

export interface ProjectOperatingRepository {
  getGlobalDashboard(): Promise<GlobalDashboard>
  getProjectDashboard(projectCode: string): Promise<ProjectDashboard>
  updateProject(projectCode: string, input: ProjectUpdateInput): Promise<ProjectDetail>
  closeProject(projectCode: string, input: ProjectCloseInput): Promise<ProjectDetail>
  listDocuments(projectCode: string): Promise<PagedResult<DocumentSummary>>
  getDocument(projectCode: string, documentId: number): Promise<DocumentDetail>
  createDocument(projectCode: string, input: DocumentCreateInput): Promise<DocumentDetail>
  updateDocument(projectCode: string, documentId: number, input: DocumentUpdateInput): Promise<DocumentDetail>
  addDocumentVersion(projectCode: string, documentId: number, input: DocumentVersionInput): Promise<DocumentDetail['versions'][number]>
  archiveDocument(projectCode: string, documentId: number, input: DocumentArchiveInput): Promise<DocumentDetail>
  downloadDocumentVersion(projectCode: string, documentId: number, versionId: number): Promise<Blob>
  listDocumentVersionOptions(projectCode: string): Promise<DocumentVersionOption[]>
  listQuotes(projectCode: string): Promise<PagedResult<Quote>>
  createQuote(projectCode: string, input: QuoteInput): Promise<Quote>
  updateQuote(projectCode: string, quoteId: number, input: QuoteUpdateInput): Promise<Quote>
  transitionQuote(projectCode: string, quoteId: number, input: StatusTransitionInput<QuoteStatus>): Promise<Quote>
  listContracts(projectCode: string): Promise<PagedResult<Contract>>
  createContract(projectCode: string, input: ContractInput): Promise<Contract>
  updateContract(projectCode: string, contractId: number, input: ContractUpdateInput): Promise<Contract>
  transitionContract(projectCode: string, contractId: number, input: StatusTransitionInput<ContractStatus>): Promise<Contract>
  getPayments(projectCode: string): Promise<PaymentOverview>
  putPaymentTerm(projectCode: string, milestone: PaymentMilestone, input: PaymentTermInput): Promise<PaymentTerm>
  createReceipt(projectCode: string, input: ReceiptCreateInput): Promise<Receipt>
  updateReceipt(projectCode: string, receiptId: number, input: ReceiptUpdateInput): Promise<Receipt>
  voidReceipt(projectCode: string, receiptId: number, input: ReceiptVoidInput): Promise<Receipt>
}

class HttpProjectOperatingRepository implements ProjectOperatingRepository {
  private readonly posts = createRetriablePostSender()
  private readonly multipartPosts = new RetriableMultipartPostSender()

  getGlobalDashboard(): Promise<GlobalDashboard> {
    return requestJson('/api/dashboard')
  }

  getProjectDashboard(projectCode: string): Promise<ProjectDashboard> {
    return requestJson(`${projectPath(projectCode)}/dashboard`)
  }

  updateProject(projectCode: string, input: ProjectUpdateInput): Promise<ProjectDetail> {
    return requestJson(projectPath(projectCode), { method: 'PUT', body: input })
  }

  closeProject(projectCode: string, input: ProjectCloseInput): Promise<ProjectDetail> {
    return this.posts.send(`${projectPath(projectCode)}/close`, input)
  }

  listDocuments(projectCode: string): Promise<PagedResult<DocumentSummary>> {
    return requestJson(withQuery(`${projectPath(projectCode)}/documents`, { page: 1, page_size: 100 }))
  }

  getDocument(projectCode: string, documentId: number): Promise<DocumentDetail> {
    return requestJson(documentPath(projectCode, documentId))
  }

  createDocument(projectCode: string, input: DocumentCreateInput): Promise<DocumentDetail> {
    const form = new FormData()
    form.set('category', input.category)
    form.set('title', input.title)
    if (input.notes !== null) form.set('notes', input.notes)
    form.set('file', input.file)
    return this.multipartPosts.send(
      `${projectPath(projectCode)}/documents`,
      multipartSignature(input),
      form,
    )
  }

  updateDocument(
    projectCode: string,
    documentId: number,
    input: DocumentUpdateInput,
  ): Promise<DocumentDetail> {
    return requestJson(documentPath(projectCode, documentId), { method: 'PUT', body: input })
  }

  addDocumentVersion(
    projectCode: string,
    documentId: number,
    input: DocumentVersionInput,
  ): Promise<DocumentDetail['versions'][number]> {
    const form = new FormData()
    if (input.notes !== null) form.set('notes', input.notes)
    form.set('expected_revision', String(input.expected_revision))
    form.set('file', input.file)
    return this.multipartPosts.send(
      `${documentPath(projectCode, documentId)}/versions`,
      multipartSignature(input),
      form,
    )
  }

  archiveDocument(
    projectCode: string,
    documentId: number,
    input: DocumentArchiveInput,
  ): Promise<DocumentDetail> {
    return this.posts.send(`${documentPath(projectCode, documentId)}/archive`, input)
  }

  downloadDocumentVersion(
    projectCode: string,
    documentId: number,
    versionId: number,
  ): Promise<Blob> {
    return requestBlob(`${documentPath(projectCode, documentId)}/versions/${versionId}/download`)
  }

  async listDocumentVersionOptions(projectCode: string): Promise<DocumentVersionOption[]> {
    const listing = await this.listDocuments(projectCode)
    const details = await Promise.all(listing.items.map((item) => this.getDocument(projectCode, item.id)))
    return details.flatMap((document) => document.versions.map((version) => ({
      value: version.id,
      label: `${document.title} V${version.version_number} · ${version.original_filename}`,
    })))
  }

  listQuotes(projectCode: string): Promise<PagedResult<Quote>> {
    return requestJson(withQuery(`${projectPath(projectCode)}/quotes`, { page: 1, page_size: 100 }))
  }

  createQuote(projectCode: string, input: QuoteInput): Promise<Quote> {
    return this.posts.send(`${projectPath(projectCode)}/quotes`, input)
  }

  updateQuote(projectCode: string, quoteId: number, input: QuoteUpdateInput): Promise<Quote> {
    return requestJson(`${projectPath(projectCode)}/quotes/${quoteId}`, { method: 'PUT', body: input })
  }

  transitionQuote(
    projectCode: string,
    quoteId: number,
    input: StatusTransitionInput<QuoteStatus>,
  ): Promise<Quote> {
    return this.posts.send(`${projectPath(projectCode)}/quotes/${quoteId}/transition`, input)
  }

  listContracts(projectCode: string): Promise<PagedResult<Contract>> {
    return requestJson(withQuery(`${projectPath(projectCode)}/contracts`, { page: 1, page_size: 100 }))
  }

  createContract(projectCode: string, input: ContractInput): Promise<Contract> {
    return this.posts.send(`${projectPath(projectCode)}/contracts`, input)
  }

  updateContract(
    projectCode: string,
    contractId: number,
    input: ContractUpdateInput,
  ): Promise<Contract> {
    return requestJson(`${projectPath(projectCode)}/contracts/${contractId}`, {
      method: 'PUT',
      body: input,
    })
  }

  transitionContract(
    projectCode: string,
    contractId: number,
    input: StatusTransitionInput<ContractStatus>,
  ): Promise<Contract> {
    return this.posts.send(`${projectPath(projectCode)}/contracts/${contractId}/transition`, input)
  }

  getPayments(projectCode: string): Promise<PaymentOverview> {
    return requestJson(`${projectPath(projectCode)}/payments`)
  }

  putPaymentTerm(
    projectCode: string,
    milestone: PaymentMilestone,
    input: PaymentTermInput,
  ): Promise<PaymentTerm> {
    return requestJson(`${projectPath(projectCode)}/payment-terms/${milestone}`, {
      method: 'PUT',
      body: input,
    })
  }

  createReceipt(projectCode: string, input: ReceiptCreateInput): Promise<Receipt> {
    return this.posts.send(`${projectPath(projectCode)}/receipts`, input)
  }

  updateReceipt(
    projectCode: string,
    receiptId: number,
    input: ReceiptUpdateInput,
  ): Promise<Receipt> {
    return requestJson(`${projectPath(projectCode)}/receipts/${receiptId}`, {
      method: 'PUT',
      body: input,
    })
  }

  voidReceipt(projectCode: string, receiptId: number, input: ReceiptVoidInput): Promise<Receipt> {
    return this.posts.send(`${projectPath(projectCode)}/receipts/${receiptId}/void`, input)
  }
}

interface PendingMultipartPost {
  signature: string
  idempotencyKey: string
  inFlight?: Promise<unknown>
}

class RetriableMultipartPostSender {
  private readonly pendingByPath = new Map<string, PendingMultipartPost>()

  send<T>(path: string, signature: string, body: FormData): Promise<T> {
    let pending = this.pendingByPath.get(path)
    if (pending?.inFlight) {
      if (pending.signature === signature) return pending.inFlight as Promise<T>
      return Promise.reject(new Error('该路径已有其他文件正在上传'))
    }
    if (!pending || pending.signature !== signature) {
      pending = { signature, idempotencyKey: crypto.randomUUID() }
      this.pendingByPath.set(path, pending)
    }
    const active = pending
    const request = requestJson<T>(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': active.idempotencyKey },
      body,
    }).then(
      (result) => {
        if (this.pendingByPath.get(path) === active) this.pendingByPath.delete(path)
        return result
      },
      (error: unknown) => {
        if (this.pendingByPath.get(path) === active) {
          active.inFlight = undefined
          if (isDefinitiveClientRejection(error)) this.pendingByPath.delete(path)
        }
        throw error
      },
    )
    active.inFlight = request
    return request
  }
}

function isDefinitiveClientRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function multipartSignature(input: DocumentCreateInput | DocumentVersionInput): string {
  return JSON.stringify({
    ...input,
    file: {
      name: input.file.name,
      size: input.file.size,
      type: input.file.type,
      lastModified: input.file.lastModified,
    },
  })
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function documentPath(projectCode: string, documentId: number): string {
  return `${projectPath(projectCode)}/documents/${documentId}`
}

export function createHttpProjectOperatingRepository(): ProjectOperatingRepository {
  return new HttpProjectOperatingRepository()
}
