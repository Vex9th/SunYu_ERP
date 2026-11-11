import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlannedPostRequest, createRetriableMultipartPostSender, createRetriablePostSender } from '../api'
import { prepareCompanyCreate, prepareContactCreate, parsePendingCreate } from '../react/companyWrites'
import { createUuid } from '../uuid'

const originalCrypto = globalThis.crypto
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const company = { name: '局域网测试公司', taxpayer_id: null, registered_address: null, registered_phone: null, bank_name: null, bank_account: null, notes: null }

describe('局域网 HTTP 没有 randomUUID 时的提交身份', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('预先计划的提交可重复发送同一个有效 UUID', async () => {
    const keys: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_path, options) => {
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!)
      return new Response('{"id":1}', { status: 201 })
    }))
    const request = createPlannedPostRequest('/api/companies', company)
    await expect(request.send()).resolves.toEqual({ id: 1 })
    await request.send()
    expect(keys[0]).toMatch(uuidV4)
    expect(keys).toEqual([request.idempotencyKey, request.idempotencyKey])
  })

  it.each(['json', 'multipart'])('%s 断网重试沿用原身份，成功后下一笔使用新身份', async kind => {
    const keys: string[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_path, options) => {
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!)
      if (keys.length === 1) throw new TypeError('connection lost')
      return new Response('{"id":2}', { status: 201 })
    }))
    const sender = createRetriablePostSender()
    const uploader = createRetriableMultipartPostSender()
    const files = [new File(['invoice'], 'invoice.txt')]
    const send = () => kind === 'json'
      ? sender.send('/api/projects/P/procurement-lists', { name: '新清单', notes: null })
      : uploader.send('/api/projects/P/invoices', { invoice_no: 'INV-HTTP' }, files)
    await expect(send()).rejects.toThrow('无法连接本地服务')
    await expect(send()).resolves.toEqual({ id: 2 })
    await expect(send()).resolves.toEqual({ id: 2 })
    expect(keys).toHaveLength(3)
    keys.forEach(key => expect(key).toMatch(uuidV4))
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
  })

  it('公司和联系人创建凭据可以持久化并恢复', () => {
    const first = prepareCompanyCreate(company)
    const second = prepareContactCreate(1, { name: '采购员', position: null, phone: null, email: null, notes: null })
    expect(first.idempotencyKey).toMatch(uuidV4)
    expect(second.idempotencyKey).toMatch(uuidV4)
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
    expect(parsePendingCreate(JSON.parse(JSON.stringify(first)))).toEqual(first)
    expect(parsePendingCreate(JSON.parse(JSON.stringify(second)), 1)).toEqual(second)
  })

  it.each([
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ] as const)('随机字节 %s 的版本位和变体位符合 UUID v4', (byte, expected) => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(byte) })
    expect(createUuid()).toBe(expected)
  })
})
