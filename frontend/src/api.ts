export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: HeadersInit
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

import type { ApiErrorPayload } from './domain/contracts'

export type { ApiErrorPayload } from './domain/contracts'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface ProtectedSessionExpiredNotice {
  readonly message: string
  readonly path: string
}

interface ProtectedSessionObserver {
  active: boolean
  readonly notify: (notice: ProtectedSessionExpiredNotice) => void
}

let protectedSessionObserver: ProtectedSessionObserver | null = null

export function subscribeProtectedSessionExpired(
  notify: (notice: ProtectedSessionExpiredNotice) => void,
): () => void {
  if (protectedSessionObserver) protectedSessionObserver.active = false
  const observer: ProtectedSessionObserver = { active: true, notify }
  protectedSessionObserver = observer
  return () => {
    observer.active = false
    if (protectedSessionObserver === observer) protectedSessionObserver = null
  }
}

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
  const sessionObserver = protectedSessionObserver
  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: controller.signal,
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
    if (timedOut) throw new ApiError('请求超时，请重试', 0, 'REQUEST_TIMEOUT')
    if (options.signal?.aborted) throw new ApiError('请求已取消', 0, 'REQUEST_ABORTED')
    throw new ApiError('无法连接本地服务，请确认服务仍在运行', 0)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }

  if (!response.ok) {
    const error = await responseError(response)
    if (
      response.status === 401
      && isProtectedApiPath(path)
      && sessionObserver?.active
    ) {
      sessionObserver.notify({ message: error.message, path })
    }
    throw error
  }
  return response
}

function isProtectedApiPath(path: string): boolean {
  const pathname = path.split('?', 1)[0]
  return pathname.startsWith('/api/') && ![
    '/api/auth/session',
    '/api/auth/setup',
    '/api/auth/login',
  ].includes(pathname)
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

export interface RetriablePostSender {
  send<T>(path: string, body: unknown): Promise<T>
  discard(path: string, body?: unknown): boolean
}

export interface RetriableMultipartPostSender {
  send<T>(path: string, payload: unknown, files: readonly File[], form?: FormData): Promise<T>
  discard(path: string, payload?: unknown, files?: readonly File[]): boolean
}

interface PendingPost {
  readonly signature: string
  readonly idempotencyKey: string
  inFlight?: Promise<unknown>
}

export function createRetriablePostSender(): RetriablePostSender {
  const pendingByPath = new Map<string, PendingPost>()

  return {
    send<T>(path: string, body: unknown): Promise<T> {
      let signature: string
      try {
        signature = stableJsonSignature(body)
      } catch (error) {
        return Promise.reject(error)
      }
      let pending = pendingByPath.get(path)

      if (pending?.inFlight) {
        if (pending.signature === signature) return pending.inFlight as Promise<T>
        return Promise.reject(new Error('该路径已有其他请求正在提交'))
      }

      if (pending && pending.signature !== signature) {
        return Promise.reject(new Error('上一笔请求结果未知，只能原样重试或先明确放弃'))
      }

      if (!pending) {
        pending = {
          signature,
          idempotencyKey: crypto.randomUUID(),
        }
        pendingByPath.set(path, pending)
      }

      const activePending = pending
      const inFlight = requestPlannedPostJson<T>(path, body, activePending.idempotencyKey).then(
        (result) => {
          if (pendingByPath.get(path) === activePending) pendingByPath.delete(path)
          return result
        },
        (error: unknown) => {
          if (pendingByPath.get(path) === activePending) {
            activePending.inFlight = undefined
            if (isDefinitiveClientRejection(error)) pendingByPath.delete(path)
          }
          throw error
        },
      )
      activePending.inFlight = inFlight
      return inFlight
    },
    discard(path: string, body?: unknown): boolean {
      const pending = pendingByPath.get(path)
      if (!pending || pending.inFlight) return false
      if (body !== undefined && pending.signature !== stableJsonSignature(body)) return false
      return pendingByPath.delete(path)
    },
  }
}

export function createRetriableMultipartPostSender(): RetriableMultipartPostSender {
  const pendingByPath = new Map<string, PendingPost>()
  const fileTokens = new WeakMap<File, number>()
  let nextFileToken = 1

  const signatureFor = (payload: unknown, files: readonly File[]): string => multipartSignature(
    payload,
    files,
    (file) => {
      const existing = fileTokens.get(file)
      if (existing !== undefined) return existing
      const token = nextFileToken
      nextFileToken += 1
      fileTokens.set(file, token)
      return token
    },
  )

  return {
    send<T>(path: string, payload: unknown, files: readonly File[], suppliedForm?: FormData): Promise<T> {
      let signature: string
      try {
        signature = signatureFor(payload, files)
      } catch (error) {
        return Promise.reject(error)
      }
      let pending = pendingByPath.get(path)

      if (pending?.inFlight) {
        if (pending.signature === signature) return pending.inFlight as Promise<T>
        return Promise.reject(new Error('该路径已有其他文件正在上传'))
      }

      if (pending && pending.signature !== signature) {
        return Promise.reject(new Error('上一笔上传结果未知，只能原样重试或先明确放弃'))
      }

      if (!pending) {
        pending = { signature, idempotencyKey: crypto.randomUUID() }
        pendingByPath.set(path, pending)
      }

      const form = suppliedForm ?? businessAttachmentForm(payload, files)
      const activePending = pending
      const inFlight = requestJson<T>(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': activePending.idempotencyKey },
        body: form,
      }).then(
        (result) => {
          if (pendingByPath.get(path) === activePending) pendingByPath.delete(path)
          return result
        },
        (error: unknown) => {
          if (pendingByPath.get(path) === activePending) {
            activePending.inFlight = undefined
            if (isDefinitiveClientRejection(error)) pendingByPath.delete(path)
          }
          throw error
        },
      )
      activePending.inFlight = inFlight
      return inFlight
    },
    discard(path: string, payload?: unknown, files: readonly File[] = []): boolean {
      const pending = pendingByPath.get(path)
      if (!pending || pending.inFlight) return false
      if (payload !== undefined && pending.signature !== signatureFor(payload, files)) return false
      return pendingByPath.delete(path)
    },
  }
}

