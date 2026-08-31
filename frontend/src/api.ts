export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: HeadersInit
  body?: unknown
}

import type { ApiErrorPayload } from './domain/contracts'

export type { ApiErrorPayload } from './domain/contracts'

const knownErrorMessages: Record<string, string> = {
  'Authentication required': '登录状态已失效，请重新登录',
  'Password must be exactly six ASCII digits': '密码必须是 6 位 ASCII 数字',
  'Password is already configured': '密码已设置',
  'Password is not configured': '尚未设置密码',
  'Too many login attempts': '登录尝试过于频繁，请稍后再试',
  'Invalid password': '密码错误',
  'Invalid backup settings': '备份设置无效',
  'Backup settings update failed': '备份设置保存失败',
  'Backup directory is not configured': '尚未设置备份目录',
  'Backup operation failed': '备份操作失败',
  'Invalid company payload': '公司资料格式不正确',
  'Invalid contact payload': '联系人资料格式不正确',
  'Invalid identifier': '标识符无效',
  'Company not found': '未找到公司',
  'Contact not found': '未找到联系人',
  'Company is referenced by projects': '公司已被项目使用，无法删除',
  'Company operation failed': '公司操作失败',
  'Contact operation failed': '联系人操作失败',
  'Company name already exists': '公司名称已存在',
  'Invalid project payload': '项目资料格式不正确',
  'Invalid archive payload': '归档资料格式不正确',
  'Invalid project status': '项目状态筛选无效',
  'Invalid project code': '项目编号无效',
  'Project not found': '未找到项目',
  'Project code already exists': '项目编号已存在',
  'Project operation failed': '项目操作失败',
}

const knownErrorCodeMessages: Record<string, string> = {
  REVISION_CONFLICT: '数据已被其他操作修改，请刷新后重试',
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly fieldErrors?: unknown,
    readonly currentRevision?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function sendRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
  }

  const headers = normalizeHeaders(options.headers)
  if (options.body !== undefined) {
    if (options.body instanceof FormData || options.body instanceof Blob) {
      init.body = options.body
    } else {
      if (!hasHeader(headers, 'Content-Type')) headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
  }
  if (Object.keys(headers).length > 0) init.headers = headers

  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('无法连接本地服务，请确认服务仍在运行', 0)
  }

  if (!response.ok) {
    throw await responseError(response)
  }
  return response
}

async function responseError(response: Response): Promise<ApiError> {
  try {
    const payload: unknown = await response.json()
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'detail' in payload &&
      typeof payload.detail === 'string'
    ) {
      const structured = payload as Partial<ApiErrorPayload>
      const errorCode = typeof structured.error_code === 'string' ? structured.error_code : undefined
      return new ApiError(
        (errorCode ? knownErrorCodeMessages[errorCode] : undefined)
          ?? knownErrorMessages[payload.detail]
          ?? payload.detail,
        response.status,
        errorCode,
        structured.field_errors,
        typeof structured.current_revision === 'number' ? structured.current_revision : undefined,
      )
    }
  } catch {
    // FastAPI 之外的代理错误没有 JSON detail，统一使用状态码提示。
  }
  return new ApiError(`请求失败（${response.status}）`, response.status)
}

export async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await sendRequest(path, options)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function requestVoid(
  path: string,
  options: RequestOptions = {},
): Promise<void> {
  await sendRequest(path, options)
}

function requestPlannedPostJson<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body,
  })
}

export interface PlannedPostRequest<T> {
  readonly idempotencyKey: string
  send(): Promise<T>
}

export function createPlannedPostRequest<T>(
  path: string,
  body: unknown,
  idempotencyKey = crypto.randomUUID(),
): PlannedPostRequest<T> {
  return {
    idempotencyKey,
    send: () => requestPlannedPostJson<T>(path, body, idempotencyKey),
  }
}

export async function requestBlob(
  path: string,
  options: RequestOptions = {},
): Promise<Blob> {
  const response = await sendRequest(path, options)
  return response.blob()
}

export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

function normalizeHeaders(input?: HeadersInit): Record<string, string> {
  if (!input) return {}
  const entries = input instanceof Headers
    ? [...input.entries()]
    : Array.isArray(input)
      ? input
      : Object.entries(input)
  const normalized: Record<string, string> = {}
  const actualNames = new Map<string, string>()
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    const previousName = actualNames.get(key)
    if (previousName) delete normalized[previousName]
    actualNames.set(key, name)
    normalized[name] = value
  }
  return normalized
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === expected)
}
