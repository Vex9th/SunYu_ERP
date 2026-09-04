import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CompanyCenter from '../components/CompanyCenter.vue'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

const company = {
  id: 1,
  name: '甲公司',
  taxpayer_id: null,
  registered_address: null,
  registered_phone: '0512-10000',
  bank_name: null,
  bank_account: null,
  notes: null,
  revision: 3,
  created_at: '2026-09-01T00:00:00+00:00',
  updated_at: '2026-09-01T00:00:00+00:00',
}

const contact = {
  id: 11,
  company_id: 1,
  name: '王工',
  phone: '13800138000',
  email: null,
  position: '负责人',
  notes: null,
  revision: 5,
  created_at: '2026-09-01T00:00:00+00:00',
  updated_at: '2026-09-01T00:00:00+00:00',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function emptyResponse(): Response {
  return new Response(null, { status: 204 })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountCenter(): VueWrapper {
  return mount(CompanyCenter, {
    attachTo: document.body,
    global: { plugins: [ElementPlus] },
  })
}

async function openCompanyMenuItem(
  wrapper: VueWrapper,
  item: 'edit' | 'delete',
): Promise<void> {
  await wrapper.get('[data-testid="company-more-1"]').trigger('click')
  await settle()
  const element = document.body.querySelector<HTMLElement>(
    `[data-testid="company-${item}-1"]`,
  )
  if (!element) throw new Error(`company ${item} menu item missing`)
  element.click()
  await settle()
}

describe('CompanyCenter write safety', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('公司创建结果未知时锁定原表单并用同一幂等键原样重试', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') {
        return jsonResponse([{ ...company, contact_count: 0 }])
      }
      if (path === '/api/companies' && method === 'POST') {
        const attempts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
        if (attempts.length === 1) throw new TypeError('response lost')
        return jsonResponse({ ...company, id: 2, name: '新公司', revision: 1, contacts: [] }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('新公司')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="company-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="company-name"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(new Headers(posts[0]?.[1]?.headers).get('Idempotency-Key')).toBeTruthy()
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(posts[0]?.[1]?.headers).get('Idempotency-Key'),
    )
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body)
  })

  it('公司旧表单冲突后保留填写内容、展示服务端最新值并以新 revision 重试', async () => {
    let updateAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') {
        return jsonResponse([{ ...company, contact_count: 0 }])
      }
      if (path === '/api/companies/1' && method === 'PUT') {
        updateAttempts += 1
        if (updateAttempts === 1) {
          return jsonResponse({
            detail: 'Resource was modified',
            error_code: 'REVISION_CONFLICT',
            field_errors: {},
            current_revision: 4,
          }, 409)
        }
        return jsonResponse({ ...company, name: '我的修改', revision: 5, contacts: [] })
      }
      if (path === '/api/companies/1' && method === 'GET') {
        return jsonResponse({
          ...company,
          name: '服务端新名称',
          taxpayer_id: '91320000SERVER',
          registered_address: '服务器注册地址',
          registered_phone: '0512-99999',
          bank_name: '服务器银行',
          bank_account: 'SERVER-ACCOUNT',
          notes: '服务器备注',
          revision: 4,
          contacts: [],
        })
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await openCompanyMenuItem(wrapper, 'edit')
    await wrapper.get('[data-testid="company-name"]').setValue('我的修改')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect((wrapper.get('[data-testid="company-name"]').element as HTMLInputElement).value).toBe('我的修改')
    const comparison = wrapper.get('[data-testid="company-conflict-latest"]')
    for (const field of [
      'name',
      'taxpayer_id',
      'registered_address',
      'registered_phone',
      'bank_name',
      'bank_account',
      'notes',
    ]) {
      expect(comparison.find(`[data-testid="company-conflict-field-${field}"]`).exists()).toBe(true)
    }
    expect(comparison.text()).toContain('服务端新名称')
    expect(comparison.text()).toContain('SERVER-ACCOUNT')
    expect(comparison.get('[data-testid="company-conflict-field-name"]').classes()).toContain('is-different')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()
    const puts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(String(puts[0]?.[1]?.body)).expected_revision).toBe(3)
    expect(JSON.parse(String(puts[1]?.[1]?.body)).expected_revision).toBe(4)
  })

  it('联系人编辑冲突保留填写内容并刷新当前联系人 revision', async () => {
    let updateAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (path === '/api/companies/1' && method === 'GET') {
        return jsonResponse({
          ...company,
          contacts: [{
            ...contact,
            name: updateAttempts ? '服务端王工' : contact.name,
            phone: updateAttempts ? '13900000000' : contact.phone,
            email: updateAttempts ? 'server@example.com' : contact.email,
            position: updateAttempts ? '服务器负责人' : contact.position,
            notes: updateAttempts ? '服务器联系人备注' : contact.notes,
            revision: updateAttempts ? 6 : 5,
          }],
        })
      }
      if (path === '/api/companies/1/contacts/11' && method === 'PUT') {
        updateAttempts += 1
        if (updateAttempts === 1) {
          return jsonResponse({
            detail: 'Resource was modified', error_code: 'REVISION_CONFLICT',
            field_errors: {}, current_revision: 6,
          }, 409)
        }
        return jsonResponse({ ...contact, name: '我的王工', revision: 7 })
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-edit-11"]').trigger('click')
    await wrapper.get('[data-testid="contact-name"]').setValue('我的王工')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    expect((wrapper.get('[data-testid="contact-name"]').element as HTMLInputElement).value).toBe('我的王工')
    const comparison = wrapper.get('[data-testid="contact-conflict-latest"]')
    for (const field of ['name', 'phone', 'email', 'position', 'notes']) {
      expect(comparison.find(`[data-testid="contact-conflict-field-${field}"]`).exists()).toBe(true)
    }
    expect(comparison.text()).toContain('server@example.com')
    expect(comparison.get('[data-testid="contact-conflict-field-name"]').classes()).toContain('is-different')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    const puts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(String(puts[0]?.[1]?.body)).expected_revision).toBe(5)
    expect(JSON.parse(String(puts[1]?.[1]?.body)).expected_revision).toBe(6)
  })

  it('联系人创建也使用可安全重放的幂等键', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 0 }])
      if (path === '/api/companies/1' && method === 'GET') return jsonResponse({ ...company, contacts: [] })
      if (path === '/api/companies/1/contacts' && method === 'POST') {
        const attempts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
        if (attempts.length === 1) throw new TypeError('response lost')
        return jsonResponse({ ...contact, id: 12, name: '新联系人', revision: 1 }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-create-open"]').trigger('click')
    await wrapper.get('[data-testid="contact-name"]').setValue('新联系人')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="contact-create-uncertain"]').text()).toContain('原样重试')
    expect(wrapper.get('[data-testid="contact-name"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(new Headers(posts[0]?.[1]?.headers).get('Idempotency-Key')).toBeTruthy()
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(
      new Headers(posts[0]?.[1]?.headers).get('Idempotency-Key'),
    )
    expect(posts[1]?.[1]?.body).toBe(posts[0]?.[1]?.body)
  })

  it('删除公司和联系人都携带当前 revision', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (path === '/api/companies/1' && method === 'GET') return jsonResponse({ ...company, contacts: [contact] })
      if (method === 'DELETE') return emptyResponse()
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await openCompanyMenuItem(wrapper, 'delete')
    await wrapper.get('[data-testid="company-delete-confirm"]').trigger('click')
    await settle()

    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-delete-11"]').trigger('click')
    await wrapper.get('[data-testid="contact-delete-confirm"]').trigger('click')
    await settle()

    const deletes = fetchMock.mock.calls.filter(([, options]) => options?.method === 'DELETE')
    expect(JSON.parse(String(deletes[0]?.[1]?.body))).toEqual({ expected_revision: 3 })
    expect(JSON.parse(String(deletes[1]?.[1]?.body))).toEqual({ expected_revision: 5 })
  })

  it('公司冲突后的最新值读取失败时锁定保存，重新读取成功后才允许覆盖', async () => {
    let latestReads = 0
    let updates = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 0 }])
      if (path === '/api/companies/1' && method === 'PUT') {
        updates += 1
        if (updates === 1) {
          return jsonResponse({
            detail: 'Resource was modified', error_code: 'REVISION_CONFLICT',
            field_errors: {}, current_revision: 4,
          }, 409)
        }
        return jsonResponse({ ...company, name: '保留的公司草稿', revision: 5, contacts: [] })
      }
      if (path === '/api/companies/1' && method === 'GET') {
        latestReads += 1
        if (latestReads === 1) throw new TypeError('latest read failed')
        return jsonResponse({ ...company, name: '服务器公司', revision: 4, contacts: [] })
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await openCompanyMenuItem(wrapper, 'edit')
    await wrapper.get('[data-testid="company-name"]').setValue('保留的公司草稿')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="company-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="company-conflict-retry"]').text()).toContain('重新读取最新值')
    expect((wrapper.get('[data-testid="company-name"]').element as HTMLInputElement).value).toBe('保留的公司草稿')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    expect(updates).toBe(1)

    await wrapper.get('[data-testid="company-conflict-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-conflict-latest"]').text()).toContain('服务器公司')
    expect(wrapper.get('[data-testid="company-save"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()
    expect(updates).toBe(2)
  })

  it('联系人冲突后的最新值读取失败时锁定保存，重新读取成功后才允许覆盖', async () => {
    let detailReads = 0
    let updates = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (path === '/api/companies/1' && method === 'GET') {
        detailReads += 1
        if (detailReads === 2) throw new TypeError('latest read failed')
        return jsonResponse({
          ...company,
          contacts: [{ ...contact, name: detailReads >= 3 ? '服务器联系人' : contact.name, revision: detailReads >= 3 ? 6 : 5 }],
        })
      }
      if (path === '/api/companies/1/contacts/11' && method === 'PUT') {
        updates += 1
        if (updates === 1) {
          return jsonResponse({
            detail: 'Resource was modified', error_code: 'REVISION_CONFLICT',
            field_errors: {}, current_revision: 6,
          }, 409)
        }
        return jsonResponse({ ...contact, name: '保留的联系人草稿', revision: 7 })
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-edit-11"]').trigger('click')
    await wrapper.get('[data-testid="contact-name"]').setValue('保留的联系人草稿')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="contact-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="contact-conflict-retry"]').text()).toContain('重新读取最新值')
    expect((wrapper.get('[data-testid="contact-name"]').element as HTMLInputElement).value).toBe('保留的联系人草稿')
    await wrapper.get('[data-testid="contact-save"]').trigger('click')
    expect(updates).toBe(1)

    await wrapper.get('[data-testid="contact-conflict-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="contact-conflict-latest"]').text()).toContain('服务器联系人')
    expect(wrapper.get('[data-testid="contact-save"]').attributes('disabled')).toBeUndefined()
  })

  it('公司删除冲突读取失败时只允许重新读取，成功后才能再次删除', async () => {
    let latestReads = 0
    let deletes = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 0 }])
      if (path === '/api/companies/1' && method === 'DELETE') {
        deletes += 1
        if (deletes === 1) {
          return jsonResponse({
            detail: 'Resource was modified', error_code: 'REVISION_CONFLICT',
            field_errors: {}, current_revision: 4,
          }, 409)
        }
        return emptyResponse()
      }
      if (path === '/api/companies/1' && method === 'GET') {
        latestReads += 1
        if (latestReads === 1) throw new TypeError('latest read failed')
        return jsonResponse({ ...company, name: '服务器公司', revision: 4, contacts: [] })
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await openCompanyMenuItem(wrapper, 'delete')
    await wrapper.get('[data-testid="company-delete-confirm"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="company-delete-confirm"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="company-delete-confirm"]').trigger('click')
    expect(deletes).toBe(1)
    await wrapper.get('[data-testid="company-delete-conflict-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="company-delete-confirm"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="company-delete-confirm"]').trigger('click')
    await settle()
    expect(deletes).toBe(2)
  })

  it('联系人删除冲突读取失败时只允许重新读取，成功后才能再次删除', async () => {
    let detailReads = 0
    let deletes = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (path === '/api/companies/1' && method === 'GET') {
        detailReads += 1
        if (detailReads === 2) throw new TypeError('latest read failed')
        return jsonResponse({
          ...company,
          contacts: [{ ...contact, revision: detailReads >= 3 ? 6 : 5 }],
        })
      }
      if (path === '/api/companies/1/contacts/11' && method === 'DELETE') {
        deletes += 1
        if (deletes === 1) {
          return jsonResponse({
            detail: 'Resource was modified', error_code: 'REVISION_CONFLICT',
            field_errors: {}, current_revision: 6,
          }, 409)
        }
        return emptyResponse()
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="contact-delete-11"]').trigger('click')
    await wrapper.get('[data-testid="contact-delete-confirm"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="contact-delete-confirm"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="contact-delete-confirm"]').trigger('click')
    expect(deletes).toBe(1)
    await wrapper.get('[data-testid="contact-delete-conflict-retry"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="contact-delete-confirm"]').attributes('disabled')).toBeUndefined()
  })

  it('公司未知创建在刷新后恢复原路径、内容和幂等键并原样重试', async () => {
    let postAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 0 }])
      if (path === '/api/companies' && method === 'POST') {
        postAttempts += 1
        if (postAttempts === 1) throw new TypeError('response lost')
        return jsonResponse({ ...company, id: 2, name: '刷新后公司', revision: 1, contacts: [] }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const first = mountCenter()
    await settle()
    await first.get('[data-testid="company-create-open"]').trigger('click')
    await first.get('[data-testid="company-name"]').setValue('刷新后公司')
    await first.get('[data-testid="company-taxpayer-id"]').setValue('91320000RETRY')
    await first.get('[data-testid="company-save"]').trigger('click')
    await settle()

    const stored = JSON.parse(String(sessionStorage.getItem('sunyu-erp:pending-create:company')))
    expect(stored).toMatchObject({
      path: '/api/companies',
      payload: { name: '刷新后公司', taxpayer_id: '91320000RETRY' },
      uncertain: true,
    })
    expect(stored.idempotencyKey).toBeTruthy()
    const firstPost = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
    first.unmount()

    const second = mountCenter()
    await settle()
    expect(second.find('[data-testid="company-create-uncertain"]').exists()).toBe(true)
    expect((second.get('[data-testid="company-name"]').element as HTMLInputElement).value).toBe('刷新后公司')
    await second.get('[data-testid="company-save"]').trigger('click')
    await settle()

    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]?.[1]?.body).toBe(firstPost?.[1]?.body)
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(stored.idempotencyKey)
    expect(sessionStorage.getItem('sunyu-erp:pending-create:company')).toBeNull()
  })

  it('公司创建收到 201 但响应无法解析时保留原幂等键', async () => {
    let postAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([])
      if (path === '/api/companies' && method === 'POST') {
        postAttempts += 1
        if (postAttempts === 1) return new Response('not-json', { status: 201 })
        return jsonResponse({ ...company, id: 2, name: '响应丢失公司', revision: 1, contacts: [] }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const first = mountCenter()
    await settle()
    await first.get('[data-testid="company-create-open"]').trigger('click')
    await first.get('[data-testid="company-name"]').setValue('响应丢失公司')
    await first.get('[data-testid="company-save"]').trigger('click')
    await settle()
    const stored = JSON.parse(String(sessionStorage.getItem('sunyu-erp:pending-create:company')))
    const firstPost = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(stored.idempotencyKey).toBeTruthy()
    expect(first.find('[data-testid="company-create-uncertain"]').exists()).toBe(true)
    first.unmount()

    const second = mountCenter()
    await settle()
    await second.get('[data-testid="company-save"]').trigger('click')
    await settle()
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]?.[1]?.body).toBe(firstPost?.[1]?.body)
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(stored.idempotencyKey)
  })

  it('联系人未知创建按公司隔离保存，刷新后恢复原请求并原样重试', async () => {
    let postAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 1 }])
      if (path === '/api/companies/1' && method === 'GET') return jsonResponse({ ...company, contacts: [contact] })
      if (path === '/api/companies/1/contacts' && method === 'POST') {
        postAttempts += 1
        if (postAttempts === 1) throw new TypeError('response lost')
        return jsonResponse({ ...contact, id: 12, name: '刷新后联系人', revision: 1 }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const first = mountCenter()
    await settle()
    await first.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await first.get('[data-testid="contact-create-open"]').trigger('click')
    await first.get('[data-testid="contact-name"]').setValue('刷新后联系人')
    await first.get('[data-testid="contact-email"]').setValue('retry@example.com')
    await first.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    const storageKey = 'sunyu-erp:pending-create:contact:1'
    const stored = JSON.parse(String(sessionStorage.getItem(storageKey)))
    expect(stored).toMatchObject({
      companyId: 1,
      path: '/api/companies/1/contacts',
      payload: { name: '刷新后联系人', email: 'retry@example.com' },
      uncertain: true,
    })
    expect(stored.idempotencyKey).toBeTruthy()
    const firstPost = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
    first.unmount()

    const second = mountCenter()
    await settle()
    expect(second.find('[data-testid="contact-create-uncertain"]').exists()).toBe(true)
    expect((second.get('[data-testid="contact-name"]').element as HTMLInputElement).value).toBe('刷新后联系人')
    await second.get('[data-testid="contact-save"]').trigger('click')
    await settle()

    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]?.[1]?.body).toBe(firstPost?.[1]?.body)
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(stored.idempotencyKey)
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  })

  it('联系人创建收到 201 但响应无法解析时保留原幂等键', async () => {
    let postAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([{ ...company, contact_count: 0 }])
      if (path === '/api/companies/1' && method === 'GET') return jsonResponse({ ...company, contacts: [] })
      if (path === '/api/companies/1/contacts' && method === 'POST') {
        postAttempts += 1
        if (postAttempts === 1) return new Response('not-json', { status: 201 })
        return jsonResponse({ ...contact, id: 12, name: '响应丢失联系人', revision: 1 }, 201)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const first = mountCenter()
    await settle()
    await first.get('[data-testid="company-detail-1"]').trigger('click')
    await settle()
    await first.get('[data-testid="contact-create-open"]').trigger('click')
    await first.get('[data-testid="contact-name"]').setValue('响应丢失联系人')
    await first.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    const storageKey = 'sunyu-erp:pending-create:contact:1'
    const stored = JSON.parse(String(sessionStorage.getItem(storageKey)))
    const firstPost = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(stored.idempotencyKey).toBeTruthy()
    expect(first.find('[data-testid="contact-create-uncertain"]').exists()).toBe(true)
    first.unmount()

    const second = mountCenter()
    await settle()
    await second.get('[data-testid="contact-save"]').trigger('click')
    await settle()
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]?.[1]?.body).toBe(firstPost?.[1]?.body)
    expect(new Headers(posts[1]?.[1]?.headers).get('Idempotency-Key')).toBe(stored.idempotencyKey)
  })

  it('确定性创建失败会清除已保存的重试凭据', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/api/companies' && method === 'GET') return jsonResponse([])
      if (path === '/api/companies' && method === 'POST') {
        return jsonResponse({ detail: 'Invalid company payload' }, 422)
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const wrapper = mountCenter()
    await settle()
    await wrapper.get('[data-testid="company-create-open"]').trigger('click')
    await wrapper.get('[data-testid="company-name"]').setValue('确定失败公司')
    await wrapper.get('[data-testid="company-save"]').trigger('click')
    await settle()

    expect(sessionStorage.getItem('sunyu-erp:pending-create:company')).toBeNull()
    expect(wrapper.find('[data-testid="company-create-uncertain"]').exists()).toBe(false)
  })
})
