import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import CompaniesPage from '../CompaniesPage'
import {
  clearPendingCreate,
  COMPANY_PENDING_KEY,
  CONTACT_PENDING_PREFIX,
  listPendingCreates,
  parsePendingCreate,
  readPendingCreate,
} from '../companyWrites'
import { installProjectDom } from './project-fixtures'
import type {
  CompanyDetail,
  CompanyPayload,
  CompanySummary,
  ContactPayload,
  RevisionedContact,
} from '../../types'

beforeAll(installProjectDom)
const companyPayload: CompanyPayload = {
  name: '测试公司',
  taxpayer_id: 'TAX1',
  registered_address: '原地址',
  registered_phone: '02112345678',
  bank_name: '银行甲',
  bank_account: 'BANK1',
  notes: null,
}
const contactPayload: ContactPayload = {
  name: '王工',
  position: '工程师',
  phone: '13800000000',
  email: null,
  notes: null,
}
const contact: RevisionedContact = {
  ...contactPayload,
  id: 11,
  company_id: 1,
  revision: 3,
  created_at: '',
  updated_at: '',
}
const company: CompanyDetail = {
  ...companyPayload,
  id: 1,
  revision: 2,
  contacts: [contact],
  created_at: '',
  updated_at: '',
}
const summary: CompanySummary = { ...company, contact_count: 1 }
const idempotencyKey = '432f6abe-e8f2-434a-8c18-ceefddfe0b70'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const conflict = () =>
  json(
    {
      detail: '资料已变化',
      error_code: 'REVISION_CONFLICT',
      current_revision: 4,
    },
    409,
  )