function businessAttachmentForm(payload: unknown, files: readonly File[]): FormData {
  const form = new FormData()
  form.set('payload', JSON.stringify(payload))
  for (const file of files) form.append('files', file, file.name)
  return form
}

function multipartSignature(
  payload: unknown,
  files: readonly File[],
  identityToken: (file: File) => number,
): string {
  return stableJsonSignature({
    payload,
    files: files.map((file) => ({
      identity: identityToken(file),
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
  })
}

function isDefinitiveClientRejection(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

function stableJsonSignature(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (Number.isFinite(value)) return JSON.stringify(value)
      break
    case 'object': {
      if (ancestors.has(value)) break
      ancestors.add(value)
      try {
        const ownKeys = Reflect.ownKeys(value)
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Array.isArray(value)) {
          if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
            break
          }
          const items: string[] = []
          for (let index = 0; index < value.length; index += 1) {
            items.push(stableJsonSignature(jsonDataPropertyValue(descriptors[String(index)]), ancestors))
          }
          return `[${items.join(',')}]`
        }

        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) break

        const entries = ownKeys.map((key) => {
          if (typeof key !== 'string') return invalidJsonBody()
          return [key, jsonDataPropertyValue(descriptors[key])] as const
        })
        return `{${entries
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonSignature(item, ancestors)}`)
          .join(',')}}`
      } finally {
        ancestors.delete(value)
      }
    }
  }

  return invalidJsonBody()
}

function jsonDataPropertyValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (!descriptor?.enumerable || !('value' in descriptor)) return invalidJsonBody()
  return descriptor.value
}

function invalidJsonBody(): never {
  throw new TypeError('POST 请求体必须是无循环引用的 JSON 兼容值')
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
