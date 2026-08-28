interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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

  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }

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
      return new ApiError(payload.detail, response.status)
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
  return (await response.json()) as T
}

export async function requestVoid(
  path: string,
  options: RequestOptions = {},
): Promise<void> {
  await sendRequest(path, options)
}
