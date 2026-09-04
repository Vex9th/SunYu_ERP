import {
  createRetriableMultipartPostSender,
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
  ProjectStage,
  Quote,
  QuoteStatus,
  Receipt,
} from '../domain/contracts'
import type { RepositoryResult } from './common'
import type {
  ProjectStageRepository,
  StageScheduleInput,
  StageTransitionInput,
} from './project'

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

export interface ProjectRestoreInput {
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

export type DocumentArchiveFilter = 'active' | 'archived' | 'all'

export interface DocumentListQuery {
  page?: number
  page_size?: number
  search?: string
  category?: string
  archived?: DocumentArchiveFilter
}

export interface DocumentListItem extends DocumentSummary {
  search_excerpt?: string | null
}

export interface ProjectOperatingRepository {
  getGlobalDashboard(): Promise<GlobalDashboard>
  getProjectDashboard(projectCode: string): Promise<ProjectDashboard>
  updateProject(projectCode: string, input: ProjectUpdateInput): Promise<ProjectDetail>
  closeProject(projectCode: string, input: ProjectCloseInput): Promise<ProjectDetail>
  restoreProject(projectCode: string, input: ProjectRestoreInput): Promise<ProjectDetail>
  listDocuments(
    projectCode: string,
    query?: DocumentListQuery,
  ): Promise<PagedResult<DocumentListItem>>
  getDocument(projectCode: string, documentId: number): Promise<DocumentDetail>
  createDocument(projectCode: string, input: DocumentCreateInput): Promise<DocumentDetail>
  discardCreateDocument(projectCode: string, input: DocumentCreateInput): boolean
  updateDocument(projectCode: string, documentId: number, input: DocumentUpdateInput): Promise<DocumentDetail>
  addDocumentVersion(projectCode: string, documentId: number, input: DocumentVersionInput): Promise<DocumentDetail['versions'][number]>
  discardAddDocumentVersion(projectCode: string, documentId: number, input: DocumentVersionInput): boolean
  archiveDocument(projectCode: string, documentId: number, input: DocumentArchiveInput): Promise<DocumentDetail>
  downloadDocumentVersion(
    projectCode: string,
    documentId: number,
    versionId: number,
    signal?: AbortSignal,
  ): Promise<Blob>
  listDocumentVersionOptions(projectCode: string): Promise<DocumentVersionOption[]>
  listQuotes(projectCode: string): Promise<PagedResult<Quote>>
  createQuote(projectCode: string, input: QuoteInput, files?: readonly File[]): Promise<Quote>
  discardCreateQuote(projectCode: string, input: QuoteInput, files?: readonly File[]): boolean
  updateQuote(projectCode: string, quoteId: number, input: QuoteUpdateInput): Promise<Quote>
  transitionQuote(projectCode: string, quoteId: number, input: StatusTransitionInput<QuoteStatus>): Promise<Quote>
  listContracts(projectCode: string): Promise<PagedResult<Contract>>
  createContract(projectCode: string, input: ContractInput, files?: readonly File[]): Promise<Contract>
  discardCreateContract(projectCode: string, input: ContractInput, files?: readonly File[]): boolean
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
  private readonly multipartPosts = createRetriableMultipartPostSender()

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

  restoreProject(projectCode: string, input: ProjectRestoreInput): Promise<ProjectDetail> {
    return this.posts.send(`${projectPath(projectCode)}/restore`, input)
  }

  async listProjectStages(projectCode: string): Promise<RepositoryResult<ProjectStage[]>> {
    return live(await requestJson<ProjectStage[]>(`${projectPath(projectCode)}/stages`))
  }

  async updateStageSchedule(
    projectCode: string,
    stageCode: string,
    input: StageScheduleInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const data = await requestJson<ProjectStage>(stagePath(projectCode, stageCode), {
      method: 'PUT',
      body: input,
    })
    return live(data)
  }

  async transitionStage(
    projectCode: string,
    stageCode: string,
    input: StageTransitionInput,
  ): Promise<RepositoryResult<ProjectStage>> {
    const data = await this.posts.send<ProjectStage>(
      `${stagePath(projectCode, stageCode)}/transition`,
      input,
    )
    return live(data)
  }

