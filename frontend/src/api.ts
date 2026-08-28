interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
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
      return new ApiError(knownErrorMessages[payload.detail] ?? payload.detail, response.status)
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
