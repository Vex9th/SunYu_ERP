import { createPlannedPostRequest, requestJson, withQuery } from '../api'
import type { PagedResult } from '../domain/contracts'
import type {
  InventoryAdjustmentDto,
  InventoryAdjustmentInput,
  InventoryIssueDto,
  InventoryIssueInput,
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
}

class HttpInventoryRepository implements InventoryHttpRepository {
  async listInventoryItems(query: InventoryListQuery = {}): Promise<RepositoryResult<PagedResult<InventoryItemDto>>> {
    return live(await requestJson(withQuery('/api/inventory/items', query)))
  }

  async createInventoryItem(input: InventoryItemInput): Promise<RepositoryResult<InventoryItemDto>> {
    return live(await post('/api/inventory/items', input))
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
    return live(await post('/api/inventory/adjustments', input))
  }

  async createProjectInventoryIssue(projectCode: string, input: InventoryIssueInput): Promise<RepositoryResult<InventoryIssueDto>> {
    return live(await post(`/api/projects/${encodeURIComponent(projectCode)}/inventory-issues`, input))
  }
}

export function createHttpInventoryRepository(): InventoryHttpRepository {
  return new HttpInventoryRepository()
}

function itemPath(itemId: number): string {
  return `/api/inventory/items/${itemId}`
}

function post<T>(path: string, body: unknown): Promise<T> {
  return createPlannedPostRequest<T>(path, body).send()
}

function live<T>(data: T): RepositoryResult<T> {
  return { source: 'live', data }
}