  listDocuments(
    projectCode: string,
    query: DocumentListQuery = {},
  ): Promise<PagedResult<DocumentListItem>> {
    return requestJson(withQuery(`${projectPath(projectCode)}/documents`, {
      page: query.page ?? 1,
      page_size: query.page_size ?? 20,
      search: query.search?.trim() || undefined,
      category: query.category || undefined,
      archived: query.archived ?? 'active',
    }))
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
      { category: input.category, title: input.title, notes: input.notes },
      [input.file],
      form,
    )
  }

  discardCreateDocument(projectCode: string, input: DocumentCreateInput): boolean {
    return this.multipartPosts.discard(
      `${projectPath(projectCode)}/documents`,
      { category: input.category, title: input.title, notes: input.notes },
      [input.file],
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
      { notes: input.notes, expected_revision: input.expected_revision },
      [input.file],
      form,
    )
  }

  discardAddDocumentVersion(
    projectCode: string,
    documentId: number,
    input: DocumentVersionInput,
  ): boolean {
    return this.multipartPosts.discard(
      `${documentPath(projectCode, documentId)}/versions`,
      { notes: input.notes, expected_revision: input.expected_revision },
      [input.file],
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
    signal?: AbortSignal,
  ): Promise<Blob> {
    return requestBlob(
      `${documentPath(projectCode, documentId)}/versions/${versionId}/download`,
      { signal },
    )
  }

  listDocumentVersionOptions(projectCode: string): Promise<DocumentVersionOption[]> {
    return requestJson(`${projectPath(projectCode)}/document-version-options`)
  }

  listQuotes(projectCode: string): Promise<PagedResult<Quote>> {
    return requestAllPages(`${projectPath(projectCode)}/quotes`)
  }

  createQuote(projectCode: string, input: QuoteInput, files: readonly File[] = []): Promise<Quote> {
    const path = `${projectPath(projectCode)}/quotes`
    return files.length > 0
      ? this.multipartPosts.send(path, input, files)
      : this.posts.send(path, input)
  }

  discardCreateQuote(projectCode: string, input: QuoteInput, files: readonly File[] = []): boolean {
    const path = `${projectPath(projectCode)}/quotes`
    return files.length > 0
      ? this.multipartPosts.discard(path, input, files)
      : this.posts.discard(path, input)
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
    return requestAllPages(`${projectPath(projectCode)}/contracts`)
  }

  createContract(projectCode: string, input: ContractInput, files: readonly File[] = []): Promise<Contract> {
    const path = `${projectPath(projectCode)}/contracts`
    return files.length > 0
      ? this.multipartPosts.send(path, input, files)
      : this.posts.send(path, input)
  }

  discardCreateContract(projectCode: string, input: ContractInput, files: readonly File[] = []): boolean {
    const path = `${projectPath(projectCode)}/contracts`
    return files.length > 0
      ? this.multipartPosts.discard(path, input, files)
      : this.posts.discard(path, input)
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

async function requestAllPages<T>(path: string): Promise<PagedResult<T>> {
  const first = await requestJson<PagedResult<T>>(withQuery(path, { page: 1, page_size: 100 }))
  const pageCount = Math.ceil(first.total / first.page_size)
  if (pageCount <= 1) return first
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => (
      requestJson<PagedResult<T>>(withQuery(path, { page: index + 2, page_size: first.page_size }))
    )),
  )
  return {
    ...first,
    items: [first, ...remaining].flatMap((page) => page.items),
  }
}

function projectPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}`
}

function stagePath(projectCode: string, stageCode: string): string {
  return `${projectPath(projectCode)}/stages/${encodeURIComponent(stageCode)}`
}

function documentPath(projectCode: string, documentId: number): string {
  return `${projectPath(projectCode)}/documents/${documentId}`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}

export function createHttpProjectOperatingRepository(): ProjectOperatingRepository & ProjectStageRepository {
  return new HttpProjectOperatingRepository()
}
