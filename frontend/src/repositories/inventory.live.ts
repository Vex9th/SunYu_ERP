import { createRetriablePostSender, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  InventoryAdjustmentDto,
  InventoryAdjustmentInput,
  InventoryIssueDto,
  InventoryIssueInput,
  InventoryIssueReversalInput,
  InventoryItemDetailDto,
  InventoryItemDto,
  InventoryItemInput,
  InventoryItemUpdateInput,
  InventoryMovementDto,
  PaginationQuery,
} from '../domain/operations-api'
import type { RepositoryResult } from './common'

export interface InventoryListQuery extends PaginationQuery {
  query?: string
  status?: 'all' | 'in_stock' | 'out_of_stock'
}

export interface InventoryHttpRepository {
  listInventoryItems(query?: InventoryListQuery): Promise<RepositoryResult<PagedResult<InventoryItemDto>>>
  createInventoryItem(input: InventoryItemInput): Promise<RepositoryResult<InventoryItemDto>>
  getInventoryItem(itemId: number): Promise<RepositoryResult<InventoryItemDetailDto>>
  updateInventoryItem(itemId: number, input: InventoryItemUpdateInput): Promise<RepositoryResult<InventoryItemDto>>
  listInventoryMovements(itemId: number, query?: PaginationQuery): Promise<RepositoryResult<PagedResult<InventoryMovementDto>>>
  createInventoryAdjustment(input: InventoryAdjustmentInput): Promise<RepositoryResult<InventoryAdjustmentDto>>
  createProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): Promise<RepositoryResult<InventoryIssueDto>>
  reverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): Promise<RepositoryResult<InventoryIssueDto>>
  discardCreateInventoryItem(input: InventoryItemInput): boolean
  discardCreateInventoryAdjustment(input: InventoryAdjustmentInput): boolean
  discardCreateProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): boolean
  discardReverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): boolean
}

class HttpInventoryRepository implements InventoryHttpRepository {
  private readonly postSender = createRetriablePostSender()

  async listInventoryItems(query: InventoryListQuery = {}): Promise<RepositoryResult<PagedResult<InventoryItemDto>>> {
    return live(await requestJson(withQuery('/api/inventory/items', query)))
  }

  async createInventoryItem(input: InventoryItemInput): Promise<RepositoryResult<InventoryItemDto>> {
    return live(await this.postSender.send(INVENTORY_ITEMS_PATH, input))
  }

  async getInventoryItem(itemId: number): Promise<RepositoryResult<InventoryItemDetailDto>> {
    return live(await requestJson(itemPath(itemId)))
  }

  async updateInventoryItem(itemId: number, input: InventoryItemUpdateInput): Promise<RepositoryResult<InventoryItemDto>> {
    return live(await requestJson(itemPath(itemId), { method: 'PUT', body: input }))
  }

  async listInventoryMovements(itemId: number, query: PaginationQuery = {}): Promise<RepositoryResult<PagedResult<InventoryMovementDto>>> {
    return live(await requestJson(withQuery(`${itemPath(itemId)}/movements`, query)))
  }

  async createInventoryAdjustment(input: InventoryAdjustmentInput): Promise<RepositoryResult<InventoryAdjustmentDto>> {
    return live(await this.postSender.send(INVENTORY_ADJUSTMENTS_PATH, input))
  }

  async createProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): Promise<RepositoryResult<InventoryIssueDto>> {
    return live(await this.postSender.send(projectInventoryIssuesPath(projectCode), input))
  }

  async reverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): Promise<RepositoryResult<InventoryIssueDto>> {
    return live(await this.postSender.send(projectInventoryIssueReversePath(projectCode, issueId), input))
  }

  discardCreateInventoryItem(input: InventoryItemInput): boolean {
    return this.postSender.discard(INVENTORY_ITEMS_PATH, input)
  }

  discardCreateInventoryAdjustment(input: InventoryAdjustmentInput): boolean {
    return this.postSender.discard(INVENTORY_ADJUSTMENTS_PATH, input)
  }

  discardCreateProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): boolean {
    return this.postSender.discard(projectInventoryIssuesPath(projectCode), input)
  }

  discardReverseProjectInventoryIssue(projectCode: string, issueId: number, input: InventoryIssueReversalInput): boolean {
    return this.postSender.discard(projectInventoryIssueReversePath(projectCode, issueId), input)
  }
}

const INVENTORY_ITEMS_PATH = '/api/inventory/items'
const INVENTORY_ADJUSTMENTS_PATH = '/api/inventory/adjustments'

export function createHttpInventoryRepository(): InventoryHttpRepository {
  return new HttpInventoryRepository()
}

function itemPath(itemId: number): string {
  return `/api/inventory/items/${itemId}`
}

function projectInventoryIssuesPath(projectCode: string): string {
  return `/api/projects/${encodeURIComponent(projectCode)}/inventory-issues`
}

function projectInventoryIssueReversePath(projectCode: string, issueId: number): string {
  return `${projectInventoryIssuesPath(projectCode)}/${issueId}/reverse`
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