function mount() {
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}>
      <App>
        <CompaniesPage />
      </App>
    </ConfigProvider>,
  )
}
function requests(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  method: string,
) {
  return fetchMock.mock.calls.filter(
    ([, options]) => options?.method === method,
  )
}
beforeEach(() => {
  for (const pending of listPendingCreates())
    clearPendingCreate(pending.companyId)
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  for (const pending of listPendingCreates())
    clearPendingCreate(pending.companyId)
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('公司与联系人创建恢复', () => {
  it('恢复已持久化联系人原请求，固定公司与幂等键，不自动提交', async () => {
    sessionStorage.setItem(
      `${CONTACT_PENDING_PREFIX}2`,
      JSON.stringify({
        companyId: 2,
        path: '/api/companies/2/contacts',
        payload: contactPayload,
        idempotencyKey,
        uncertain: true,
      }),
    )
    const fetchMock = vi.fn<typeof fetch>(async (_path, options) =>
      options?.method === 'POST'
        ? json({ ...contact, company_id: 2 }, 201)
        : json([summary]),
    )
    vi.stubGlobal('fetch', fetchMock)
    mount()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('姓名').getAttribute('value')).toBe(
      '王工',
    )
    expect(
      (within(dialog).getByLabelText('姓名') as HTMLInputElement).disabled,
    ).toBe(true)
    expect(requests(fetchMock, 'POST')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '原样重试' }))
    await waitFor(() => expect(requests(fetchMock, 'POST')).toHaveLength(1))
    const [path, options] = requests(fetchMock, 'POST')[0]
    expect(path).toBe('/api/companies/2/contacts')
    expect(new Headers(options?.headers).get('Idempotency-Key')).toBe(
      idempotencyKey,
    )
    expect(JSON.parse(String(options?.body))).toEqual(contactPayload)
    await waitFor(() =>
      expect(sessionStorage.getItem(`${CONTACT_PENDING_PREFIX}2`)).toBeNull(),
    )
  })
  it('未知结果先持久化原内容，重新挂载后原样重试不会产生新幂等键', async () => {
    let posts = 0
    const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'POST') {
        posts += 1
        if (posts === 1) throw new TypeError('network failed')
        return json(company, 201)
      }
      return json(String(path).endsWith('/1') ? company : [summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = mount()
    await screen.findByText('测试公司')
    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('公司名称'), {
      target: { value: '新公司' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByText('创建结果尚未确认，原请求已保留')
    const stored = JSON.parse(sessionStorage.getItem(COMPANY_PENDING_KEY)!)
    expect(stored.payload.name).toBe('新公司')
    expect(
      (within(dialog).getByLabelText('公司名称') as HTMLInputElement).disabled,
    ).toBe(true)
    view.unmount()
    mount()
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '原样重试' }))
    await waitFor(() => expect(requests(fetchMock, 'POST')).toHaveLength(2))
    const first = requests(fetchMock, 'POST')[0][1]
    const second = requests(fetchMock, 'POST')[1][1]
    expect(second?.body).toBe(first?.body)
    expect(new Headers(second?.headers).get('Idempotency-Key')).toBe(
      new Headers(first?.headers).get('Idempotency-Key'),
    )
    await waitFor(() =>
      expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).toBeNull(),
    )
  })
  it('显式放弃先确认；取消确认不会移除原请求', async () => {
    sessionStorage.setItem(
      COMPANY_PENDING_KEY,
      JSON.stringify({
        path: '/api/companies',
        payload: companyPayload,
        idempotencyKey,
        uncertain: true,
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([summary])),
    )
    mount()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃原请求' }))
    expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).not.toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '保留原请求' }))
    expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃原请求' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '放弃并继续修改' }),
    )
    await waitFor(() =>
      expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).toBeNull(),
    )
    expect(
      (within(dialog).getByLabelText('公司名称') as HTMLInputElement).disabled,
    ).toBe(false)
  })

  it('会话存储不可写时明确提示不能刷新，同时保留本页原请求', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('disabled', 'SecurityError')
    })
    const fetchMock = vi.fn<typeof fetch>(async (_path, options) => {
      if (options?.method === 'POST') throw new TypeError('network failed')
      return json([summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await screen.findByText('测试公司')
    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('公司名称'), {
      target: { value: '本页保留' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByText('浏览器无法保存重试凭据，请勿刷新此页')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: '原样重试' }).className,
      ).not.toContain('loading'),
    )
    expect(readPendingCreate()?.payload.name).toBe('本页保留')
    expect(
      (within(dialog).getByLabelText('公司名称') as HTMLInputElement).disabled,
    ).toBe(true)
  })
  it('长请求离开页面后完成只清理重试凭据，不恢复旧页面或弹成功通知', async () => {
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn<typeof fetch>(async (_path, options) =>
      options?.method === 'POST'
        ? new Promise((done) => {
            resolve = done
          })
        : json([summary]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const view = mount()
    await screen.findByText('测试公司')
    fireEvent.click(screen.getByRole('button', { name: /新增公司/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('公司名称'), {
      target: { value: '迟到结果' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(requests(fetchMock, 'POST')).toHaveLength(1))
    expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).not.toBeNull()
    view.unmount()
    await act(async () => {
      resolve(json(company, 201))
    })
    await waitFor(() =>
      expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).toBeNull(),
    )
    expect(screen.queryByText('已保存')).toBeNull()
    expect(
      fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/1')),
    ).toHaveLength(0)
  })
  it('拒绝损坏 JSON、伪造路径、额外字段、非法 UUID 和串公司的联系人缓存', () => {
    const valid = {
      companyId: 2,
      path: '/api/companies/2/contacts',
      payload: contactPayload,
      idempotencyKey,
      uncertain: true,
    }
    expect(parsePendingCreate(valid, 2)).toEqual(valid)
    expect(parsePendingCreate(valid, 1)).toBeNull()
    expect(
      parsePendingCreate({ ...valid, path: '/api/companies/1/contacts' }, 2),
    ).toBeNull()
    expect(
      parsePendingCreate({ ...valid, idempotencyKey: 'forged' }, 2),
    ).toBeNull()
    expect(
      parsePendingCreate(
        { ...valid, payload: { ...contactPayload, company_id: 1 } },
        2,
      ),
    ).toBeNull()
    sessionStorage.setItem(COMPANY_PENDING_KEY, '{invalid')
    expect(readPendingCreate()).toBeNull()
    expect(sessionStorage.getItem(COMPANY_PENDING_KEY)).toBeNull()
    sessionStorage.setItem(`${CONTACT_PENDING_PREFIX}01`, JSON.stringify(valid))
    expect(listPendingCreates()).toEqual([])
    expect(sessionStorage.getItem(`${CONTACT_PENDING_PREFIX}01`)).toBeNull()
  })
})

it('没有联系人时可从公司列表直接打开该公司的新增联系人表单', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json([{...summary, contact_count:0}])))
  mount()
  fireEvent.click(await screen.findByRole('button', {name:'添加联系人'}))
  expect(await screen.findByLabelText('姓名')).toBeTruthy()
  expect(screen.getByText('新增联系人 · 测试公司')).toBeTruthy()
})

describe('公司资料版本冲突', () => {
  it('展示字段对照并保留用户草稿，明确确认后使用新 revision 保存', async () => {
    let puts = 0
    const latest = {
      ...company,
      name: '服务器公司名',
      bank_account: 'BANK2',
      revision: 4,
    }
    const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'PUT') {
        puts += 1
        return puts === 1 ? conflict() : json(latest)
      }
      return json(String(path).endsWith('/1') ? latest : [summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: '编辑公司测试公司' }),
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('公司名称'), {
      target: { value: '我的公司草稿' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByText('服务器公司名')
    expect(
      (within(dialog).getByLabelText('公司名称') as HTMLInputElement).value,
    ).toBe('我的公司草稿')
    expect(requests(fetchMock, 'PUT')).toHaveLength(1)
    fireEvent.click(
      within(dialog).getByRole('button', { name: '确认覆盖最新资料' }),
    )
    await waitFor(() => expect(requests(fetchMock, 'PUT')).toHaveLength(2))
    expect(
      JSON.parse(String(requests(fetchMock, 'PUT')[1][1]?.body)),
    ).toMatchObject({
      name: '我的公司草稿',
      bank_account: 'BANK1',
      expected_revision: 4,
    })
  })
  it('冲突后最新版本读取失败会禁止覆盖，重读成功仍须明确确认', async () => {
    let reads = 0
    const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'PUT') return conflict()
      if (String(path).endsWith('/1')) {
        reads += 1
        return reads === 1
          ? json({ detail: '服务暂不可用' }, 503)
          : json({ ...company, revision: 4 })
      }
      return json([summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: '编辑公司测试公司' }),
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('公司名称'), {
      target: { value: '保留这份草稿' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const retry = await within(dialog).findByRole('button', {
      name: '重新读取最新资料',
    })
    expect(
      (
        within(dialog).getByRole('button', {
          name: '保存',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.click(retry)
    await within(dialog).findByRole('button', { name: '确认覆盖最新资料' })
    expect(
      (within(dialog).getByLabelText('公司名称') as HTMLInputElement).value,
    ).toBe('保留这份草稿')
    expect(requests(fetchMock, 'PUT')).toHaveLength(1)
  })
  it('联系人已被其他窗口删除时保留草稿并禁止覆盖', async () => {
    let detailReads = 0
    const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'PUT') return conflict()
      if (String(path).endsWith('/1')) {
        detailReads += 1
        return json(detailReads === 1 ? company : { ...company, contacts: [] })
      }
      return json([summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '查看资料' }))
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const dialog = (await screen.findByLabelText('姓名')).closest(
      '[role="dialog"]',
    ) as HTMLElement
    fireEvent.change(within(dialog).getByLabelText('姓名'), {
      target: { value: '联系人草稿' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await within(dialog).findByText(
      '该联系人已被其他窗口删除，你填写的草稿仍保留，但不能继续覆盖。',
    )
    expect(
      (within(dialog).getByLabelText('姓名') as HTMLInputElement).value,
    ).toBe('联系人草稿')
    expect(
      (
        within(dialog).getByRole('button', {
          name: '保存',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(requests(fetchMock, 'PUT')[0][0]).toBe(
      '/api/companies/1/contacts/11',
    )
  })
  it('删除冲突展示新资料并等待第二次确认，按新版本发 DELETE', async () => {
    let deletes = 0
    let reads = 0
    const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
      if (options?.method === 'DELETE') {
        deletes += 1
        return deletes === 1 ? conflict() : new Response(null, { status: 204 })
      }
      if (String(path).endsWith('/1')) {
        reads += 1
        return json(
          reads === 1
            ? company
            : { ...company, name: '最新公司名', revision: 4 },
        )
      }
      return json([summary])
    })
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: '查看资料' }))
    fireEvent.click(await screen.findByRole('button', { name: /删除公司/ }))
    const dialog = (
      await screen.findByRole('button', { name: '确认删除' })
    ).closest('[role="dialog"]') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await within(dialog).findByRole('button', { name: '按最新版本确认删除' })
    expect(requests(fetchMock, 'DELETE')).toHaveLength(1)
    expect(within(dialog).getAllByText(/最新公司名/).length).toBeGreaterThan(0)
    fireEvent.click(
      within(dialog).getByRole('button', { name: '按最新版本确认删除' }),
    )
    await waitFor(() => expect(requests(fetchMock, 'DELETE')).toHaveLength(2))
    expect(
      JSON.parse(String(requests(fetchMock, 'DELETE')[1][1]?.body)),
    ).toEqual({ expected_revision: 4 })
  })
})
